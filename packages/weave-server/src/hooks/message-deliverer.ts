import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { WEAVE_INJECTION_MARKER, isHarness, type Harness } from '@weavecode/core';
import type { MessagingSurface, MessageMeta, PromptRelaySpec } from '@weavecode/harness';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { ProjectRepository } from '../repositories/projects.js';
import type { SessionRepository } from '../repositories/sessions.js';
import { messagingSurfaceFor } from '../surfaces.js';
import { normalizeDirKey } from '../daemon/opener.js';
import type { HookEventBus } from './bus.js';
import { HeadlessRunner, type HeadlessSettleResult, type SpawnLike } from './headless-runner.js';
import { appendOutbox, hooksRoot } from './mirror.js';
import { InboxSocketRegistry, deliverViaInboxSocket } from './inbox-socket.js';
import {
  appendPromptbox,
  readAllPromptbox,
  readPromptbox,
  removePromptboxBySession,
  removePromptboxEntries,
  scanQueuedSessionIds,
} from './promptbox.js';

/**
 * 消息域投递器（消息域重塑：纯递送管道，非记录系统）——消息不落任何 DB 行，
 * 唯一归宿是目标会话自己的转录；weave 仅投递前短暂持有：
 *
 *   prompt  → 层① 原生 peer 消息中继（claude SendMessage，经受限 headless 进程）
 *             层② 终端 send-text 兜底（无原生机制的 harness；TerminalBackend 通道）
 *             层③ promptbox 队列（`<dataDir>/hooks/promptbox/<shard>.jsonl`，送达即删行）
 *   inject  → outbox 顺延注入（fire-and-forget，随目标会话下一拍 hook 事件送达）
 *   headless → 无头强制回合（running → 终态）
 *   auto    → turnOpen 忙 → inject（绝不无头抢占）；闲 → headless
 *
 * 内存态注册表只放「pending 之后」的消息（投递中 / headless 在途 / 终态结果）；
 * pending 只存在于 promptbox 文件。重启即丢 headless 终态 = 显式高级选项的
 * 已文档代价。通道规格全部来自 MessagingSurface 能力面，本类不含 harness 硬编码。
 *
 * send() 校验失败同步返回错误码；成功立即返回（inject 已落 outbox，headless
 * 「已启动」，prompt 视层可用性返回 delivering/pending），终态经回调后台落定，
 * 绝不 throw 出 send()。
 */

/** 投递模式（路由入参；auto = 裁决后落 inject/headless）。 */
export type MessageMode = 'prompt' | 'inject' | 'headless' | 'auto';

/** 发起方（仅信封渲染用，管道不记录来源）。 */
export type MessageFromKind = 'dashboard' | 'session';

/** 管道消息状态：pending 只活在 promptbox 文件，其余在内存注册表。 */
export type PipeStatus =
  | 'pending' // promptbox 文件里（仅 prompt 通道）
  | 'delivering' // prompt 中继/终端注入在途
  | 'running' // headless 回合在途
  | 'injected' // inject 已写 outbox（fire-and-forget 完成）
  | 'delivered' // prompt 已送达
  | 'succeeded'
  | 'failed'
  | 'timeout'; // headless 终态（内存驻留）

/** 管道消息（内存态；发号 = uuid，全生命周期稳定）。 */
export interface PipeMessage {
  id: string;
  sessionId: string;
  text: string;
  mode: MessageMode;
  /** 单向注入（手动面：无接收方会话，中继载荷带「无需回复」注记）；编排域不置。 */
  oneWay?: boolean;
  /** prompt 通道的实际落法（socket 直投 / 中继 / 终端 send-text）。 */
  via?: 'socket' | 'relay' | 'terminal';
  /** 投递回执：会话自己的 UserPromptSubmit 与本文匹配上了（真到达，非「已交给」）。 */
  acked?: boolean;
  /** 实际投递通道（auto 落定后回填；pending = 尚未裁决成通道）。 */
  channel: 'prompt' | 'inject' | 'headless' | null;
  status: PipeStatus;
  output?: string | null;
  error?: string | null;
  at: string;
}

/** 终端 send-text 兜底通道（层②）：TerminalBackend 能力面的消费侧形状。 */
export interface PromptTerminal {
  /** 通道可用性（同步声明；装配侧随 settings 终端后端能力变化，能力矩阵取用）。 */
  available(): boolean;
  /** 可注入 pane（id / 标题 / 工作目录；取不到的字段为 null）。 */
  listPanes(): Promise<Array<{ id: string; title: string | null; cwd: string | null }>>;
  /** 往 pane 注入一段 prompt（原文 + 提交键）。 */
  sendText(paneId: string, text: string): Promise<void>;
}

export interface MessageDelivererDeps {
  sessions: SessionRepository;
  projects: ProjectRepository;
  /** harness 归属判定用：目标会话最新事件的 source（与 open-terminal 同口径）。 */
  hookEvents: HookEventRepository;
  bus?: HookEventBus;
  /** 共享无头执行核（与 ResumeRunner 同实例 = 跨域同会话并发闸；中继经合成键不占目标会话闸）。 */
  headless?: HeadlessRunner;
  /** 测试注入的 spawn 实现；缺省经 HeadlessRunner 用 node:child_process.spawn。 */
  spawnImpl?: SpawnLike;
  /** 测试注入的强杀实现。 */
  killImpl?: (pid: number) => void;
  /** harness 可执行覆盖（测试用）；缺省环境变量，再缺省 spec.bin。 */
  bin?: string;
  /** 无头回合超时（毫秒）；缺省 HeadlessRunner 默认 300s。 */
  timeoutMs?: number;
  /** prompt 中继超时（毫秒）；**缺省 0 = 不设超时**——投递的等待发生在目标
   *  会话内（忙则等它下一拍 tool round 取走），设上限会把正常投递误判 timeout。 */
  relayTimeoutMs?: number;
  /** hooks 根目录（测试注入）；缺省 hooksRoot()。 */
  hooksDir?: string;
  /** 能力面访问器（测试注入）；缺省 surfaces.ts 模块级 registry。 */
  surfaceFor?: (harness: Harness) => MessagingSurface;
  /** 层② 终端 send-text 通道（装配侧按 TerminalBackend 能力注入；缺省无兜底）。 */
  terminal?: PromptTerminal;
  /** 冲洗节流：同一会话两次投递之间的最小间隔（毫秒）；缺省 1000。Claude Code 对
   *  同一会话的快速突发会在**发送侧**拒收（见 docs/plan/session-orchestration.md）。 */
  flushGapMs?: number;
}

/** send() 入参（路由层已做 zod 形状校验）。 */
export interface SendInput {
  toSessionId: string;
  text: string;
  mode: MessageMode;
  fromKind: MessageFromKind;
  fromSessionId?: string | null;
  /** 单向注入（手动面置 true：无接收方会话）；编排域省略 = 双向对话保留。 */
  oneWay?: boolean;
}

/** send() 返回：ok 由路由映射 200，否则 status 即 HTTP 码。 */
export type SendResult =
  | { ok: true; messageId: string; status: PipeStatus; message: PipeMessage }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** 通道裁决结果：mode=auto 落到实际通道后才存在。 */
type ResolvedChannel = 'prompt' | 'inject' | 'headless';

/** 中继进程的工作目录：中性 cwd，避开项目 hooks（spike 实测防幽灵事件）。 */
const relayCwd = () => tmpdir();

/** 冲洗节流（防 Claude Code 发送侧突发拒收）：一轮最多投递几条 + 条间最小间隔。 */
const FLUSH_PASS_MAX = 5;
const FLUSH_GAP_MS = 1_000;

/** 回执比对的最短文本（防「ok」这类短消息误配到别的在途条目）。 */
const ACK_MIN_TEXT = 8;

/**
 * socket 直投的来源标注（只作用于这条路径）：socket 消息是**裸 user 文本**
 * （会话看起来像用户自己敲的），标一句让转录以后能分辨「这不是我敲的」。
 * 实测（本机 2.1.296）不改变回复形态、不改变模型的发送者归属；它**给不了**
 * 系统级来源语义（那只有中继路径有：目标被明确告知「来自另一个会话」并受
 * 跨会话限制）。标记值来自 core 单一事实源——`weave init` 生成的 CLAUDE.md 块
 * 用同一个常量向会话解释它的含义（见 weave-cli/src/init/claudemd-gen.ts）。
 */
const INBOX_SOURCE_PREFIX = WEAVE_INJECTION_MARKER;

/**
 * 回执比对归一：剥掉 Claude Code 给会话间消息裹的外壳（`<cross-session-message
 * from="uds:…" …>…</cross-session-message>`）再折叠空白——socket 直投的原文
 * 是裸文本、中继投递的会带壳，两边都归一成同一形态再比。
 */
function normalizePromptText(text: string): string {
  return text
    .replace(/<\/?cross-session-message[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MessageDeliverer {
  private readonly headless: HeadlessRunner;
  private readonly hooksDir: string;
  /** 内存态注册表（pending 之后的生命周期）。 */
  private readonly memory = new Map<string, PipeMessage>();
  /** 有队列行的会话（ingest 冲洗守卫 + 刷新器探活索引；构造时从磁盘重建）。 */
  private readonly queuedSessions: Set<string>;
  /** 会话 inbox 直投目标（hook 旁路上报；token 只在内存）。 */
  private readonly inboxSockets = new InboxSocketRegistry();
  /** 已排自续冲洗的会话（防重复排拍）。 */
  private readonly flushScheduled = new Set<string>();
  /** 正在冲洗的会话（重入闸：异步冲洗 + 多条触发源，防同批行被投两次）。 */
  private readonly flushing = new Set<string>();

  constructor(private readonly deps: MessageDelivererDeps) {
    this.headless =
      deps.headless ?? new HeadlessRunner({ spawnImpl: deps.spawnImpl, killImpl: deps.killImpl });
    this.hooksDir = deps.hooksDir ?? hooksRoot();
    this.queuedSessions = scanQueuedSessionIds(this.hooksDir);
  }

  /**
   * 裁决表（规格顺序）：session 404 → harness 无法判定 400 → 按模式落通道
   * （auto 忙闲 / prompt 层可用性）→ 通道不支持 409+reason → 无项目 400/404 →
   * headless 被占 409。通过后发号、广播 message.created 并立即投递。
   */
  async send(input: SendInput): Promise<SendResult> {
    const session = this.deps.sessions.getBySessionId(input.toSessionId);
    if (!session) return { ok: false, status: 404, error: 'Session not found' };

    const surface = this.surfaceOfSession(input.toSessionId);
    if (!surface) {
      return { ok: false, status: 400, error: 'Session has no hook events to determine its harness' };
    }

    const channel = this.resolveChannel(input.mode, input.toSessionId, surface);
    if (typeof channel !== 'string') return { ok: false, status: 409, error: channel.reason };

    // 所有通道都需要项目：inject 用 token 分片 outbox，headless 用 path 做 cwd，
    // prompt 用 token 分片 promptbox + 层② 的 pane cwd 匹配。
    if (session.projectId == null) {
      return { ok: false, status: 400, error: 'Session is not bound to a project' };
    }
    const project = this.deps.projects.getById(session.projectId);
    if (!project) return { ok: false, status: 404, error: 'Project not found' };

    if (channel === 'headless' && this.headless.isBusy(input.toSessionId)) {
      return { ok: false, status: 409, error: 'Session already has a running run' };
    }

    const meta: MessageMeta = {
      fromLabel: input.fromKind === 'session' ? `session ${input.fromSessionId ?? 'unknown'}` : input.fromKind,
      at: new Date().toISOString(),
      mode: channel,
    };
    const entry: PipeMessage = {
      id: randomUUID(),
      sessionId: input.toSessionId,
      text: input.text,
      mode: input.mode,
      oneWay: input.oneWay === true,
      channel,
      status: 'pending',
      at: meta.at,
    };
    const result =
      channel === 'inject'
        ? this.deliverInject(entry, project.token, meta, surface)
        : channel === 'headless'
          ? this.deliverHeadless(entry, project.path, meta, surface)
          : await this.deliverPrompt(entry, session, project, surface);
    // created 广播放在**在途状态建立之后**：它同时是派生面（在途角标推送）的重算
    // 依据，早发会让刚进在途的消息漏一拍（投递中的消息不上角标）。
    this.bus({
      kind: 'message.created',
      messageId: entry.id,
      sessionId: entry.sessionId,
      mode: entry.mode,
      at: entry.at,
    });
    return result;
  }

  /** 管道消息现查（内存态；sequence 引擎 / 路由回显用）。 */
  getMessage(id: string): PipeMessage | null {
    return this.memory.get(id) ?? null;
  }

  /** 在途视图（GET /sessions/:id/messages）：promptbox 待递送 ∪ 内存非终待态。 */
  listVisible(sessionId: string): PipeMessage[] {
    const visible = new Set<PipeStatus>(['delivering', 'running', 'succeeded', 'failed', 'timeout']);
    const out: PipeMessage[] = [];
    const session = this.deps.sessions.getBySessionId(sessionId);
    if (session?.projectId != null) {
      const project = this.deps.projects.getById(session.projectId);
      if (project) {
        for (const entry of readPromptbox(this.hooksDir, project.token)) {
          if (entry.sessionId !== sessionId) continue;
          out.push({
            id: entry.id,
            sessionId,
            text: entry.text,
            mode: 'prompt',
            oneWay: entry.oneWay === true,
            channel: 'prompt',
            status: 'pending',
            at: entry.at,
          });
        }
      }
    }
    for (const msg of this.memory.values()) {
      if (msg.sessionId === sessionId && visible.has(msg.status)) out.push(msg);
    }
    return out.sort((a, b) => (a.at < b.at ? -1 : 1));
  }

  /** 该会话是否有队列行（ingest 冲洗守卫，O(1)）。 */
  hasQueued(sessionId: string): boolean {
    return this.queuedSessions.has(sessionId);
  }

  /**
   * 在途计数（sessionId → 条数）：队列 pending（未送达）∪ 内存 delivering/running
   * （在飞）。会话行角标用——终态（injected/delivered/succeeded/…）不计。
   */
  listInflightCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const bump = (sessionId: string): void => {
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    };
    for (const entry of readAllPromptbox(this.hooksDir)) bump(entry.sessionId);
    for (const msg of this.memory.values()) {
      if (msg.status === 'delivering' || msg.status === 'running') bump(msg.sessionId);
    }
    return counts;
  }

  /** 层② 终端 send-text 通道是否装配（能力矩阵 prompt 列合成用）。 */
  hasTerminalChannel(): boolean {
    return this.terminalChannel() != null;
  }

  /**
   * 自续冲洗：本轮投出去过（有进展）但队列仍有行 → 隔一拍继续，直到排空。
   * 只有「有进展」才续（通道不可用时不续，避免热循环）；沿用节流间隔作拍长。
   */
  private scheduleFlushContinuation(sessionId: string): void {
    if (this.flushScheduled.has(sessionId)) return;
    this.flushScheduled.add(sessionId);
    const timer = setTimeout(() => {
      this.flushScheduled.delete(sessionId);
      void this.flushSession(sessionId);
    }, this.deps.flushGapMs ?? FLUSH_GAP_MS);
    timer.unref?.();
  }

  /**
   * hook 旁路上报的会话 inbox 目标（内存态；socket 空 = 该会话此刻不可直投）。
   * token 只在此存活，不落库、不进 UI、不写日志。
   */
  noteInboxSocket(sessionId: string, target: { socket: string; token: string | null } | null): void {
    this.inboxSockets.set(sessionId, target);
  }

  /**
   * 投递回执：会话自己的 UserPromptSubmit 到了 —— 其 prompt 原文与在途条目匹配
   * 即成真（`acked`）。中继/终端/socket 三路通用（中继的原文外面裹着 Claude Code
   * 自己的 `<cross-session-message …>` 壳，比对时归一掉）。
   */
  onSessionPrompt(sessionId: string, prompt: string): void {
    const seen = normalizePromptText(prompt);
    if (!seen) return;
    for (const msg of [...this.memory.values()].reverse()) {
      if (msg.sessionId !== sessionId || msg.acked || msg.mode !== 'prompt') continue;
      const want = normalizePromptText(msg.text);
      if (!want || want.length < ACK_MIN_TEXT || !seen.includes(want)) continue;
      this.memory.set(msg.id, { ...msg, acked: true });
      this.bus({
        kind: 'message.acknowledged',
        messageId: msg.id,
        sessionId,
        at: new Date().toISOString(),
      });
      return; // 一条 UPS 只核销一条在途（新→旧找第一条匹配）
    }
  }

  /**
   * 队列冲洗（幂等）：层① 命中 → 中继；层② pane 命中 → send-text；都不行留队列。
   * **节流**（Claude Code 对同一会话的快速突发在发送侧拒收）：一轮最多 `FLUSH_PASS_MAX`
   * 条、条间至少 `flushGapMs`（中继路径本就被同会话中继闸天然间隔，终端路径没有，
   * 所以节流在这里统一兜）。超出的留队列，下轮触发（ingest / 刷新器）继续。
   */
  async flushSession(sessionId: string): Promise<void> {
    // 重入闸：冲洗是异步的（终端通道要 await 枚举 pane），两条触发源（事件 + 自续/刷新器）
    // 并发进来会各自读到同一批队列行 → 同一消息被投两次。
    if (this.flushing.has(sessionId)) return;
    if (!this.queuedSessions.has(sessionId)) return;
    this.flushing.add(sessionId);
    try {
      await this.flushSessionInner(sessionId);
    } catch {
      // 冲洗失败永不影响调用方（事件路径是 fire-and-forget；自续拍可能与拆除竞态）
    } finally {
      this.flushing.delete(sessionId);
    }
  }

  private async flushSessionInner(sessionId: string): Promise<void> {
    const session = this.deps.sessions.getBySessionId(sessionId);
    if (session?.projectId == null) return;
    const project = this.deps.projects.getById(session.projectId);
    if (!project) return;
    const entries = readPromptbox(this.hooksDir, project.token).filter((e) => e.sessionId === sessionId);
    if (entries.length === 0) {
      this.queuedSessions.delete(sessionId);
      return;
    }
    const surface = this.surfaceOfSession(sessionId);
    const relay = surface?.prompt ?? null;
    let delivered = 0;
    for (const entry of entries) {
      if (delivered >= FLUSH_PASS_MAX) {
        // 本轮量到：余下留队列，**自续下一拍**（socket 直投是毫秒级，不该等下一次事件）
        this.scheduleFlushContinuation(sessionId);
        return;
      }
      if (delivered > 0) await sleep(this.deps.flushGapMs ?? FLUSH_GAP_MS);
      const peer = relay?.resolve(sessionId) ?? null;
      if (relay && peer) {
        const msg: PipeMessage = {
          id: entry.id,
          sessionId,
          text: entry.text,
          mode: 'prompt',
          oneWay: entry.oneWay === true,
          via: 'relay',
          channel: 'prompt',
          status: 'pending',
          at: entry.at,
        };
        this.memory.set(msg.id, { ...msg, status: 'delivering' });
        const started = this.runRelay(msg, relay, peer.name);
        if (started) {
          removePromptboxEntries(this.hooksDir, project.token, new Set([entry.id]));
          delivered++;
          continue;
        }
        // 同会话中继在途：本轮到此为止，剩余行留队列
        this.memory.delete(msg.id);
        return;
      }
      if (this.terminalChannel()) {
        const pane = await this.terminalPaneFor(session, project);
        if (pane) {
          removePromptboxEntries(this.hooksDir, project.token, new Set([entry.id]));
          this.memory.set(entry.id, {
            id: entry.id,
            sessionId,
            text: entry.text,
            mode: 'prompt',
            oneWay: entry.oneWay === true,
            via: 'terminal',
            channel: 'prompt',
            status: 'delivering',
            at: entry.at,
          });
          await this.runTerminalPrompt(entry.id, pane.id, entry.text);
          delivered++;
          continue;
        }
      }
      // 层均不可用（会话没开 / pane 找不到）：留队列等下轮触发
      return;
    }
    const rest = readPromptbox(this.hooksDir, project.token).filter((e) => e.sessionId === sessionId);
    if (rest.length === 0) this.queuedSessions.delete(sessionId);
  }

  /** 刷新器入口：扫全部队列会话（只在队列非空时被调用才有意义）。 */
  async flushAll(): Promise<void> {
    for (const sessionId of [...this.queuedSessions]) {
      await this.flushSession(sessionId);
    }
  }

  /** 会话删除级联：内存态 + 队列行。返回清理行数（口径与旧 DB 计数一致）。 */
  forgetSession(sessionId: string): number {
    let removed = 0;
    for (const [id, msg] of this.memory) {
      if (msg.sessionId === sessionId) {
        this.memory.delete(id);
        removed++;
      }
    }
    removed += removePromptboxBySession(this.hooksDir, sessionId);
    this.queuedSessions.delete(sessionId);
    this.inboxSockets.forget(sessionId); // 凭据随会话走（旧 socket 早已无效）
    return removed;
  }

  /** 项目归档级联（内存态按会话→项目归属判定；队列行按会话逐个清）。 */
  forgetProject(projectId: number): number {
    let removed = 0;
    for (const [id, msg] of this.memory) {
      const session = this.deps.sessions.getBySessionId(msg.sessionId);
      if (session?.projectId === projectId) {
        this.memory.delete(id);
        this.inboxSockets.forget(msg.sessionId);
        removed++;
      }
    }
    for (const sessionId of [...this.queuedSessions]) {
      const session = this.deps.sessions.getBySessionId(sessionId);
      if (session?.projectId === projectId) removed += this.forgetSession(sessionId);
    }
    return removed;
  }

  /** harness 归属 = 最新事件 source（open-terminal 同口径）。 */
  private surfaceOfSession(sessionId: string): MessagingSurface | null {
    const latest = this.deps.hookEvents.listBySession(sessionId, 1);
    const src = latest[latest.length - 1]?.source;
    if (!isHarness(src)) return null;
    return this.deps.surfaceFor?.(src) ?? messagingSurfaceFor(src);
  }

  /**
   * mode → 实际通道。prompt = 层① 原生 || 层② 终端通道（都没有才 409）；
   * auto 的忙/闲基准 = turnOpenOf，忙 → inject（无通道才拒绝，绝不无头抢占），
   * 闲 → headless。对象 = 拒绝（409 reason）；字符串 = 选中的通道。
   */
  private resolveChannel(
    mode: MessageMode,
    sessionId: string,
    surface: MessagingSurface,
  ): ResolvedChannel | { reason: string } {
    if (mode === 'prompt') {
      if (surface.prompt) return 'prompt';
      if (this.terminalChannel()) return 'prompt';
      return {
        reason:
          surface.unsupportedReasons?.prompt ??
          `Harness "${surface.harness}" has no native prompt channel and the configured terminal cannot inject text`,
      };
    }
    if (mode === 'inject' || mode === 'headless') {
      const supported = mode === 'inject' ? surface.inject : surface.headless;
      if (!supported) return { reason: this.unsupportedReason(surface, mode) };
      return mode;
    }
    const turnOpen = this.deps.sessions.turnOpenOf(sessionId);
    const channel: Exclude<ResolvedChannel, 'prompt'> = turnOpen ? 'inject' : 'headless';
    const supported = channel === 'inject' ? surface.inject : surface.headless;
    if (!supported) return { reason: this.unsupportedReason(surface, channel) };
    return channel;
  }

  /** 不支持原因：面声明优先，缺省兜底文案。 */
  private unsupportedReason(
    surface: MessagingSurface,
    channel: Exclude<ResolvedChannel, 'prompt'>,
  ): string {
    return (
      surface.unsupportedReasons?.[channel] ??
      `Harness "${surface.harness}" does not support the ${channel} messaging channel`
    );
  }

  /** 层② pane 匹配：标题（剥 ✳ spinner 前缀）== 会话标题 且 cwd == 项目路径（归一比较）；歧义拒绝不打。 */
  private async terminalPaneFor(
    session: { sessionId: string; title: string | null },
    project: { path: string },
  ): Promise<{ id: string } | null> {
    const terminal = this.terminalChannel();
    if (!terminal || !session.title) return null;
    const want = session.title.replace(/^[✳*]+\s*/, '');
    const pathKey = normalizeDirKey(project.path, process.platform);
    let panes: Array<{ id: string; title: string | null; cwd: string | null }>;
    try {
      panes = await terminal.listPanes();
    } catch {
      return null;
    }
    const hits = panes.filter(
      (p) =>
        p.title != null &&
        p.cwd != null &&
        pathKey != null &&
        p.title.replace(/^[✳*]+\s*/, '') === want &&
        normalizeDirKey(p.cwd, process.platform) === pathKey,
    );
    return hits.length === 1 ? hits[0]! : null;
  }

  /** 层② 通道现取（available 是随 settings 变的诚实声明，不可缓存到构造期）。 */
  private terminalChannel(): PromptTerminal | null {
    const terminal = this.deps.terminal;
    return terminal && terminal.available() ? terminal : null;
  }

  /** prompt 通道入口（send 的即时路径）：层① 命中即时中继，层② 异步找 pane，都不行入队。 */
  private async deliverPrompt(
    entry: PipeMessage,
    session: { sessionId: string; title: string | null },
    project: { token: string; path: string },
    surface: MessagingSurface,
  ): Promise<SendResult> {
    // 层①-a 会话本地收件箱直投（毫秒级、零进程零 LLM）：**机制由 harness 声明**
    // （`surface.promptInbox`；claude = inbox socket，其他 harness = null 即完全不尝试），
    // 目标地址由 hook 旁路上报。**手动面（oneWay）优先**——它把消息当用户 prompt
    // 注入（无回复面）；编排域先走中继（那里才带 @weave 身份）。
    // 拿不到目标（会话没装 weave hooks / messaging 关闭）或投递失败 → 原路回落。
    const inboxSpec = surface.promptInbox;
    const inboxTarget = this.inboxSockets.get(entry.sessionId);
    if (inboxSpec && entry.oneWay === true && inboxTarget) {
      this.memory.set(entry.id, { ...entry, status: 'delivering', via: 'socket' });
      try {
        // 来源标注只加在这里（中继路径有系统级来源，见 INBOX_SOURCE_PREFIX 注释）
        await deliverViaInboxSocket(inboxSpec, inboxTarget, `${INBOX_SOURCE_PREFIX}${entry.text}`);
        const delivered: PipeMessage = {
          ...this.memory.get(entry.id)!,
          status: 'delivered',
          via: 'socket',
        };
        this.memory.set(entry.id, delivered);
        this.bus({
          kind: 'message.delivered',
          messageId: entry.id,
          sessionId: entry.sessionId,
          at: new Date().toISOString(),
        });
        return { ok: true, messageId: entry.id, status: 'delivered', message: delivered };
      } catch {
        this.memory.delete(entry.id); // 回落：不留痕，下面走中继/终端/队列
      }
    }

    const relay = surface.prompt;
    const peer = relay?.resolve(entry.sessionId) ?? null;
    if (relay && peer) {
      this.memory.set(entry.id, { ...entry, status: 'delivering', via: 'relay' });
      if (this.runRelay(entry, relay, peer.name)) {
        return { ok: true, messageId: entry.id, status: 'delivering', message: this.memory.get(entry.id)! };
      }
      // 同会话中继在途：落队列，下轮冲洗
      this.memory.delete(entry.id);
    } else if (this.terminalChannel()) {
      const pane = await this.terminalPaneFor(session, project);
      if (pane) {
        this.memory.set(entry.id, { ...entry, status: 'delivering', via: 'terminal' });
        void this.runTerminalPrompt(entry.id, pane.id, entry.text);
        return { ok: true, messageId: entry.id, status: 'delivering', message: this.memory.get(entry.id)! };
      }
    }
    this.queueEntry(entry, project.token);
    const pending: PipeMessage = { ...entry, status: 'pending' };
    return { ok: true, messageId: entry.id, status: 'pending', message: pending };
  }

  /** 入队（promptbox 追加 + 会话索引登记）。 */
  private queueEntry(entry: PipeMessage, token: string): void {
    appendPromptbox(this.hooksDir, token, [
      { id: entry.id, sessionId: entry.sessionId, text: entry.text, oneWay: entry.oneWay === true },
    ]);
    this.queuedSessions.add(entry.sessionId);
  }

  /**
   * 层① 中继：复用 HeadlessRunner 的 spawn 基建（win32 shell 单串 + stdin +
   * 超时），键 = 合成键（不占目标会话的 headless 并发闸）。返回是否启动成功。
   */
  private runRelay(entry: PipeMessage, relay: PromptRelaySpec, peerName: string): boolean {
    try {
      return this.headless.run({
        sessionId: `prompt-relay:${entry.sessionId}`,
        cwd: relayCwd(),
        prompt: relay.instruction(peerName, entry.text, { oneWay: entry.oneWay === true }),
        spec: { supported: true, bin: relay.bin, args: () => [...relay.args], promptStdin: true },
        bin: this.deps.bin ?? process.env.WEAVE_CLAUDE_BIN ?? relay.bin,
        timeoutMs: this.deps.relayTimeoutMs ?? 0,
        // 中继 = 本轮次的一次性子进程：与 daemon 同进程组，随 daemon 退出回收，
        // 不留独立进程占资源（win32 恒非 detached，见 HeadlessRunner）。
        detached: false,
        onSettle: (result) => this.settleRelay(entry.id, result),
      });
    } catch (err) {
      this.settleRelay(entry.id, {
        status: 'failed',
        output: null,
        error: err instanceof Error ? err.message : String(err),
      });
      return true; // 已落终态，视作启动过（调用方不再入队）
    }
  }

  /**
   * 中继终态：成功 = delivered（+message.delivered）；失败 = failed 留内存可见
   * （+message.finished），不自动重试（避免对活着但拒收的会话反复打中继）。
   */
  private settleRelay(messageId: string, result: HeadlessSettleResult): void {
    const msg = this.memory.get(messageId);
    if (!msg) return;
    // 中继退出 = 同会话中继闸释放：若还有积压，继续下一批（不必等下一次事件）
    if (this.queuedSessions.has(msg.sessionId)) this.scheduleFlushContinuation(msg.sessionId);
    if (result.status === 'succeeded') {
      this.memory.set(messageId, { ...msg, status: 'delivered' });
      this.bus({
        kind: 'message.delivered',
        messageId,
        sessionId: msg.sessionId,
        at: new Date().toISOString(),
      });
      return;
    }
    this.memory.set(messageId, {
      ...msg,
      status: 'failed',
      error: result.error ?? `prompt relay ${result.status}`,
    });
    this.bus({
      kind: 'message.finished',
      messageId,
      sessionId: msg.sessionId,
      status: 'failed',
      at: new Date().toISOString(),
    });
  }

  /** 层② 终端注入终态（语义同中继：成功 delivered / 失败 failed 可见）。 */
  private async runTerminalPrompt(messageId: string, paneId: string, text: string): Promise<void> {
    const msg = this.memory.get(messageId);
    if (!msg) return;
    const terminal = this.terminalChannel();
    if (!terminal) return;
    try {
      await terminal.sendText(paneId, text);
      this.memory.set(messageId, { ...msg, status: 'delivered' });
      this.bus({
        kind: 'message.delivered',
        messageId,
        sessionId: msg.sessionId,
        at: new Date().toISOString(),
      });
    } catch (err) {
      this.memory.set(messageId, {
        ...msg,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      this.bus({
        kind: 'message.finished',
        messageId,
        sessionId: msg.sessionId,
        status: 'failed',
        at: new Date().toISOString(),
      });
    }
  }

  /** inject 通道：信封写 outbox → injected（fire-and-forget 语义）。 */
  private deliverInject(
    entry: PipeMessage,
    token: string,
    meta: MessageMeta,
    surface: MessagingSurface,
  ): SendResult {
    const envelope = this.renderEnvelope(entry.text, meta, surface);
    appendOutbox(this.hooksDir, token, [{ sessionId: entry.sessionId, text: envelope }]);
    const msg: PipeMessage = { ...entry, status: 'injected' };
    this.memory.set(msg.id, msg);
    this.bus({
      kind: 'message.delivered',
      messageId: msg.id,
      sessionId: msg.sessionId,
      at: new Date().toISOString(),
    });
    return { ok: true, messageId: msg.id, status: 'injected', message: msg };
  }

  /** headless 通道：置 running → 无头 spawn；终态经 onSettle 后台回写。 */
  private deliverHeadless(
    entry: PipeMessage,
    cwd: string,
    meta: MessageMeta,
    surface: MessagingSurface,
  ): SendResult {
    const spec = surface.headless!;
    const msg: PipeMessage = { ...entry, status: 'running' };
    this.memory.set(msg.id, msg);
    const state = { settled: false };
    try {
      const started = this.headless.run({
        sessionId: msg.sessionId,
        cwd,
        prompt: this.renderEnvelope(msg.text, meta, surface),
        spec,
        bin: this.deps.bin ?? process.env.WEAVE_CLAUDE_BIN ?? spec.bin,
        timeoutMs: this.deps.timeoutMs,
        onSettle: (result) => this.settle(msg, state, result),
      });
      // isBusy 前置检查与本调用之间无 await（纯同步段），false 只是防御位：
      // 仍落 failed 留痕（消息可轮询），不 throw。
      if (!started) {
        this.settle(msg, state, {
          status: 'failed',
          output: null,
          error: 'Session already has a running run',
        });
      }
    } catch (err) {
      this.settle(msg, state, {
        status: 'failed',
        output: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { ok: true, messageId: msg.id, status: 'running', message: this.memory.get(msg.id)! };
  }

  /** 信封：面可覆写（harness 自己的表示法）；缺省 weave 通用头 + 正文。 */
  private renderEnvelope(text: string, meta: MessageMeta, surface: MessagingSurface): string {
    return surface.renderEnvelope?.(text, meta) ?? `[weave message] from=${meta.fromLabel} at=${meta.at} mode=${meta.mode}\n\n${text}`;
  }

  /** 终态落定（幂等，per-run state 守卫）：回写 → message.finished。 */
  private settle(
    msg: PipeMessage,
    state: { settled: boolean },
    result: HeadlessSettleResult,
  ): void {
    if (state.settled) return;
    state.settled = true;
    const current = this.memory.get(msg.id);
    if (!current) return;
    try {
      this.memory.set(msg.id, {
        ...current,
        status: result.status,
        output: result.output,
        error: result.error,
      });
      this.bus({
        kind: 'message.finished',
        messageId: msg.id,
        sessionId: msg.sessionId,
        status: result.status,
        at: new Date().toISOString(),
      });
    } catch {
      // settle 运行在后台事件回调里，不允许异常冒泡。
    }
  }

  private bus(message: Parameters<HookEventBus['emit']>[0]): void {
    try {
      this.deps.bus?.emit(message);
    } catch {
      // 广播失败不影响投递
    }
  }
}
