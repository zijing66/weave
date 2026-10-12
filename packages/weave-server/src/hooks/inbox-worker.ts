import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { createRuntimeRegistry, frameFacts, type EventSource } from '@weavecode/harness';
import { openDatabase } from '../db/db.js';
import { HookEventRepository, type HookEventInput } from '../repositories/hook-events.js';
import { ProjectRepository, type ProjectRow } from '../repositories/projects.js';
import { SessionRepository } from '../repositories/sessions.js';
import type { HookEventBus } from './bus.js';
import type { HookDispatcher } from './dispatcher.js';
import { appendOutbox } from './mirror.js';
import { ingestBacklog } from './spool.js';
import type { HookReport, NormalizedHookPayload } from './types.js';

/**
 * inbox 消费线程（hook 文件化管道的 daemon 侧）：hook-handler.cjs 把事件追加到
 * `<dataDir>/hooks/inbox/<shard>.jsonl`（行形 `{v, token, report}`，纯传输缓冲、
 * 入库即删）；本模块在 worker_threads 里认领→入库，主线程收 postMessage 后补
 * SSE/dispatcher/outbox。
 *
 * 竞争协议（复用 spool 的 rename-claim）：rename 原子先到先得，输家 ENOENT 空手；
 * 崩在半途留下 `.claim.jsonl` 下轮先清。入库失败的行留盘重试，连续失败 parked
 * 为 `.failed.jsonl` 防毒丸热循环。行内 token 解析项目（项目已删 → 丢行，同
 * 旧 /hooks 401 语义）；不可归因的坏行直接丢（重试无意义）。
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
  const groups = new Map<string, { project?: ProjectRow; lines: string[]; inputs: HookEventInput[] }>();
  for (const text of lines) {
    const line = text.trim();
    if (!line) continue;
    const parsed = parseLine(line);
    if (!parsed) continue; // 坏行直接丢（重试无意义）
    const group = groups.get(parsed.token) ?? { lines: [], inputs: [] };
    group.lines.push(line);
    if (!group.project) {
      group.project = deps.projects.getByToken(parsed.token); // 项目已删 → 整组丢
      groups.set(parsed.token, group);
    }
    if (!group.project) continue;
    const adapter = parsed.report && typeof parsed.report === 'object'
      ? deps.adapters.find((a) => a.source === parsed.report.source)
      : undefined;
    if (!adapter || !parsed.report.eventType) continue; // 不可归一化 → 丢此行
    try {
      group.inputs.push(adapter.normalize(parsed.report, group.project.id) as HookEventInput);
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
      const ids = ingestBacklog(
        { hookEvents: deps.hookEvents, hookSessions: deps.hookSessions },
        group.project,
        group.inputs,
      );
      for (let i = 0; i < group.inputs.length; i++) {
        records.push({ eventId: ids[i]!, projectId: group.project.id, input: group.inputs[i]! });
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

/** 行形 `{v, token, report}`；require 三样齐全（缺 token 无从归因，直接丢）。 */
function parseLine(line: string): InboxLine | null {
  try {
    const obj = JSON.parse(line) as { token?: unknown; report?: HookReport } | null;
    if (!obj || typeof obj.token !== 'string' || !obj.token) return null;
    if (!obj.report || typeof obj.report !== 'object') return null;
    return { token: obj.token, report: obj.report };
  } catch {
    return null;
  }
}

// ---- 主线程侧：worker 入库记录的后段（SSE + 规则分发 + outbox 顺延） ----

export interface IngestedHandlerDeps {
  projects: Pick<ProjectRepository, 'getById'>;
  hooksDir: string;
  bus?: HookEventBus;
  dispatcher?: HookDispatcher;
}

/**
 * worker 入库记录的主线程消费：每条补发 `event.ingested` SSE（任务面板实时），
 * 再进 dispatcher（manual/webhook/log/plugin、会话标题双向），插件注入产出
 * 写 outbox 顺延给下一次 hook 事件。
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
  setInterval(tick, data.tickMs ?? INBOX_TICK_MS).unref();
}
