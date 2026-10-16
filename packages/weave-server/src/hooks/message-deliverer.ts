import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { WEAVE_INJECTION_MARKER, isHarness, type Harness } from '@weavecode/core';
import type { MessagingSurface, MessageMeta, PromptRelaySpec } from '@weavecode/harness';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { ProjectRepository } from '../repositories/projects.js';
import type { SessionRepository } from '../repositories/sessions.js';
import { messagingSurfaceFor } from '../surfaces.js';
import { normalizeDirKey, type SessionTerminal } from '../daemon/opener.js';
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
  /** 终态落定时刻（在途视图驻留窗口的起点；在途态无值）。 */
  settledAt?: string | null;
  /** 本条 = 该会话暂停闸的成因（未回执 / 投递失败）；重发或回执清除。 */
  stalled?: boolean;
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
  /**
   * 终端定位（hook 旁路上报的 pane env → pane id，**含存在性校验**：解析不出、
   * mux 或 pane 已不在 = null）。可缺省（老装配/无定位能力的终端 = 恒回落标题+cwd）。
   */
  locatePane?(env: Record<string, string>): Promise<string | null>;
  /**
   * 会话 → 所在可见屏幕（会话列表分块的数据面）。可缺省（无枚举能力的终端 =
   * 恒空表，那些会话不分组）；env 表批量进出（后端一次枚举摊平全部会话）。
   */
  locateScreens?(
    envs: Record<string, Record<string, string>>,
  ): Promise<Record<string, SessionTerminal | null>>;
  /** 往 pane 注入一段 prompt（原文 + 提交键）。 */
  sendText(paneId: string, text: string): Promise<void>;
  /** 裸键序注入（作答的选项键 / 中断的 ESC：模态框只吃键盘，不吃粘贴文本）。 */
  sendKeys(paneId: string, keys: string): Promise<void>;
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
  /** 终态驻留窗口（毫秒）；缺省 60s——delivered/injected/succeeded 短时留在在途
   *  视图展示 via/acked，过后消失（failed/timeout/暂停闸成因常驻）。 */
  visibleTtlMs?: number;
  /** 未回执闸窗口（毫秒）；缺省 120s——prompt 送达后没等到 UPS 回执即暂停该会话
   *  的队列冲洗（防继续向 Held/Refused 的会话灌消息），手动重发或回执解除。 */
  ackStallMs?: number;
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

/** answer() 返回（作答不建消息条目，无 messageId）。 */
export type AnswerResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

/** 通道裁决结果：mode=auto 落到实际通道后才存在。 */
type ResolvedChannel = 'prompt' | 'inject' | 'headless';

/** 中继进程的工作目录：中性 cwd，避开项目 hooks（spike 实测防幽灵事件）。 */
const relayCwd = () => tmpdir();

/** 冲洗节流（防 Claude Code 发送侧突发拒收）：一轮最多投递几条 + 条间最小间隔。 */
const FLUSH_PASS_MAX = 5;
const FLUSH_GAP_MS = 1_000;

/** 终态驻留窗口与未回执闸的缺省时长（见 deps 同名注入位）。 */
const VISIBLE_TTL_MS = 60_000;
const ACK_STALL_MS = 120_000;

/** 回执比对的最短文本（防「ok」这类短消息误配到别的在途条目）。 */
const ACK_MIN_TEXT = 8;

/** 刚删掉的队列行 id 保留多少条（冲洗的「先读盘 → 逐条投递」竞态闸，见 dismissedIds）。 */
const DISMISS_GUARD_MAX = 200;

/**
 * 作答键序白名单（安全闸）：逐个**原子**验形态——作答面不能变成任意键序注入
 * 通道（键序若打进已关的模态框会漏进输入框执行）。原子要么是宿主的键（选项
 * 序号 / Tab / 回车 / 下移），要么是自定义输入行的文本（无控制字符——CR/LF/ESC
 * 混进来就成了任意键序注入，不只是打字）。原子表本身由 harness 规格拼装
 * （选项 keys / textFocus / textTail），这里只验形态。
 */
const ANSWER_ATOM = /^(?:[1-9]|\t|\r|\x1b\[B)$/;
const ANSWER_TEXT = /^[^\x00-\x1f\x7f]*$/;

/** 中断键 = 一记 ESC（claude 里连打两次是历史回退菜单，故只打一记）。 */
const ESC = '\x1b';

/**
 * 原子之间的间隔（毫秒）：宿主把同一批到达的多个文本字符当成一次粘贴/过滤输入
 * （实机「11」被当筛选字串，一个选项都没选上），所以键序必须一次一个原子地写。
 * win32 上 `wezterm cli send-text` 每次调用本身就要 ~100ms（进程启动），实际间隔
 * 更大；这里给 POSIX（走 socket，调用毫秒级）兜底。
 */
const ANSWER_ATOM_GAP_MS = 120;

/**
 * socket 直投的来源标注（只作用于这条路径）：socket 消息是**裸 user 文本**
 * （会话看起来像用户自己敲的），标一句让转录以后能分辨「这不是我敲的」。
 * 实测（本机 2.1.296）不改变回复形态、不改变模型的发送者归属；它**给不了**
 * 系统级来源语义（那只有中继路径有：目标被明确告知「来自另一个会话」并受
 * 跨会话限制）。标记值来自 core 单一事实源——`weave init` 生成的 CLAUDE.md 块用
 * 同一个常量向会话解释它的含义（见 weave-cli/src/init/claudemd-gen.ts）。标记
 * **只**加在这一条路径：中继（CC 的 `<cross-session-message>` 壳）、终端
 * send-text（裸文本）、注入（additionalContext）都不带，别把「无标记」当
 * 「人打的」判据。
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
  /** 会话所在终端 pane 的定位 env（hook 旁路上报；纯内存，随会话走）。 */
  private readonly paneEnvs = new Map<string, Record<string, string>>();
  /** 已排自续冲洗的会话（防重复排拍）。 */
  private readonly flushScheduled = new Set<string>();
  /** 正在冲洗的会话（重入闸：异步冲洗 + 多条触发源，防同批行被投两次）。 */
  private readonly flushing = new Set<string>();
  /** 队列暂停闸（sessionId → 成因消息）：未回执超窗 / 投递失败即置；重发或回执解除。 */
  private readonly stalled = new Map<string, { messageId: string; reason: 'unacked' | 'failed' }>();
  /**
   * 刚删掉的队列行 id：冲洗「先把队列读进内存、再逐条投递」——这中间被删的行
   * 仍在手里那一批里，靠它跳过（否则删掉的消息照样发出去）。只兜这一个窗口，
   * 故只留最近 `DISMISS_GUARD_MAX` 条。
   */
  private readonly dismissedIds = new Set<string>();

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

  /**
   * 在途视图（GET /sessions/:id/messages）：promptbox 待递送 ∪ 内存态——
   * 在途（delivering/running）与 failed/timeout/暂停闸成因常驻；delivered/
   * injected/succeeded 在驻留窗口（visibleTtlMs）内展示 via/acked，过后消失
   * （历史在目标会话自己的转录里）。
   */
  listVisible(sessionId: string): PipeMessage[] {
    const ttl = this.deps.visibleTtlMs ?? VISIBLE_TTL_MS;
    const now = Date.now();
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
      if (msg.sessionId !== sessionId) continue;
      if (msg.stalled === true || msg.status === 'delivering' || msg.status === 'running') {
        out.push(msg);
        continue;
      }
      if (msg.status === 'failed' || msg.status === 'timeout') {
        out.push(msg);
        continue;
      }
      const settled = msg.settledAt ? Date.parse(msg.settledAt) : NaN;
      if (!Number.isNaN(settled) && now - settled < ttl) out.push(msg);
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
   * hook 旁路上报的会话 pane 定位 env（**每个 hook 事件覆盖刷新**：会话换 pane /
   * resume 到新窗口后，下一次事件就把定位改过来，与 inbox 凭据同一自愈口径）。
   */
  notePaneEnv(sessionId: string, env: Record<string, string>): void {
    this.paneEnvs.set(sessionId, env);
  }

  /**
   * 会话 → 所在可见屏幕（会话列表分块的数据面，只读）。旁路 env 与投递路径共用
   * 同一份缓存，不另采一次；后端没有反查能力 = 空表（那些会话不分组）。
   */
  async sessionTerminals(): Promise<Record<string, SessionTerminal | null>> {
    const terminal = this.terminalChannel();
    if (!terminal?.locateScreens || this.paneEnvs.size === 0) return {};
    return terminal.locateScreens(Object.fromEntries(this.paneEnvs));
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
      this.memory.set(msg.id, { ...msg, acked: true, stalled: false });
      // 回执命中暂停闸成因 → 闸解除：若还有积压，继续排空（不必等下一次事件）
      if (this.stalled.get(sessionId)?.messageId === msg.id) {
        this.stalled.delete(sessionId);
        if (this.queuedSessions.has(sessionId)) this.scheduleFlushContinuation(sessionId);
      }
      this.bus({
        kind: 'message.acknowledged',
        messageId: msg.id,
        sessionId,
        at: new Date().toISOString(),
      });
      return; // 一条 UPS 只核销一条在途（新→旧找第一条匹配）
    }
  }

  /** 未回执闸布防：prompt 送达后 ackStallMs 内没等到 UPS 回执 → 暂停该会话队列。 */
  private armAckWatch(msg: PipeMessage): void {
    const timer = setTimeout(
      () => {
        const current = this.memory.get(msg.id);
        if (!current || current.acked || current.status !== 'delivered') return;
        this.stall(current.sessionId, current, 'unacked');
      },
      this.deps.ackStallMs ?? ACK_STALL_MS,
    );
    timer.unref?.();
  }

  /** 置闸：成因消息标记 stalled（常驻在途视图）+ message.stalled 帧（web 重拉）。 */
  private stall(sessionId: string, msg: PipeMessage, reason: 'unacked' | 'failed'): void {
    this.stalled.set(sessionId, { messageId: msg.id, reason });
    const current = this.memory.get(msg.id);
    if (current) this.memory.set(msg.id, { ...current, stalled: true });
    this.bus({
      kind: 'message.stalled',
      messageId: msg.id,
      sessionId,
      reason,
      at: new Date().toISOString(),
    });
  }

  /**
   * 远程作答（阻塞式交互）：向目标会话所在 pane 发裸键序——模态框只吃键盘，
   * inbox/中继投递答不了。键序经白名单（`ANSWER_KEYS`）；pane 匹配复用层② 的
   * 标题 + cwd 判定（歧义/找不到 pane = 409，不去别的终端乱打）。成功由调用
   * 方乐观标记已答（PostToolUse 到达照常清除）。
   */
  async answer(sessionId: string, atoms: readonly string[]): Promise<AnswerResult> {
    // 首个原子必须是键：文本原子只能跟在「选中输入行」的键后面（拼装侧的不变量，
    // 这里再验一次——文本原子落在键位就是往会话里打任意文本）。
    if (
      atoms.length === 0 ||
      !ANSWER_ATOM.test(atoms[0]!) ||
      atoms.some((a) => !ANSWER_ATOM.test(a) && !ANSWER_TEXT.test(a))
    ) {
      return { ok: false, status: 400, error: 'Invalid answer keys' };
    }
    const target = await this.sessionKeysTarget(sessionId, 'Answering');
    if (!target.ok) return target;
    try {
      for (const [i, atom] of atoms.entries()) {
        if (i > 0) await sleep(ANSWER_ATOM_GAP_MS);
        await target.terminal.sendKeys(target.paneId, atom);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 中断目标会话正在跑的回合（dashboard 停止按钮）：往 pane 打**一记 ESC**。
   * 键序固定死在服务端（**不当参数收**）——这条通道一放开就是任意击键注入；
   * 且只打一记：claude 里 ESC 一次是中断，连打两次是开历史回退菜单。
   */
  async interrupt(sessionId: string): Promise<AnswerResult> {
    const target = await this.sessionKeysTarget(sessionId, 'Interrupting');
    if (!target.ok) return target;
    try {
      await target.terminal.sendKeys(target.paneId, ESC);
      return { ok: true };
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 键序注入路径（作答 / 中断）共用的落点解析：会话 → 项目 → 终端通道 → pane。
   * 全部失败原因是**可判定的语义拒绝**（404/409），调用方原样回给 HTTP。
   */
  private async sessionKeysTarget(
    sessionId: string,
    what: string,
  ): Promise<{ ok: true; terminal: PromptTerminal; paneId: string } | Extract<AnswerResult, { ok: false }>> {
    const session = this.deps.sessions.getBySessionId(sessionId);
    if (!session) return { ok: false, status: 404, error: 'Session not found' };
    if (session.projectId == null) {
      return { ok: false, status: 400, error: 'Session is not bound to a project' };
    }
    const project = this.deps.projects.getById(session.projectId);
    if (!project) return { ok: false, status: 404, error: 'Project not found' };
    const terminal = this.terminalChannel();
    if (!terminal) {
      return {
        ok: false,
        status: 409,
        error: `${what} needs a text-capable terminal (pick wezterm in settings)`,
      };
    }
    const pane = await this.terminalPaneFor(session, project);
    if (!pane) {
      return {
        ok: false,
        status: 409,
        error: 'Session pane not found — is the session window open?',
      };
    }
    return { ok: true, terminal, paneId: pane.id };
  }

  /**
   * 手动重发（暂停闸的解除动作）：prompt 通道 failed 或 delivered-未回执 的消息
   * 重走投递（socket → 中继 → 终端 → 队列），重发即解闸并重新布防回执闸。
   */
  async resend(messageId: string): Promise<SendResult> {
    const msg = this.memory.get(messageId);
    if (!msg) return { ok: false, status: 404, error: 'Message not found' };
    const resendable =
      msg.channel === 'prompt' &&
      (msg.status === 'failed' || (msg.status === 'delivered' && !msg.acked));
    if (!resendable) return { ok: false, status: 409, error: 'Message is not resendable' };
    const session = this.deps.sessions.getBySessionId(msg.sessionId);
    if (!session) return { ok: false, status: 404, error: 'Session not found' };
    if (session.projectId == null) {
      return { ok: false, status: 400, error: 'Session is not bound to a project' };
    }
    const project = this.deps.projects.getById(session.projectId);
    if (!project) return { ok: false, status: 404, error: 'Project not found' };
    const surface = this.surfaceOfSession(msg.sessionId);
    if (!surface) {
      return { ok: false, status: 400, error: 'Session has no hook events to determine its harness' };
    }
    if (this.stalled.get(msg.sessionId)?.messageId === messageId) this.stalled.delete(msg.sessionId);
    // 旧内存态先清：deliverPrompt 的活路径会重建；回落入队时同 id 不能双行
    // （内存 failed/delivered 行 + promptbox pending 行）。
    this.memory.delete(messageId);
    const entry: PipeMessage = { ...msg, status: 'pending', stalled: false, acked: false, settledAt: null };
    const result = await this.deliverPrompt(entry, session, project, surface);
    // created 放在在途状态建立之后（与 send() 同口径：它是在途角标重算的依据）
    this.bus({
      kind: 'message.created',
      messageId: entry.id,
      sessionId: entry.sessionId,
      mode: entry.mode,
      at: new Date().toISOString(),
    });
    return result;
  }

  /**
   * 删除一条在途视图里的消息行（dashboard「删除」）：内存行摘掉、队列待递送行
   * （pending 只活在 promptbox 文件里）删行——两种都不再出现在这个会话的对话尾巴上。
   * 内存行**不影响已投递的内容**（真到了会话，转录里的记录仍在）；队列行则是
   * **取消发送**（还没出去）。内存行若正是暂停闸的成因 → 一并解闸（否则闸留着却
   * 没有成因行可看、可操作），并续排空积压（下一条各自重新布防回执闸）。在飞
   * （delivering/running）的行不删：落定回调会把行写回来，删了也白删。
   */
  dismiss(sessionId: string, messageId: string): AnswerResult {
    const msg = this.memory.get(messageId);
    if (msg) {
      if (msg.status === 'delivering' || msg.status === 'running') {
        return { ok: false, status: 409, error: 'Message is still in flight' };
      }
      this.memory.delete(messageId);
      if (this.stalled.get(msg.sessionId)?.messageId === messageId) {
        this.stalled.delete(msg.sessionId);
        if (this.queuedSessions.has(msg.sessionId)) this.scheduleFlushContinuation(msg.sessionId);
      }
    } else if (!this.dropQueued(sessionId, messageId)) {
      return { ok: false, status: 404, error: 'Message not found' };
    }
    this.bus({
      kind: 'message.dismissed',
      messageId,
      sessionId,
      at: new Date().toISOString(),
    });
    return { ok: true };
  }

  /** 删掉队列里的一条待递送行（读到的行自己带 sessionId，配不上即不算命中）。 */
  private dropQueued(sessionId: string, messageId: string): boolean {
    const session = this.deps.sessions.getBySessionId(sessionId);
    if (session?.projectId == null) return false;
    const project = this.deps.projects.getById(session.projectId);
    if (!project) return false;
    const rows = readPromptbox(this.hooksDir, project.token);
    if (!rows.some((e) => e.id === messageId && e.sessionId === sessionId)) return false;
    removePromptboxEntries(this.hooksDir, project.token, new Set([messageId]));
    this.dismissedIds.add(messageId);
    while (this.dismissedIds.size > DISMISS_GUARD_MAX) {
      const oldest = this.dismissedIds.values().next().value;
      if (oldest === undefined) break;
      this.dismissedIds.delete(oldest);
    }
    if (!rows.some((e) => e.sessionId === sessionId && e.id !== messageId)) {
      this.queuedSessions.delete(sessionId);
    }
    return true;
  }

  /**
   * 队列冲洗（幂等）：直投命中即走；否则中继 / 终端按面定序（手动面终端优先）；
   * 都不行留队列。
   * **节流**（Claude Code 对同一会话的快速突发在发送侧拒收）：一轮最多 `FLUSH_PASS_MAX`
   * 条、条间至少 `flushGapMs`（中继路径本就被同会话中继闸天然间隔，终端路径没有，
   * 所以节流在这里统一兜）。超出的留队列，下轮触发（ingest / 刷新器）继续。
   */
  async flushSession(sessionId: string): Promise<void> {
    // 暂停闸：未回执超窗 / 投递失败——继续灌只会堆更多不可确认的消息，等重发或回执。
    if (this.stalled.has(sessionId)) return;
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
      // 本轮中途置闸（中继即败 / 终端注入失败都是异步落定）：立即停，余下留队列
      if (this.stalled.has(sessionId)) return;
      // 本轮读到之后被删掉的行（dashboard「删除」是取消发送）：跳过
      if (this.dismissedIds.has(entry.id)) continue;
      if (delivered >= FLUSH_PASS_MAX) {
        // 本轮量到：余下留队列，**自续下一拍**（socket 直投是毫秒级，不该等下一次事件）
        this.scheduleFlushContinuation(sessionId);
        return;
      }
      if (delivered > 0) await sleep(this.deps.flushGapMs ?? FLUSH_GAP_MS);
      const msg: PipeMessage = {
        id: entry.id,
        sessionId,
        text: entry.text,
        mode: 'prompt',
        oneWay: entry.oneWay === true,
        via: 'socket',
        channel: 'prompt',
        status: 'pending',
        at: entry.at,
      };
      // 层①-a 直投优先：冲洗正是被「刚上报凭据的那条 hook 事件」触发的（本机毫秒级、
      // 零进程零 LLM），队列里的手动面行不该绕过它直奔中继。
      if (surface && (await this.tryInboxDeliver(msg, surface))) {
        removePromptboxEntries(this.hooksDir, project.token, new Set([entry.id]));
        delivered++;
        continue;
      }
      const peer = relay?.resolve(sessionId) ?? null;
      // 层序同即时路径（手动面中继退最后）；本轮中继起不来就停轮，余行留队列。
      const layers: Array<'relay' | 'terminal'> = msg.oneWay === true ? ['terminal', 'relay'] : ['relay', 'terminal'];
      let handled = false;
      for (const layer of layers) {
        if (layer === 'relay' && relay && peer) {
          this.memory.set(msg.id, { ...msg, status: 'delivering', via: 'relay' });
          if (!this.runRelay(msg, relay, peer.name)) {
            // 同会话中继在途：本轮到此为止，剩余行留队列
            this.memory.delete(msg.id);
            return;
          }
          removePromptboxEntries(this.hooksDir, project.token, new Set([entry.id]));
          delivered++;
          handled = true;
          break;
        }
        if (layer === 'terminal' && this.terminalChannel()) {
          const pane = await this.terminalPaneFor(session, project);
          if (pane) {
            removePromptboxEntries(this.hooksDir, project.token, new Set([entry.id]));
            this.memory.set(msg.id, { ...msg, via: 'terminal', status: 'delivering' });
            await this.runTerminalPrompt(msg.id, pane.id, msg.text);
            delivered++;
            handled = true;
            break;
          }
        }
      }
      // 层均不可用（会话没开 / pane 找不到）：留队列等下轮触发
      if (!handled) return;
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
    this.stalled.delete(sessionId);
    this.inboxSockets.forget(sessionId); // 凭据随会话走（旧 socket 早已无效）
    this.paneEnvs.delete(sessionId); // pane 定位同样是会话生命周期内的旁路事实
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
        this.paneEnvs.delete(msg.sessionId);
        this.stalled.delete(msg.sessionId);
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

  /**
   * 目标会话的 pane：① **hook 旁路上报的终端定位**（精确——会话自己所在的 pane，
   * 与标题是否漂移无关，也覆盖从没上报过标题的会话；后端已做存在性校验）→
   * ② 回落「标题（剥 spinner 前缀，字符集含 ◐ 等输入等待态）+ 项目 cwd」启发式
   * （无定位能力的终端 / 老 hook），歧义拒绝不打。
   */
  private async terminalPaneFor(
    session: { sessionId: string; title: string | null },
    project: { path: string },
  ): Promise<{ id: string } | null> {
    const terminal = this.terminalChannel();
    if (!terminal) return null;
    const env = this.paneEnvs.get(session.sessionId);
    if (env) {
      const located = await terminal.locatePane?.(env).catch(() => null);
      if (located) return { id: located };
    }
    if (!session.title) return null;
    const want = session.title.replace(/^[✻✽✶✳✢⋅◦✦✧∘◐◑◒◓*]+\s*/, '');
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
        p.title.replace(/^[✻✽✶✳✢⋅◦✦✧∘◐◑◒◓*]+\s*/, '') === want &&
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
    const socketDelivered = await this.tryInboxDeliver(entry, surface);
    if (socketDelivered) {
      return { ok: true, messageId: entry.id, status: 'delivered', message: socketDelivered };
    }

    const relay = surface.prompt;
    const peer = relay?.resolve(entry.sessionId) ?? null;
    // 层序随面变：**手动面（oneWay）中继退到最后**——跨会话包裹与「无需回复」注记
    // 只是同义外壳，却要多起一个 headless 子进程；层② 终端注入才是裸 user 文本的
    // 同形态替代。编排域反之：那里的 @weave 身份正是要投递的东西。
    const layers: Array<'relay' | 'terminal'> = entry.oneWay === true ? ['terminal', 'relay'] : ['relay', 'terminal'];
    for (const layer of layers) {
      if (layer === 'relay' && relay && peer) {
        this.memory.set(entry.id, { ...entry, status: 'delivering', via: 'relay' });
        if (this.runRelay(entry, relay, peer.name)) {
          return { ok: true, messageId: entry.id, status: 'delivering', message: this.memory.get(entry.id)! };
        }
        // 同会话中继在途：落队列，下轮冲洗
        this.memory.delete(entry.id);
      }
      if (layer === 'terminal' && this.terminalChannel()) {
        const pane = await this.terminalPaneFor(session, project);
        if (pane) {
          this.memory.set(entry.id, { ...entry, status: 'delivering', via: 'terminal' });
          void this.runTerminalPrompt(entry.id, pane.id, entry.text);
          return { ok: true, messageId: entry.id, status: 'delivering', message: this.memory.get(entry.id)! };
        }
      }
    }
    this.queueEntry(entry, project.token);
    const pending: PipeMessage = { ...entry, status: 'pending' };
    return { ok: true, messageId: entry.id, status: 'pending', message: pending };
  }

  /**
   * 层①-a 直投尝试：成功返回落定后的内存行；回落（无面 / 非手动 / 无目标 / 写失败）
   * 返回 null。**队列冲洗也走它**——冲洗恰好由「刚上报凭据的那条 hook 事件」触发，
   * 命中率最高；队列绕过它直奔中继，手动面就会凭空多出跨会话包裹与英文注记。
   */
  private async tryInboxDeliver(entry: PipeMessage, surface: MessagingSurface): Promise<PipeMessage | null> {
    const spec = surface.promptInbox;
    const target = this.inboxSockets.get(entry.sessionId);
    if (!spec || entry.oneWay !== true || !target) return null;
    this.memory.set(entry.id, { ...entry, status: 'delivering', via: 'socket' });
    try {
      await deliverViaInboxSocket(spec, target, `${INBOX_SOURCE_PREFIX}${entry.text}`);
    } catch {
      // 凭据失效（resume 后 socket 名重生成等）：回落，不留痕
      this.memory.delete(entry.id);
      return null;
    }
    const delivered: PipeMessage = {
      ...this.memory.get(entry.id)!,
      status: 'delivered',
      via: 'socket',
      settledAt: new Date().toISOString(),
    };
    this.memory.set(entry.id, delivered);
    this.armAckWatch(delivered);
    this.bus({ kind: 'message.delivered', messageId: entry.id, sessionId: entry.sessionId, at: new Date().toISOString() });
    return delivered;
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
   * 中继终态：成功 = delivered（+message.delivered，布防回执闸；中继闸释放后若还有
   * 积压继续下一批）；失败 = failed 留内存可见（+message.finished）并置暂停闸——
   * 不自动重试（避免对活着但拒收的会话反复打中继），手动重发解除。
   */
  private settleRelay(messageId: string, result: HeadlessSettleResult): void {
    const msg = this.memory.get(messageId);
    if (!msg) return;
    if (result.status === 'succeeded') {
      // 中继退出 = 同会话中继闸释放：若还有积压，继续下一批（不必等下一次事件）
      if (this.queuedSessions.has(msg.sessionId)) this.scheduleFlushContinuation(msg.sessionId);
      const delivered: PipeMessage = {
        ...msg,
        status: 'delivered',
        settledAt: new Date().toISOString(),
      };
      this.memory.set(messageId, delivered);
      this.armAckWatch(delivered);
      this.bus({
        kind: 'message.delivered',
        messageId,
        sessionId: msg.sessionId,
        at: new Date().toISOString(),
      });
      return;
    }
    const failed: PipeMessage = {
      ...msg,
      status: 'failed',
      error: result.error ?? `prompt relay ${result.status}`,
      settledAt: new Date().toISOString(),
    };
    this.memory.set(messageId, failed);
    this.stall(msg.sessionId, failed, 'failed');
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
      const delivered: PipeMessage = { ...msg, status: 'delivered', settledAt: new Date().toISOString() };
      this.memory.set(messageId, delivered);
      this.armAckWatch(delivered);
      this.bus({
        kind: 'message.delivered',
        messageId,
        sessionId: msg.sessionId,
        at: new Date().toISOString(),
      });
    } catch (err) {
      const failed: PipeMessage = {
        ...msg,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        settledAt: new Date().toISOString(),
      };
      this.memory.set(messageId, failed);
      this.stall(msg.sessionId, failed, 'failed');
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
    const msg: PipeMessage = { ...entry, status: 'injected', settledAt: new Date().toISOString() };
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
        settledAt: new Date().toISOString(),
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
