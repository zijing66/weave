import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { createRuntimeRegistry, frameFacts, type EventSource } from '@weavecode/harness';
import { HARNESS_LIFECYCLE, isHarness } from '@weavecode/core';
import { openDatabase } from '../db/db.js';
import { HookEventRepository, type HookEventInput } from '../repositories/hook-events.js';
import { ProjectRepository, type ProjectRow } from '../repositories/projects.js';
import { SessionRepository } from '../repositories/sessions.js';
import type { HookEventBus } from './bus.js';
import type { HookDispatcher } from './dispatcher.js';
import { appendOutbox } from './mirror.js';
import type { HookReport, NormalizedHookPayload } from './types.js';
import type { WatchEngine } from './watch-engine.js';
import type { SequenceEngine } from './sequence-engine.js';
import type { MessageDeliverer } from './message-deliverer.js';
import type { QuestionTracker } from './question-tracker.js';

/**
 * inbox 消费线程（hook 文件化管道的 daemon 侧）：hook-handler.cjs 把事件追加到
 * `<dataDir>/hooks/inbox/<shard>.jsonl`（行形 `{v, token, report}`，纯传输缓冲、
 * 入库即删）；本模块在 worker_threads 里认领→入库，主线程收 postMessage 后补
 * SSE/dispatcher/outbox。
 *
 * 竞争协议（复用 spool 的 rename-claim）：rename 原子先到先得，输家 ENOENT 空手；
 * 崩在半途留下 `.claim.jsonl` 下轮先清。入库失败的行留盘重试，连续失败 parked
 * 为 `.failed.jsonl` 防毒丸热循环。行内 token 解析项目（项目已删 → 丢行，同
 * 旧 /hooks 401 语义；归档项目同样丢行——server 不消费，行即焚）；不可归因
 * 的坏行直接丢（重试无意义）。
 *
 * **shard 按项目 token 分片**（hook-handler 认 token 不认会话）⇒ 同一 claim 里
 * 常混着**同项目多个会话**的行。故凡会话级事实（inbox 凭据、pane env、改名回执）
 * 一律**逐行**取，不得按组聚合——取整组最后一个会把 A 会话的 socket 记到 B 头上，
 * 而直投照这个映射送，消息就落进别的会话（实事故，见 docs/DECISIONS.md）。
 */

export const INBOX_TICK_MS = 200;
export const INBOX_CLAIM_SUFFIX = '.claim.jsonl';
export const INBOX_FAILED_SUFFIX = '.failed.jsonl';
/** 同一 claim 连续入库失败上限：到达即 parked（防坏文件每 tick 热循环）。 */
const MAX_CLAIM_ATTEMPTS = 5;

/** worker → 主线程的入库记录（结构化克隆友好，全是 plain JSON）。 */
export interface InboxRecord {
  eventId: number;
  projectId: number;
  input: HookEventInput;
  /** hook-handler 的改名交付回执（未下发 = null）——透传 dispatcher 落定 pending。 */
  deliveredTitle?: string | null;
  /**
   * 该会话的 inbox 直投凭据（hook 进程是会话自己的 child，继承这两个 env）。
   * **逐行字段**（同 claim 里各会话的 socket 不同）；**旁路字段：不进 payload、
   * 不落库**——主线程只放内存供 layer① 直投用。
   */
  messaging?: { socket: string; token: string | null } | null;
  /**
   * 该会话所在终端 pane 的定位 env（hook 进程生在会话自己的 pane 里）。
   * **逐行字段**（同一 claim 里不同会话的 pane 不同——错配会把键序打进别的会话
   * 的模态框）；同样不进 payload、不落库。
   */
  terminalEnv?: Record<string, string> | null;
}

export interface InboxDrainDeps {
  hooksDir: string;
  projects: Pick<ProjectRepository, 'getByToken'>;
  hookEvents: HookEventRepository;
  hookSessions: SessionRepository;
  adapters: readonly EventSource[];
}

interface InboxLine {
  token: string;
  report: HookReport;
  messaging: { socket: string; token: string | null } | null;
  terminalEnv: Record<string, string> | null;
}

/**
 * 一轮消费，两阶段（顺序是安全前提）：
 * ① 先清所有残留 claim（上轮崩在半途的）；② 再把活文件 rename 认领、逐个消费。
 * 先 ① 后 ② 保证 rename 不会覆盖尚未消费的 claim（rename 在 POSIX 下静默覆盖
 * ＝丢数据）；认领失败的（另一进程先到 / 文件被删）本轮跳过。
 */
export function drainInboxOnce(deps: InboxDrainDeps, attempts: Map<string, number> = new Map()): InboxRecord[] {
  const inbox = join(deps.hooksDir, 'inbox');
  let names: string[];
  try {
    names = readdirSync(inbox);
  } catch {
    return [];
  }
  const live: string[] = [];
  for (const name of names) {
    if (name.endsWith(INBOX_FAILED_SUFFIX) || name.endsWith('.tmp')) continue;
    if (name.endsWith(INBOX_CLAIM_SUFFIX)) continue; // 阶段 ①
    if (name.endsWith('.jsonl')) live.push(name);
  }
  const records: InboxRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(INBOX_CLAIM_SUFFIX)) continue;
    records.push(...drainClaim(deps, join(inbox, name), attempts));
  }
  for (const name of live) {
    const target = join(inbox, `${name.slice(0, -'.jsonl'.length)}${INBOX_CLAIM_SUFFIX}`);
    if (existsSync(target)) continue; // claim 未消费完（上一步失败）→ 活文件等下轮
    try {
      renameSync(join(inbox, name), target);
    } catch {
      continue; // 竞争输家
    }
    records.push(...drainClaim(deps, target, attempts));
  }
  return records;
}

/** 消费一个 claim 文件：全组入库成功才删文件；失败组留在盘上重试。 */
function drainClaim(deps: InboxDrainDeps, claimPath: string, attempts: Map<string, number>): InboxRecord[] {
  let lines: string[];
  try {
    lines = readFileSync(claimPath, 'utf8').split('\n');
  } catch {
    return [];
  }
  const groups = new Map<
    string,
    {
      project?: ProjectRow;
      lines: string[];
      inputs: HookEventInput[];
      delivered: (string | null)[];
      /** 与 inputs 逐行对齐（pane 定位是会话级事实，不能取组内最后一个）。 */
      terminals: (Record<string, string> | null)[];
      /** 同上：inbox 凭据也是会话级事实——组内最后一个的 socket 不是别人的。 */
      messaging: (InboxLine['messaging'])[];
    }
  >();
  for (const text of lines) {
    const line = text.trim();
    if (!line) continue;
    const parsed = parseLine(line);
    if (!parsed) continue; // 坏行直接丢（重试无意义）
    const group = groups.get(parsed.token) ?? {
      lines: [],
      inputs: [],
      delivered: [],
      terminals: [],
      messaging: [],
    };
    group.lines.push(line);
    if (!group.project) {
      group.project = deps.projects.getByToken(parsed.token); // 项目已删 → 整组丢
      groups.set(parsed.token, group);
    }
    // 归档项目不消费：行即焚（不进 failedLines → 文件全组焚毁后删除），
    // 与活跃项目同一轮 drain 里完成——「消费其他项目时立即销毁归档日志」。
    if (!group.project || group.project.archivedAt) continue;
    const adapter = parsed.report && typeof parsed.report === 'object'
      ? deps.adapters.find((a) => a.source === parsed.report.source)
      : undefined;
    if (!adapter || !parsed.report.eventType) continue; // 不可归一化 → 丢此行
    try {
      group.inputs.push(adapter.normalize(parsed.report, group.project.id) as HookEventInput);
      group.delivered.push(parsed.report.deliveredTitle ?? null);
      group.terminals.push(parsed.terminalEnv);
      group.messaging.push(parsed.messaging);
    } catch {
      // 单条坏报告不拖垮整批
    }
  }

  const records: InboxRecord[] = [];
  const failedLines: string[] = [];
  for (const group of groups.values()) {
    if (!group.project || group.inputs.length === 0) continue;
    try {
      // worker 无 bus：SSE 由主线程按返回记录补发
      const ids = insertBatch(deps, group.project, group.inputs);
      for (let i = 0; i < group.inputs.length; i++) {
        records.push({
          eventId: ids[i]!,
          projectId: group.project.id,
          input: group.inputs[i]!,
          deliveredTitle: group.delivered[i] ?? null,
          messaging: group.messaging[i] ?? null,
          terminalEnv: group.terminals[i] ?? null,
        });
      }
    } catch {
      failedLines.push(...group.lines);
    }
  }

  if (failedLines.length === 0) {
    attempts.delete(claimPath);
    try {
      unlinkSync(claimPath);
    } catch {
      // Windows 上句柄还开着的极端场景：下一轮会再删
    }
    return records;
  }
  const count = (attempts.get(claimPath) ?? 0) + 1;
  attempts.set(claimPath, count);
  if (count >= MAX_CLAIM_ATTEMPTS) {
    // 毒丸停放：保数据不丢、不再热循环
    attempts.delete(claimPath);
    try {
      renameSync(claimPath, claimPath.replace(INBOX_CLAIM_SUFFIX, INBOX_FAILED_SUFFIX));
    } catch {}
    return records;
  }
  try {
    writeFileSync(claimPath, failedLines.join('\n') + '\n');
  } catch {}
  return records;
}

/**
 * 一组事件的批量落库：单事务 insertMany + 会话 touch 按 sessionId 去重。
 * 返回与 inputs 对齐的新行 id 列表（主线程按记录补 SSE / 规则分发）。
 *
 * **会话行随首个事件即建**（含仅一条 SessionStart 的新会话）：新建会话要**马上**
 * 出现在会话列表，「只带 SessionStart 就不建档」那条旧判据已推翻（它让刚起的
 * 会话要等到第一条 prompt 或闲置 Notification 才现身）。所有会话同一条闲置
 * 移除线（`listWithCounts` 的 autoDeleteAt = lastSeenAt + settings `sessions.idleDays`），
 * SessionSweeper 过期即清（复用手动删会话级联）。
 */
function insertBatch(deps: InboxDrainDeps, project: ProjectRow, inputs: HookEventInput[]): number[] {
  const ids = deps.hookEvents.insertMany(inputs);
  const touched = new Set<string>();
  for (const input of inputs) {
    if (!input.sessionId || touched.has(input.sessionId)) continue;
    touched.add(input.sessionId);
    deps.hookSessions.touch(input.sessionId, project.id);
  }
  return ids;
}

/** 行形 `{v, token, report, messaging?, terminal?}`；require 三样齐全（缺 token 无从归因，直接丢）。 */
function parseLine(line: string): InboxLine | null {
  try {
    const obj = JSON.parse(line) as {
      token?: unknown;
      report?: HookReport;
      messaging?: { socket?: unknown; token?: unknown } | null;
      terminal?: unknown;
    } | null;
    if (!obj || typeof obj.token !== 'string' || !obj.token) return null;
    if (!obj.report || typeof obj.report !== 'object') return null;
    const sock = obj.messaging?.socket;
    const messaging =
      typeof sock === 'string' && sock
        ? {
            socket: sock,
            token: typeof obj.messaging?.token === 'string' ? obj.messaging.token : null,
          }
        : null;
    return { token: obj.token, report: obj.report, messaging, terminalEnv: parseTerminalEnv(obj.terminal) };
  } catch {
    return null;
  }
}

/** 终端定位 env：非空字符串值的键才收（值不是字符串/空串 = 该键不可用）。 */
function parseTerminalEnv(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value) env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : null;
}

/**
 * 停放文件复活（启动时一次）：`.failed.jsonl` 是「连续失败达上限」的保护区，
 * 停在盘上等人工处理。但多数失败是瞬时争用（多写者/重建 WAL）——进程重启后
 * 给它新一轮机会：rename 成 claim，消费线程第一阶段就会先消费它；再失败会重新
 * 停放，不会热循环。
 */
export function unparkFailedInbox(hooksDir: string): number {
  const inbox = join(hooksDir, 'inbox');
  let names: string[];
  try {
    names = readdirSync(inbox);
  } catch {
    return 0;
  }
  let revived = 0;
  for (const name of names) {
    if (!name.endsWith(INBOX_FAILED_SUFFIX)) continue;
    const target = join(inbox, `${name.slice(0, -INBOX_FAILED_SUFFIX.length)}${INBOX_CLAIM_SUFFIX}`);
    if (existsSync(target)) continue; // 已有待消费 claim → 留给下一轮
    try {
      renameSync(join(inbox, name), target);
      revived++;
    } catch {
      // 竞争输家/文件已不在
    }
  }
  return revived;
}

// ---- 主线程侧：worker 入库记录的后段（SSE + 规则分发 + outbox 顺延） ----

export interface IngestedHandlerDeps {
  projects: Pick<ProjectRepository, 'getById'>;
  hooksDir: string;
  bus?: HookEventBus;
  dispatcher?: HookDispatcher;
  /** 空闲订阅引擎（session-orchestration 批 2）：见目标会话的 idleSignals 即 fire。 */
  watchEngine?: Pick<WatchEngine, 'onEvent'>;
  /** 序列引擎（批 3）：inject 步的完成判据 = 目标 idleSignals 事件。 */
  sequenceEngine?: Pick<SequenceEngine, 'onEvent'>;
  /** prompt 队列冲洗 + inbox 直投凭据上报 + 投递回执（消息域重塑）；缺省功能降级。 */
  messagePipe?: Pick<MessageDeliverer, 'hasQueued' | 'flushSession'> & {
    /** hook 旁路上报的会话 inbox 目标（内存态）。 */
    noteInboxSocket?(sessionId: string, target: { socket: string; token: string | null } | null): void;
    /** hook 旁路上报的会话 pane 定位 env（内存态；层② 精确定位用）。 */
    notePaneEnv?(sessionId: string, env: Record<string, string>): void;
    /** UPS 事件 = 投递回执判据（prompt 原文与在途条目匹配）。 */
    onSessionPrompt?(sessionId: string, prompt: string): void;
    /** 会话退出事件（`HARNESS_LIFECYCLE[<harness>].sessionExit`）= 旁路事实作废点。 */
    sessionExited?(sessionId: string): void;
  };
  /** 阻塞式问答跟踪（toolName 不进帧域，挂点在此）；缺省不跟踪。 */
  questionTracker?: Pick<QuestionTracker, 'onEvent'>;
  /** 会话转录路径上报（中断态探测用；转录路径在 payload 里，帧域不带）。 */
  sessionProbe?: { noteTranscript(sessionId: string, path: string | null): void };
}

/**
 * worker 入库记录的主线程消费：每条补发 `event.ingested` SSE（任务面板实时），
 * 再进 dispatcher（manual/webhook/log/plugin、会话标题双向）与 watch 引擎
 * （空闲订阅触发，消息域与规则域平行），插件注入产出写 outbox 顺延给下一次 hook 事件。
 */
export function handleIngestedRecords(deps: IngestedHandlerDeps, records: InboxRecord[]): void {
  for (const record of records) {
    const project = deps.projects.getById(record.projectId);
    if (!project) continue;
    let payload: NormalizedHookPayload | null = null;
    try {
      payload = JSON.parse(record.input.payload) as NormalizedHookPayload;
    } catch {
      payload = null;
    }
    deps.bus?.emit({
      kind: 'event.ingested',
      eventId: record.eventId,
      projectId: project.id,
      sessionId: record.input.sessionId ?? null,
      eventType: record.input.eventType,
      ...frameFacts(payload),
      at: new Date().toISOString(),
    });
    if (record.input.sessionId) {
      // 阻塞式问答状态机：Pre/PostToolUse 与 Notification 带 toolName/raw，
      // 帧域没有这些——跟踪必须挂在解析后的 payload 上（与 watch 引擎平行）。
      deps.questionTracker?.onEvent({
        sessionId: record.input.sessionId,
        source: record.input.source,
        payload,
      });
      deps.watchEngine?.onEvent({
        sessionId: record.input.sessionId,
        eventType: record.input.eventType,
        source: record.input.source,
      });
      deps.sequenceEngine?.onEvent({
        sessionId: record.input.sessionId,
        eventType: record.input.eventType,
        source: record.input.source,
      });
      if (record.messaging) deps.messagePipe?.noteInboxSocket?.(record.input.sessionId, record.messaging);
      // 转录路径（中断态探测）：与 pane env 同口径——每次事件覆盖刷新、只留内存。
      deps.sessionProbe?.noteTranscript(record.input.sessionId, payload?.transcriptPath ?? null);
      if (record.terminalEnv) deps.messagePipe?.notePaneEnv?.(record.input.sessionId, record.terminalEnv);
      // UPS = 投递回执判据：会话真收到消息时必然打一条（payload.raw.prompt 即投递原文）
      if (record.input.eventType === 'UserPromptSubmit') {
        const prompt = promptTextOf(payload);
        if (prompt) deps.messagePipe?.onSessionPrompt?.(record.input.sessionId, prompt);
      }
      // 会话退出（谁是退出事件归 harness 生命周期表）：旁路事实随进程作废——
      // inbox 凭据出盘、pane 定位清，压队的行也已成死信（sessionExited 内一并落定）。
      const exitEvent = isHarness(record.input.source)
        ? HARNESS_LIFECYCLE[record.input.source].sessionExit
        : null;
      if (exitEvent !== null && record.input.eventType === exitEvent) {
        deps.messagePipe?.sessionExited?.(record.input.sessionId);
      }
      if (deps.messagePipe?.hasQueued(record.input.sessionId)) {
        void deps.messagePipe.flushSession(record.input.sessionId);
      }
    }
    if (!deps.dispatcher) continue;
    void deps.dispatcher
      .onIngest({
        eventId: record.eventId,
        project,
        sessionId: record.input.sessionId ?? null,
        payload: payload ?? {
          eventType: record.input.eventType,
          toolName: null,
          toolInput: null,
          toolResponse: null,
          cwd: null,
          transcriptPath: null,
          raw: null,
        },
        source: record.input.source,
        deliveredTitle: record.deliveredTitle ?? null,
      })
      .then((outcome) => {
        if (outcome.deferred && record.input.sessionId) {
          appendOutbox(deps.hooksDir, project.token, [
            { sessionId: record.input.sessionId, text: outcome.deferred },
          ]);
        }
      })
      .catch(() => {}); // 分发失败永不影响采集
  }
}

/** UPS 的 prompt 原文（raw.prompt）；非 UPS/缺字段 = null。 */
function promptTextOf(payload: NormalizedHookPayload | null): string | null {
  const raw = payload?.raw as { prompt?: unknown } | null | undefined;
  return typeof raw?.prompt === 'string' && raw.prompt ? raw.prompt : null;
}

// ---- worker 自举（daemon 侧唯一实例） ----

export interface InboxWorkerOptions {
  dbPath: string;
  hooksDir: string;
  tickMs?: number;
}

/**
 * 起 inbox 消费线程。自举 URL 即本文件（tsx 直跑 .ts、tsc 产物跑 .js 都成立；
 * daemon 由 `node --import tsx` 起，worker 继承 execArgv 获得同样的 TS 能力）。
 */
export function startInboxWorker(opts: InboxWorkerOptions): Worker {
  return new Worker(new URL(import.meta.url), {
    workerData: { inboxWorker: true, ...opts },
  });
}

interface InboxWorkerData extends InboxWorkerOptions {
  inboxWorker?: boolean;
}

if (!isMainThread && (workerData as InboxWorkerData | undefined)?.inboxWorker === true) {
  const data = workerData as InboxWorkerData;
  const db = openDatabase(data.dbPath);
  const deps: InboxDrainDeps = {
    hooksDir: data.hooksDir,
    projects: new ProjectRepository(db),
    hookEvents: new HookEventRepository(db),
    hookSessions: new SessionRepository(db),
    adapters: createRuntimeRegistry().byCapability('events').flatMap((d) => d.events ?? []),
  };
  const attempts = new Map<string, number>();
  const tick = (): void => {
    try {
      const records = drainInboxOnce(deps, attempts);
      if (records.length > 0) parentPort?.postMessage(records);
    } catch (e) {
      console.error('[weave] inbox drain failed:', e);
    }
  };
  tick(); // 覆盖「server 恢复但用户没触发任何 hook」的场景
  // 不可 unref：worker 线程里没有别的 ref 句柄，unref 的定时器不阻止事件循环
  // 退出——worker 会在第一 tick 后静默死掉（表现为「积压只被爆冲一遍，之后
  // inbox 只涨不消、dashboard 再无事件」）。生命周期由主线程 terminate 掌控。
  setInterval(tick, data.tickMs ?? INBOX_TICK_MS);
}
