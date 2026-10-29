import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isHarness, type Harness } from '@weavecode/core';
import {
  commandModeAt,
  turnOutputOf,
  type CommandInputMode,
  type CommandsSurface,
  type MessagingSurface,
  type MessageMeta,
  type PromptRelaySpec,
  type SideQuestionSpec,
} from '@weavecode/harness';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { ProjectRepository } from '../repositories/projects.js';
import type { SessionRepository } from '../repositories/sessions.js';
import { isImageMediaType } from '../repositories/uploads.js';
import { commandsSurfaceFor, messagingSurfaceFor } from '../surfaces.js';
import { pidAliveOf } from '../daemon/claude-liveness.js';
import { combinedLivenessOf } from '../daemon/liveness.js';
import type { SessionTerminal } from '../daemon/opener.js';
import type { HookEventBus } from './bus.js';
import { HeadlessRunner, type SpawnLike } from './headless-runner.js';
import { hooksRoot } from './mirror.js';
import { INBOX_TARGETS_FILE, InboxSocketRegistry, deliverViaInboxSocket } from './inbox-socket.js';
import { AckGate } from './delivery/ack-gate.js';
import {
  ANSWER_ATOM,
  ANSWER_ATOM_GAP_MS,
  ANSWER_TEXT,
  CTRL_C,
  ENTER,
  ESC,
  MODEL_NAME,
  SHIFT_TAB,
  effortCommand,
  effortLevelsOf,
  locateTerminalPane,
  modelCommand,
  sessionKeysTarget,
} from './delivery/keys.js';
import { hasImages, settleDelivered, spawnOnce, wireTextOf } from './delivery/channels.js';
import {
  deliverHeadless as deliverHeadlessIn,
  deliverInject as deliverInjectIn,
  resolveChannel as resolveChannelIn,
} from './delivery/send.js';
import {
  appendQueueEntry,
  failOffline as failOfflineIn,
  failQueuedOffline as failQueuedOfflineIn,
  sessionJudgedDead as sessionJudgedDeadIn,
} from './delivery/queue.js';
import { runRelay as runRelayIn, type RelayDeps } from './delivery/relay.js';
import {
  listInflightCounts as listInflightCountsIn,
  listVisible as listVisibleIn,
  sessionTerminals as sessionTerminalsIn,
} from './delivery/views.js';
import {
  readPromptbox,
  removePromptboxBySession,
  removePromptboxEntries,
  scanQueuedSessionIds,
  type PromptboxEntry,
} from './promptbox.js';

/**
 * 消息域投递器（消息域重塑：纯递送管道，非记录系统）——消息不落任何 DB 行，
 * 唯一归宿是目标会话自己的转录；weave 仅投递前短暂持有：
 *
 *   prompt  → 层①-a 会话本地 inbox socket 直投（harness 声明才可用；手动面排除）
 *             层① 原生 peer 消息中继（claude SendMessage，经受限 headless 进程）
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
 * 层③ 只收「还有可能送达」的行：三层全无通路且目标已判死（claude 注册表
 * `pidAlive === false`）时**不入队**，落 failed + `reason: 'offline'`（web 出中文
 * 说明）——死会话的队列行永远不会被取走，排在那里只是骗人。判不动（null）不猜，
 * 照旧入队。
 *
 * **同一会话严格按发送顺序投递**（顺序即真相：到达顺序错乱比慢一拍更糟）：
 * 队头还压着（上一条终端投递没回执 / 队列有积压 / 泵在推进）时新消息只入队尾，
 * 由冲洗泵一条条推进；终端层把一条贴进输入框后必须等它的 UPS 回执才发下一条
 * ——再贴一份会在同一个框里叠成一段，两条消息并成一条提交（直投/中继不压：
 * 交出去即进入会话自己的队列，会话按序处理）。
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

/** 随 prompt 投递的图（上传件引用；路径 = 落盘件的绝对路径，harness 合成引用形态）。 */
export interface MessageAttachment {
  id: string;
  name: string;
  mediaType: string;
  path: string;
}

/** 管道消息（内存态；发号 = uuid，全生命周期稳定）。 */
export interface PipeMessage {
  id: string;
  sessionId: string;
  /** **用户原文**（回执比对、气泡文案都用它）；投递出去的文本是它经 harness
   *  `attach.composePrompt` 合成的形态（带附件时追加引用），见 `wireTextOf`。 */
  text: string;
  /** 随附文件（空/缺省 = 纯文本消息）。 */
  attachments?: MessageAttachment[];
  mode: MessageMode;
  /** 单向注入（手动面：无接收方会话，中继载荷带「无需回复」注记）；编排域不置。 */
  oneWay?: boolean;
  /** 发送人强制层② 终端（层序收窄成只剩它，且重发沿用）。 */
  forceTerminal?: boolean;
  /** prompt 通道的实际落法（socket 直投 / 宿主队列 / 中继 / 终端 send-text）。 */
  via?: 'socket' | 'queue' | 'relay' | 'terminal';
  /** 投递回执：会话自己的 UserPromptSubmit 与本文匹配上了（真到达，非「已交给」）。 */
  acked?: boolean;
  /** 回执命中的那条开轮事件 id：对话面据此把投递行精确挂到它的气泡上（比比对
   *  原文可靠——重发只补的那记回车提交的是整个输入框，投递行记的原文与实际提交
   *  的文本可以不一样）。 */
  ackedEventId?: number | null;
  /** 终态落定时刻（在途视图驻留窗口的起点；在途态无值）。 */
  settledAt?: string | null;
  /** 本条 = 该会话暂停闸的成因（未回执 / 投递失败）；重发或回执清除。 */
  stalled?: boolean;
  /** 闸自动清除本行的时刻（只给「已发出却没回执」那种成因行）：到点行消失、队列续排。
   *  web 拿它走倒计时。 */
  releaseAt?: string | null;
  /** 判死而没投出去（会话进程不在、三层全无通路）：`failed` 的成因，web 据此出中文说明。 */
  reason?: 'offline';
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
  /**
   * 读 pane 可视屏文本（旁路会话读屏通道用）；可缺省（无读屏能力的装配 = 恒
   * null，侧问入口对读屏 harness 置灰）。
   */
  getPaneText?(paneId: string): Promise<string | null>;
  /** 关掉这个 pane（会话生命周期收尾）；无通道的后端明确拒绝。 */
  closePane(paneId: string): Promise<void>;
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
  /** 命令面访问器（测试注入）；缺省 surfaces.ts 模块级 registry——命令形态的
   *  触发符表由它答（`/` 斜杠命令、`!` bash 模式），投递闸按它分流回执窗口。 */
  commandsFor?: (harness: Harness) => CommandsSurface | null;
  /** 层② 终端 send-text 通道（装配侧按 TerminalBackend 能力注入；缺省无兜底）。 */
  terminal?: PromptTerminal;
  /** 冲洗节流：同一会话两次投递之间的最小间隔（毫秒）；缺省 1000。Claude Code 对
   *  同一会话的快速突发会在**发送侧**拒收（见 docs/plan/session-orchestration.md）。 */
  flushGapMs?: number;
  /** 终态驻留窗口（毫秒）；缺省 60s——delivered/injected/succeeded 短时留在在途
   *  视图展示 via/acked，过后消失（failed/timeout/暂停闸成因常驻）。 */
  visibleTtlMs?: number;
  /** 未回执闸窗口（毫秒）；缺省 30s——prompt 送达后没等到 UPS 回执即暂停该会话
   *  的队列冲洗（防继续向 Held/Refused 的会话灌消息），手动重发或回执解除。 */
  ackStallMs?: number;
  /** 闸自动解除窗口（毫秒）；缺省 90s——闸挂着而回执永远不来（消息其实丢了）时，
   *  队列不能就此停到天荒地老：到点把成因行落成 failed（`unacked`）并续排。 */
  ackStallReleaseMs?: number;
  /** 斜杠命令等回执的短窗口（毫秒）；缺省 5s——过了仍无 UPS 即按内建命令收。 */
  commandAckGraceMs?: number;
  /** 中断后读屏确认的等待（毫秒）；缺省 1.2s——没看到「已中断」就补一记 Ctrl+C。 */
  interruptVerifyMs?: number;
  /** 该会话此刻是否挂着阻塞式模态框（questions 槽；QuestionTracker 是唯一实现）。
   *  模态框在场时层② 的文本与回车会被它吃掉：投出去只换来一条「已发出却没回执」
   *  的假送达，回车还可能替用户按下某个选项。缺省 = 不判（测试与无 tracker 装配）。 */
  blockedByQuestion?: (sessionId: string) => boolean;
  /** 会话存活图（测试注入）；缺省合并图（claude 注册表 + codex 锁探针缓存）——
   *  同两个引擎（watch/sequence）的取法：判不动的会话一律「查不到」，不猜。 */
  livenessOf?: () => Map<string, boolean>;
  /** 读屏通道的回答落库（codex 侧问）：按 (sessionId, question) 找到待答行直更。
   *  缺省 = 无落库（读屏取到的回答只发帧不存档）。 */
  sideAnswerStore?: { answerById(sessionId: string, question: string, answer: string): void };
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
  /** 强制层② 终端 send-text（手动面下拉选的通道）：跳过直投与中继——宿主把
   *  终端击键当用户输入，另外两层都是「另一个会话发的」。 */
  forceTerminal?: boolean;
  /** 随附文件（已落盘的上传件）；目标 harness 的 `attach` 面不收该类型即 409。 */
  attachments?: readonly MessageAttachment[];
}

/** send() 返回：ok 由路由映射 200，否则 status 即 HTTP 码。 */
export type SendResult =
  | { ok: true; messageId: string; status: PipeStatus; message: PipeMessage }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** answer() 返回（作答不建消息条目，无 messageId）。 */
export type AnswerResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

/** 通道现况：ready = 现在就能投；unknown = 判不动（终端只剩标题/cwd 回落，被动面看不出来）。 */
interface ChannelState<R extends string> {
  status: 'ready' | 'unavailable' | 'unknown';
  reason: R | null;
}

/** 会话级投递诊断（`diagnose` 返回值；只含布尔与枚举，无凭据值）。 */
export interface SessionDeliveryDiagnosis {
  /** 存活三态（同 `pidAliveOf` 口径：判不动 = null）。 */
  alive: boolean | null;
  inbox: ChannelState<'no-mechanism' | 'no-credentials' | 'auth-token-required'>;
  queue: ChannelState<'no-mechanism'>;
  relay: ChannelState<'no-mechanism' | 'no-peer-name'>;
  terminal: ChannelState<'no-backend' | 'no-pane-env' | 'pane-env-conflict'>;
  /** 该会话有没有上报过 pane 定位 env。 */
  paneEnvReported: boolean;
  /** 队列里压着的行数。 */
  pending: number;
  /** 暂停闸是否已置（未回执超窗 / 投递失败）。 */
  stalled: boolean;
}

/** 通道裁决结果：mode=auto 落到实际通道后才存在。 */
type ResolvedChannel = 'prompt' | 'inject' | 'headless';

/** 中继进程的工作目录：中性 cwd，避开项目 hooks（spike 实测防幽灵事件）。 */

/** 自续冲洗的最小间隔（回执到达后接下一拍不该是同步连发）。 */
const FLUSH_GAP_MS = 1_000;

/** 终态驻留窗口与未回执闸的缺省时长（见 deps 同名注入位）。 */
const VISIBLE_TTL_MS = 60_000;
/** UPS 回执是宿主提交后即时产生的：半分钟等不到就不是「慢」而是「没进去」。 */
const ACK_STALL_MS = 30_000;
/** 闸到点自动解除——排队的消息等不起十分钟；用户也随时能手动清掉成因行。 */
const ACK_STALL_RELEASE_MS = 90_000;
/** 斜杠命令等回执的短窗口：内建命令永远不发 UPS，skill/插件命令 ~0.6s 就报。
 *  过了这个窗口还没回执 = 内建命令，按已送达收（不布防未回执闸）。 */
const COMMAND_ACK_GRACE_MS = 5_000;

/** 回执比对的最短文本（防「ok」这类短消息误配到别的在途条目）。 */
const ACK_MIN_TEXT = 8;

/** 同一 pane 定位的让位窗口：前持有者静默超过这个时长，后到者才接管（fork 继承同一
 *  env 时，旧会话还在跑就不让位——照投只会打进别人的终端）。 */
const PANE_CLAIM_HANDOVER_MS = 120_000;

/** 中断后读屏确认的等待（宿主把「已中断」摆上屏通常 <0.3s，留一拍余量）。 */
const INTERRUPT_VERIFY_MS = 1_200;
/** 屏上「已中断」的判据（宿主文案 `Interrupted · What should Claude do instead?`）。 */
const INTERRUPTED_SCREEN = /interrupted/i;
/** 屏上「还在跑」的判据（宿主状态行的 `esc to interrupt` 提示）。补完键再看一眼
 *  还有它 = 键被工具执行窗口吞了，如实回报，不假装停下来了。 */
const RUNNING_SCREEN = /esc to interrupt/i;

/** 等 inbox 凭据就位的轮询间隔（编排域「到达前启动 + socket 就绪」）。 */
const INBOX_READY_POLL_MS = 250;

/** 取「最近一条最终输出」往前回看几条事件：空回合（没有最终输出）要能跳过。 */
const TURN_OUTPUT_LOOKBACK = 5;

/** 判死落定时的技术性成因（用户可见的中文说明在 web，经 `reason` 标记译出）。 */

/** 刚删掉的队列行 id 保留多少条（冲洗的「先读盘 → 逐条投递」竞态闸，见 dismissedIds）。 */
const DISMISS_GUARD_MAX = 200;

/**
 * 作答键序白名单（安全闸）：逐个**原子**验形态——作答面不能变成任意键序注入
 * 通道（键序若打进已关的模态框会漏进输入框执行）。原子要么是宿主的键（选项
 * 序号 / Tab / 回车 / 下移 / 预览面的 `n` 备注键），要么是自定义输入行的文本
 * （无控制字符——CR/LF/ESC 混进来就成了任意键序注入，不只是打字）。原子表本身
 * 由 harness 规格拼装（选项 keys / textFocus / textTail），这里只验形态。
 */

/**
 * 命令形态的回执语义（触发符表归能力面，见 `CommandsSurface.inputModes`）：
 * 宿主内建命令（`/compact`、`/model`…）与 bash 模式由宿主自己执行、**不发
 * UserPromptSubmit**，而 skill/插件命令会把敲的那行原样报一条 UPS（实测 0.6s）。
 * 故不能一律当「无回执」收——统一走 `armCommandAck` 的短窗口：UPS 先到就正常
 * 核销，窗口过期还没来就按已执行收。
 */

/** pane 定位 env 落盘文件名（放 `<dataDir>/hooks/` 下，与 inbox 凭据同目录同口径）。 */
const PANE_ENVS_FILE = 'pane-envs.json';
const PENDING_ORIGINS_FILE = 'pending-origins.json';
/** 起点等到被认领的窗口：起完会话没人发消息 / rollout 采集失效就过期释放，不常驻。 */
const PENDING_ORIGIN_TTL_MS = 15 * 60_000;

/** 起点候选（weave 起会话的 spawn 回执）：sessionId 事后才知道（宿主自己生成），
 *  先按 (harness, projectId) 排队，ingest 侧认领。 */
interface PendingOrigin {
  harness: Harness;
  projectId: number;
  env: Record<string, string>;
  at: string;
}

/** 读盘上的起点候选：缺失 / 坏文件 / 值形不对一律视同没有；顺手剪过期。 */
function readPendingOrigins(file: string): PendingOrigin[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const out: PendingOrigin[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Partial<PendingOrigin>;
      if (
        !isHarness(o.harness) ||
        typeof o.projectId !== 'number' ||
        typeof o.env !== 'object' ||
        o.env === null ||
        typeof o.at !== 'string'
      ) {
        continue;
      }
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.env)) if (typeof v === 'string' && v) env[k] = v;
      if (Object.keys(env).length === 0) continue;
      out.push({ harness: o.harness, projectId: o.projectId, env, at: o.at });
    }
    return out.filter((o) => Date.now() - Date.parse(o.at) < PENDING_ORIGIN_TTL_MS);
  } catch {
    return [];
  }
}

/** 读盘上的 pane 定位 env：缺失 / 坏文件 / 值不是字符串表一律视同没有（靠 hook 事件补回来）。 */
function readPaneEnvs(file: string): Record<string, Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, Record<string, string>> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue;
      const env: Record<string, string> = {};
      for (const [key, v] of Object.entries(value)) if (typeof v === 'string' && v) env[key] = v;
      if (Object.keys(env).length > 0) out[sessionId] = env;
    }
    return out;
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 读屏通道的节拍（实测标定）：键序间隔、面板切换稳定窗、轮询间隔与预算。 */
const SIDE_STEP_GAP_MS = 300;
const SIDE_PANEL_SETTLE_MS = 1_500;
const SIDE_POLL_INTERVAL_MS = 1_000;
const SIDE_POLL_BUDGET_MS = 120_000;

export class MessageDeliverer {
  private readonly headless: HeadlessRunner;
  private readonly hooksDir: string;
  /** 读屏通道的回答落库（codex = /side；缺省无——回答只发帧不存档）。 */
  private readonly sideAnswerStore?: { answerById(sessionId: string, question: string, answer: string): void };
  /** 内存态注册表（pending 之后的生命周期）。 */
  private readonly memory = new Map<string, PipeMessage>();
  /** 有队列行的会话（ingest 冲洗守卫 + 刷新器探活索引；构造时从磁盘重建）。 */
  private readonly queuedSessions: Set<string>;
  /** 会话 inbox 直投目标（hook 旁路上报，落 `<dataDir>/hooks/inbox-targets.json` 0600）。 */
  private readonly inboxSockets: InboxSocketRegistry;
  /**
   * 会话所在终端 pane 的定位 env（hook 旁路上报）。落
   * `<dataDir>/hooks/pane-envs.json` 0600——**只解 daemon 自己的重启**：pane 活在
   * 会话终端里，重启不动它；不落盘的话重启后要等下一次 hook 事件才认回 pane，而
   * 长时间没动静的会话根本等不到，于是从终端分组里掉出去。
   */
  private readonly paneEnvs: Map<string, Record<string, string>>;
  /**
   * 定位已撤销的会话（会话退出）：pane env 已删、这轮扫描也探不到它，而拓扑
   * 合并契约是「缺席 = 保留上次分块」——不显式报 null，旧分块会永远留在快照里。
   * sessionTerminals() 报完即焚；会话再发事件（resume）会重新 notePaneEnv。
   */
  private readonly revokedPaneEnvs = new Set<string>();
  /**
   * sessionId → 占着同一 pane 定位的另一个会话（fork 继承同一份 env）：有值 =
   * 这个会话的终端定位不可信，投递/击键一律如实拒绝，绝不打进别人的终端。
   * 只在内存：重启后由下一个事件重新裁决（窗口内可能漏一次，可接受）。
   */
  private readonly paneEnvConflicts = new Map<string, string>();
  /** 上次落盘的 pane env（hook 每次事件都上报，值没变就不重写盘）。 */
  private persistedPaneEnvs: string;
  /**
   * 起点候选（weave 起会话的 spawn 回执）。paneEnvSource='launch' 的 harness
   * （codex）hook env 系统性失真，pane 定位改信这里——sessionId 事后才知道
   * （宿主自己生成），先按 (harness, projectId) 排队，ingest 侧认领（FIFO）。
   * 落盘同 pane-envs：只解 daemon 自己的重启。
   */
  private pendingOrigins: PendingOrigin[];
  private persistedPendingOrigins: string;
  /** 已排自续冲洗的会话（防重复排拍）。 */
  private readonly flushScheduled = new Set<string>();
  /**
   * 正在冲洗的会话（重入闸：异步冲洗 + 多条触发源，防同批行被投两次）。值是这一拍
   * 的令牌——强制移除卡住的那一行要就地解除泵闸，旧拍醒来时不能顺手把新拍的闸也
   * 删掉（两拍并行 = 同一行被投两次）。
   */
  private readonly flushing = new Map<string, symbol>();
  /** 队列暂停闸（sessionId → 成因消息）：未回执超窗 / 投递失败即置；重发或回执解除。 */
  private readonly stalled = new Map<string, { messageId: string; reason: 'unacked' | 'failed' }>();
  /**
   * 队头在等回执（sessionId → 消息 id）：层② 终端把一条贴进输入框后，下一条必须
   * 等它的 UPS 才发——再贴一份会在同一个框里叠成一段，两条消息并成一条提交。
   * 直投/中投不压（交出去即入会话自己的队列，会话按序处理）。
   */
  private readonly awaitingAck = new Map<string, string>();
  /**
   * 刚删掉的队列行 id：冲洗「先把队列读进内存、再逐条投递」——这中间被删的行
   * 仍在手里那一批里，靠它跳过（否则删掉的消息照样发出去）。只兜这一个窗口，
   * 故只留最近 `DISMISS_GUARD_MAX` 条。
   */
  private readonly dismissedIds = new Set<string>();
  /** 回执闸 + 暂停闸（判定与计时逻辑在 delivery/ack-gate.ts，状态仍在本类）。 */
  private readonly gate: AckGate;

  constructor(private readonly deps: MessageDelivererDeps) {
    this.headless =
      deps.headless ?? new HeadlessRunner({ spawnImpl: deps.spawnImpl, killImpl: deps.killImpl });
    this.hooksDir = deps.hooksDir ?? hooksRoot();
    this.sideAnswerStore = deps.sideAnswerStore;
    // 直投凭据落盘：**只解 daemon 自己的重启**（凭据活在会话进程里，重启不动它），
    // 会话自己重启/resume 换了 socket 靠下一次 hook 事件覆盖（连不上即回落）。
    this.inboxSockets = new InboxSocketRegistry(join(this.hooksDir, INBOX_TARGETS_FILE));
    const loadedPaneEnvs = readPaneEnvs(join(this.hooksDir, PANE_ENVS_FILE));
    this.paneEnvs = new Map(Object.entries(loadedPaneEnvs));
    this.persistedPaneEnvs = JSON.stringify(loadedPaneEnvs);
    this.pendingOrigins = readPendingOrigins(join(this.hooksDir, PENDING_ORIGINS_FILE));
    this.persistedPendingOrigins = JSON.stringify(this.pendingOrigins);
    this.queuedSessions = scanQueuedSessionIds(this.hooksDir);
    this.gate = new AckGate(
      { awaitingAck: this.awaitingAck, stalled: this.stalled, memory: this.memory },
      {
        ackStallMs: deps.ackStallMs ?? ACK_STALL_MS,
        ackStallReleaseMs: deps.ackStallReleaseMs ?? ACK_STALL_RELEASE_MS,
        commandAckGraceMs: deps.commandAckGraceMs ?? COMMAND_ACK_GRACE_MS,
      },
      { emit: (m) => this.bus(m as Parameters<HookEventBus['emit']>[0]) },
      (sessionId, text) => this.commandModeOf(sessionId, text) !== null,
    );
    this.gate.onAutoRelease = (sessionId) => this.scheduleFlushContinuation(sessionId);
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

    // 附件随 prompt 的对齐面归 harness（`attach`）：哪些类型收、怎么引用都由它答
    const attachments: MessageAttachment[] = input.attachments ? [...input.attachments] : [];
    if (attachments.length > 0) {
      if (!surface.attach) return { ok: false, status: 409, error: 'This harness cannot receive attachments' };
      if (attachments.some((a) => isImageMediaType(a.mediaType)) && !surface.attach.kinds.includes('image')) {
        return { ok: false, status: 409, error: 'This harness cannot receive images' };
      }
      if (attachments.some((a) => !isImageMediaType(a.mediaType)) && !surface.attach.kinds.includes('file')) {
        return { ok: false, status: 409, error: 'This harness cannot receive file attachments' };
      }
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
      ...(attachments.length > 0 ? { attachments } : {}),
      mode: input.mode,
      oneWay: input.oneWay === true,
      ...(input.forceTerminal === true ? { forceTerminal: true } : {}),
      channel,
      status: 'pending',
      at: meta.at,
    };
    // 队头还压着（等回执 / 有积压 / 泵在推进）→ 只能排到队尾：越过前面那条先投，
    // 到达顺序就和发送顺序不一致了（带图走终端、纯文本走直投在同一秒里就撞上）。
    const queuedAhead = channel === 'prompt' && this.blockedAhead(entry.sessionId);
    if (queuedAhead) {
      this.queueEntry(entry, project.token);
      this.scheduleFlushContinuation(entry.sessionId);
    }
    const result = queuedAhead
      ? { ok: true as const, messageId: entry.id, status: 'pending' as const, message: entry }
      : channel === 'inject'
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
   * （历史在目标会话自己的转录里）。例外 = **已送达还没回执**的：过了窗口也留着，
   * 它就是「还没落进对话」，等回执或未回执闸落定再说。
   */
  listVisible(sessionId: string): PipeMessage[] {
    return listVisibleIn(
      this.deps,
      this.hooksDir,
      this.memory,
      sessionId,
      this.deps.visibleTtlMs ?? VISIBLE_TTL_MS,
      (text) => this.commandModeOf(sessionId, text) !== null,
    );
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
    return listInflightCountsIn(this.hooksDir, this.memory);
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

  /** 等回执的那条已经落地（回执到 / 失败 / 行没了）→ 撤防，返回 true。 */
  private ackGateOpen(sessionId: string): boolean {
    return this.gate.open(sessionId);
  }

  /**
   * 队头是否还压着：上一条终端投递没回执 / 队列有积压 / 泵正在推进。
   * 是 → 新消息只能排到队尾；不是 → 立刻投（低延迟路径）。
   */
  private blockedAhead(sessionId: string): boolean {
    if (!this.ackGateOpen(sessionId)) return true;
    return this.queuedSessions.has(sessionId) || this.flushing.has(sessionId);
  }

  /**
   * hook 旁路上报的会话 inbox 目标（内存态；socket 空 = 该会话此刻不可直投）。
   * token 只在此存活，不落库、不进 UI、不写日志。
   */
  noteInboxSocket(sessionId: string, target: { socket: string; token: string | null } | null): void {
    this.inboxSockets.set(sessionId, target);
  }

  /**
   * 等会话的 inbox 凭据就位（投递方刚把会话拉起来时用）：凭据由会话自己的 hook
   * 进程随首个事件旁路上报，故按内存态轮询、到点即放弃。**只问有没有、不真连**
   * ——连不连得上由 `tryInboxDeliver` 现试现回落。机制缺席（无 `promptInbox`）或
   * 该平台要求 token 而凭据里没有 → 立刻 false，白等没有意义。
   */
  async awaitInboxReady(sessionId: string, timeoutMs: number): Promise<boolean> {
    const spec = this.surfaceOfSession(sessionId)?.promptInbox ?? null;
    if (!spec) return false;
    const ready = (): boolean => {
      const target = this.inboxSockets.get(sessionId);
      return !!target && (!spec.requiresAuthOn(process.platform) || !!target.token);
    };
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, INBOX_READY_POLL_MS));
    }
    return true;
  }

  /**
   * 会话最近一条「说出口的结论」（每轮收尾事件上带的最终输出，跳过空回合）：
   * 编排边「带上游输出」取用。只读既有 `hook_events`，不新落任何东西；读不到 → null。
   */
  lastTurnOutput(sessionId: string): { output: string; at: string } | null {
    const rows = this.deps.hookEvents.listBySession(sessionId, TURN_OUTPUT_LOOKBACK);
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      let payload: { raw?: unknown } | null = null;
      try {
        payload = JSON.parse(row.payload) as { raw?: unknown };
      } catch {
        continue;
      }
      const output = turnOutputOf(payload?.raw);
      if (output) return { output, at: row.createdAt };
    }
    return null;
  }

  /**
   * hook 旁路上报的会话 pane 定位 env（**每个 hook 事件覆盖刷新**：会话换 pane /
   * resume 到新窗口后，下一次事件就把定位改过来，与 inbox 凭据同一自愈口径）。
   *
   * **同一份 env 只归一个会话**：claude 的 fork 会让新会话继承旧会话的 pane env
   * （实测 pane 0 同时挂在 256de1f1 与 fork 出的 f59a061a 名下），照着投递就会把
   * 消息打进别人终端、而目标永远收不到。裁决 = 先到先得：前持有者还有活动就
   * 不让位（本会话记成冲突，投递/击键如实 409）；前持有者静默超过
   * `PANE_CLAIM_HANDOVER_MS` 才让位（那才是真的退出了）。
   */
  notePaneEnv(sessionId: string, env: Record<string, string>): void {
    const sig = JSON.stringify(env);
    for (const [other, otherEnv] of this.paneEnvs) {
      if (other === sessionId || JSON.stringify(otherEnv) !== sig) continue;
      const otherSeen = this.deps.sessions.getBySessionId(other)?.lastSeenAt;
      const quietMs = otherSeen ? Date.now() - Date.parse(otherSeen) : Number.POSITIVE_INFINITY;
      if (quietMs < PANE_CLAIM_HANDOVER_MS) {
        // 前持有者还活着：本会话不让位——env 不入表，避免把键打进别人的终端
        this.paneEnvs.delete(sessionId);
        this.paneEnvConflicts.set(sessionId, other);
        this.persistPaneEnvs();
        return;
      }
      this.paneEnvs.delete(other);
      this.revokedPaneEnvs.add(other);
    }
    this.paneEnvConflicts.delete(sessionId);
    this.paneEnvs.set(sessionId, env);
    this.revokedPaneEnvs.delete(sessionId); // 会话又活了（resume）：撤销作废
    this.persistPaneEnvs();
  }

  /** 该会话的终端定位是否被另一个会话占着（fork 继承同一 pane）；有值 = 不可投递。 */
  paneEnvConflictOf(sessionId: string): string | null {
    return this.paneEnvConflicts.get(sessionId) ?? null;
  }

  /**
   * 记一条起点候选（weave 起会话的 spawn 回执）。只为 paneEnvSource='launch'
   * 的 harness 而来（调用侧闸）：'hook' 的 harness env 精确，起点只会引入过期源。
   */
  notePendingOrigin(origin: { harness: Harness; projectId: number; env: Record<string, string> }): void {
    this.pendingOrigins = this.pendingOrigins.filter(
      (o) => Date.now() - Date.parse(o.at) < PENDING_ORIGIN_TTL_MS,
    );
    this.pendingOrigins.push({ ...origin, at: new Date().toISOString() });
    this.persistPendingOrigins();
  }

  /**
   * 认领起点候选：首个 (harness, projectId) 匹配的 FIFO 条目即该会话的 pane 定位
   * （notePaneEnv 全语义——分组、层② 定位同一份数据）。没有匹配 no-op：手动开的
   * 会话没有起点，不分组（与现状持平，不猜）。
   */
  claimPendingOrigin(sessionId: string, harness: Harness, projectId: number): void {
    const i = this.pendingOrigins.findIndex(
      (o) => o.harness === harness && o.projectId === projectId,
    );
    if (i < 0) return;
    const [claimed] = this.pendingOrigins.splice(i, 1);
    this.notePaneEnv(sessionId, claimed!.env);
    this.persistPendingOrigins();
  }

  /** 原子写（临时文件 + rename）+ 0600；失败静默（内存态照常能定位，下次再落）。 */
  private persistPaneEnvs(): void {
    const next = JSON.stringify(Object.fromEntries(this.paneEnvs));
    if (next === this.persistedPaneEnvs) return;
    const file = join(this.hooksDir, PANE_ENVS_FILE);
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${next}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, file);
      chmodSync(file, 0o600);
      this.persistedPaneEnvs = next;
    } catch {
      // 这条路径由 hook 事件驱动：落盘失败绝不能冒泡
    }
  }

  private persistPendingOrigins(): void {
    const next = JSON.stringify(this.pendingOrigins);
    if (next === this.persistedPendingOrigins) return;
    const file = join(this.hooksDir, PENDING_ORIGINS_FILE);
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${next}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, file);
      chmodSync(file, 0o600);
      this.persistedPendingOrigins = next;
    } catch {
      // 同 persistPaneEnvs：落盘失败绝不能冒泡
    }
  }

  /**
   * 会话退出（`SessionEnd` 到达）：旁路事实随进程作废——inbox 凭据出盘（旧 socket
   * 已死，留着只会让下一次投递白试一轮）、pane 定位清（窗口随会话关）。**会话行与
   * 它的对话照常保留**（那是历史，不是旁路事实），所以不走 `forgetSession` 的删会话
   * 级联；压队的行此刻也已成死信 → 一并按 offline 落定（同 A 的口径）。
   */
  sessionExited(sessionId: string): void {
    this.inboxSockets.forget(sessionId);
    this.paneEnvs.delete(sessionId);
    // 定位撤销要显式报给拓扑快照（sessionTerminals 回 null 摘出终端分组）：
    // 只删 env 的话，快照里上次扫到的分块按「缺席 = 保留」契约永远留着。
    this.revokedPaneEnvs.add(sessionId);
    this.persistPaneEnvs();
    this.awaitingAck.delete(sessionId); // 进程没了，这一条的回执再也不会到
    const session = this.deps.sessions.getBySessionId(sessionId);
    const project = session?.projectId == null ? null : this.deps.projects.getById(session.projectId);
    if (!project) return;
    const entries = readPromptbox(this.hooksDir, project.token).filter((e) => e.sessionId === sessionId);
    this.failQueuedOffline(
      sessionId,
      entries.filter((e) => !this.dismissedIds.has(e.id)),
    );
  }

  /**
   * 会话 → 所在可见屏幕（会话列表分块的数据面）。旁路 env 与投递路径共用同一份
   * 缓存，不另采一次；后端没有反查能力 = 空表（那些会话不分组）。顺手摘掉已判死
   * 会话的 env：那是上一次见到它时的快照，它不会再来报一次，留着只会让死会话常占块头。
   */
  async sessionTerminals(): Promise<Record<string, SessionTerminal | null>> {
    return sessionTerminalsIn(
      this.deps,
      this.terminalChannel(),
      this.paneEnvs,
      () => this.persistPaneEnvs(),
      this.revokedPaneEnvs,
    );
  }

  /**
   * 会话级投递诊断（只读内存态 + 既有 repo，纯现算）：三通道各自「现在能不能投」
   * + 队列积压/暂停闸。判定条件集就是投递路径的可用前提，不另立第二份事实源。
   *
   * 只回布尔与枚举——**socket 地址与 token 永不出栈**（与「凭据不进 UI/日志」同口径）。
   */
  diagnose(sessionId: string): SessionDeliveryDiagnosis {
    const surface = this.surfaceOfSession(sessionId);
    const row = this.deps.sessions.livenessRowOf(sessionId);
    const alive = row ? pidAliveOf(row, this.deps.livenessOf?.() ?? combinedLivenessOf()) : null;

    const inboxSpec = surface?.promptInbox ?? null;
    const target = this.inboxSockets.get(sessionId);
    const inbox: SessionDeliveryDiagnosis['inbox'] = !inboxSpec
      ? { status: 'unavailable', reason: 'no-mechanism' }
      : !target
        ? { status: 'unavailable', reason: 'no-credentials' }
        : inboxSpec.requiresAuthOn(process.platform) && !target.token
          ? { status: 'unavailable', reason: 'auth-token-required' }
          : { status: 'ready', reason: null };

    const queue: SessionDeliveryDiagnosis['queue'] = !surface?.queuedPrompt
      ? { status: 'unavailable', reason: 'no-mechanism' }
      : { status: 'ready', reason: null };

    const peer = surface?.prompt?.resolve(sessionId) ?? null;
    const relay: SessionDeliveryDiagnosis['relay'] = !surface?.prompt
      ? { status: 'unavailable', reason: 'no-mechanism' }
      : peer
        ? { status: 'ready', reason: null }
        : { status: 'unavailable', reason: 'no-peer-name' };

    const paneEnvReported = this.paneEnvs.has(sessionId);
    const terminal: SessionDeliveryDiagnosis['terminal'] = !this.terminalChannel()
      ? { status: 'unavailable', reason: 'no-backend' }
      : paneEnvReported
        ? { status: 'ready', reason: null }
        : this.paneEnvConflicts.has(sessionId)
          ? { status: 'unavailable', reason: 'pane-env-conflict' }
          : { status: 'unknown', reason: 'no-pane-env' };

    const session = this.deps.sessions.getBySessionId(sessionId);
    const project = session?.projectId == null ? null : this.deps.projects.getById(session.projectId);
    const pending = project
      ? readPromptbox(this.hooksDir, project.token).filter((e) => e.sessionId === sessionId).length
      : 0;

    return {
      alive,
      inbox,
      queue,
      relay,
      terminal,
      paneEnvReported,
      pending,
      stalled: this.gate.isStalled(sessionId),
    };
  }

  /**
   * 投递回执：会话自己的 UserPromptSubmit 到了 —— 其 prompt 原文与在途条目匹配
   * 即成真（`acked`）。中继/终端/socket 三路通用（中继的原文外面裹着 Claude Code
   * 自己的 `<cross-session-message …>` 壳，比对时归一掉）。返回命中消息的随附图
   * id（调用方挂到开轮事件上做气泡缩略图；空表 = 命中但没图 / 没命中）。
   *
   * 带图的消息比对放宽：claude 的粘贴处理器把图路径从 prompt 剥掉、还会把多行
   * 文本 chunk 用空串连起来，`msg.text` 与 UPS 原文可能对不上——对不上不代表
   * 没送达，按「去空白后相同」再认一次；纯图发送（无用户文本）的 UPS prompt 是
   * 空的 / 只剩 `[Image #N]`，无文本可比，这样一条 UPS 认领最新那条纯图在途。
   *
   * `eventId` = 这条 UPS 自己的事件 id：命中即记下来，对话面据此把投递行精确挂到
   * 对应气泡上（见 `PipeMessage.ackedEventId`）。
   */
  onSessionPrompt(sessionId: string, prompt: string, eventId?: number): string[] {
    const imageIds = this.gate.acknowledge(sessionId, prompt, eventId, { ackMinText: ACK_MIN_TEXT });
    // 还有积压就继续排空（不必等下一次事件）
    if (this.gate.hitLast && this.queuedSessions.has(sessionId)) {
      this.scheduleFlushContinuation(sessionId);
    }
    return imageIds;
  }

  /**
   * 活动旁证：该会话来了任何 hook 事件 = 宿主活着且在干活。内建命令（`/compact`
   * 之类）没有 UPS 回执，命令行「已发出」的翻牌就靠它——宿主受理命令后的第一笔
   * 事件（PreCompact…）及时把行翻成已回执（5s 短窗口只是兜底）。普通文本行有
   * UPS 正路，不掺和。
   */
  noteActivity(sessionId: string): void {
    if (this.gate.noteActivity(sessionId)) {
      // 翻牌即解闸：队头在等的那条已落定，续排排空积压
      if (this.queuedSessions.has(sessionId)) this.scheduleFlushContinuation(sessionId);
    }
  }

  /** 未回执闸布防（判定与计时在 delivery/ack-gate.ts）。 */
  private armAckWatch(msg: PipeMessage): void {
    this.gate.armAckWatch(msg);
  }

  /** 斜杠命令的回执收尾（短窗口；内建命令不发 UPS）。 */
  private armCommandAck(messageId: string): void {
    this.gate.armCommandAck(messageId, (sessionId) => {
      if (this.queuedSessions.has(sessionId)) this.scheduleFlushContinuation(sessionId);
    });
  }

  /** 置闸（成因消息标记 stalled + message.stalled 帧）。 */
  private stall(sessionId: string, msg: PipeMessage, reason: 'unacked' | 'failed'): void {
    this.gate.stall(sessionId, msg, reason);
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
    const target = await this.sessionKeysTarget(sessionId);
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
   * 中断目标会话正在跑的回合（dashboard 停止按钮）：先打**一记 ESC**，
   * 读屏确认没停再补一记 **Ctrl+C**。
   *
   * 为什么要有补打（2026-10-29 实测，推翻「键送出即必然中断」的旧口径）：
   * 宿主在**工具执行/收尾窗口**里会吞掉注入的 ESC（同一会话三次实测两次没停，
   * 而模型生成中那一记立刻生效；TUI 手按在同一窗口能停），而 ESC 送出本身
   * 照样 exit 0 —— 只发一记就会出现「点了没反应」。补打**换键**而不是再发 ESC：
   * 两记 ESC 在 claude 里是历史回退菜单。读屏拿不到（无读屏能力的后端）就不补，
   * 不凭猜打第二记。键序固定死在服务端，不当参数收。
   *
   * 补完**再看一眼屏**：宿主状态行还挂着 `esc to interrupt` 就答 `confirmed:false`
   * ——工具执行窗口里两记都会被吞（2026-10-30 实测四次全无反应），这时按键层
   * 没有更强的招，只能让 UI 把「没停」如实说出来，不摆成功态。
   */
  async interrupt(
    sessionId: string,
  ): Promise<
    | { ok: true; paneId: string; sent: boolean; confirmed: boolean }
    | Extract<AnswerResult, { ok: false }>
  > {
    const target = await this.sessionKeysTarget(sessionId, '击键');
    if (!target.ok) return target;
    const readScreen = async (): Promise<string | null> => {
      try {
        return (await target.terminal.getPaneText?.(target.paneId)) ?? null;
      } catch {
        return null;
      }
    };
    try {
      await target.terminal.sendKeys(target.paneId, ESC);
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
    await sleep(this.deps.interruptVerifyMs ?? INTERRUPT_VERIFY_MS);
    const screen = await readScreen();
    // 读不到屏（后端没这个通道）/ 屏上已经写着 Interrupted：这一记就够了
    if (screen === null || INTERRUPTED_SCREEN.test(screen)) {
      return { ok: true, paneId: target.paneId, sent: true, confirmed: true };
    }
    try {
      await target.terminal.sendKeys(target.paneId, CTRL_C);
    } catch {
      // 第一记已经送出：补打失败不改变「已送出停止」的答复
    }
    // 补完再看一眼：状态行还挂着 `esc to interrupt` = 两记都被吞了（2026-10-30
    // 实测：Bash 工具执行窗口里连按四次 ESC + Ctrl+C 全无反应，工具跑满自己的
    // 超时才收）。确认不了（读不到屏）就往好处答，不让 UI 凭空报「没停」。
    const after = await readScreen();
    return {
      ok: true,
      paneId: target.paneId,
      sent: true,
      confirmed: after === null || !RUNNING_SCREEN.test(after),
    };
  }

  /**
   * 关掉会话所在的 pane（会话生命周期收尾）：宿主随 pane 一起退出——这是「退出
   * 会话」的远程等价（harness 没有「请退出」这种信号）。**会话行与它的对话照常
   * 保留**（那是历史，同 SessionEnd 口径），只把它从「活着」的世界里摘出去。
   */
  async closePane(sessionId: string): Promise<AnswerResult> {
    const target = await this.sessionKeysTarget(sessionId, '关闭');
    if (!target.ok) return target;
    try {
      await target.terminal.closePane(target.paneId);
      return { ok: true };
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 执行模式切换（Shift+Tab 的远程等价）：一记固定键，宿主自己算下一个模式。
   * 答「现在是哪个模式」不由这里管——Shift+Tab 不发任何 hook 事件、不落转录，
   * 实时态只能是 hook 事件里最近一次的 `permission_mode`（「最后已知」）。
   */
  async cycleMode(sessionId: string): Promise<AnswerResult> {
    const target = await this.sessionKeysTarget(sessionId);
    if (!target.ok) return target;
    try {
      await target.terminal.sendKeys(target.paneId, SHIFT_TAB);
      return { ok: true };
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 手动提交（Enter 键帽）：往 pane 打一记回车，提交宿主输入框里现成的内容。
   * 与层② 自动补打同一字节、同一语义——**提交的是整个输入框**，框里若有别的东西
   * 会一起出去，这是盲打回车的固有风险，键帽 tooltip 如实说明。
   */
  async pressEnter(sessionId: string): Promise<AnswerResult> {
    const target = await this.sessionKeysTarget(sessionId);
    if (!target.ok) return target;
    try {
      await target.terminal.sendKeys(target.paneId, ENTER);
      return { ok: true };
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 手动硬中断（Ctrl+C 键帽）：往 pane 打一记 Ctrl+C。与 ESC 不同——它是宿主
   * TUI 的硬中断（杀当前行/退出输入态），不落转录标记，「停没停」判不了，只报送出。
   */
  async pressCtrlC(sessionId: string): Promise<AnswerResult> {
    const target = await this.sessionKeysTarget(sessionId);
    if (!target.ok) return target;
    try {
      await target.terminal.sendKeys(target.paneId, CTRL_C);
      return { ok: true };
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 模型切换：往会话的输入行打宿主自己的 `/model <名>` 并提交（会话级、不落盘）。
   * 名字是**用户自填**的（网关模型 ID 会增删，不做静态映射表），故只验形态不验
   * 词表——宿主对未知名自己回 `Unknown model '…'`，那句话进会话转录、用户看得见。
   */
  async setModel(sessionId: string, name: string): Promise<AnswerResult> {
    const trimmed = name.trim();
    if (!MODEL_NAME.test(trimmed)) {
      return { ok: false, status: 400, error: '模型名形态不合法（不含空白与控制字符，≤128 字符）' };
    }
    const target = await this.sessionKeysTarget(sessionId);
    if (!target.ok) return target;
    try {
      await target.terminal.sendText(target.paneId, modelCommand(trimmed));
      return { ok: true };
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 思考强度调整：往会话的输入行打宿主自己的 `/effort <档位>` 并提交。档位过
   * **词表白名单**（core 表该 harness 的 `effortLevels`）——封闭枚举，表外 400
   * 不打键；模型能力差异宿主自己降档并回报（事件自带 `effort.level` 纠正显示）。
   */
  async setEffort(sessionId: string, level: string): Promise<AnswerResult> {
    const trimmed = level.trim();
    // 落点判定在前（404/409 优先于 400）：会话都不存在时谈档位没有意义
    const target = await this.sessionKeysTarget(sessionId);
    if (!target.ok) return target;
    const levels = effortLevelsOf(this.deps.hookEvents, sessionId);
    if (!levels.includes(trimmed)) {
      return { ok: false, status: 400, error: `思考强度档位不合法（可选：${levels.join(' / ') || '无'}）` };
    }
    try {
      await target.terminal.sendText(target.paneId, effortCommand(trimmed));
      return { ok: true };
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 旁路会话：问句经层② 终端打进会话 pane。两条通道按能力面分流——
   * - **事件认领**（claude = `/btw`）：宿主的侧问只活在 TUI 里，也不落任何文件，
   *   终端击键是唯一通道；回答是之后的一条采集事件（认领见 `hooks/side-questions.ts`）。
   * - **读屏**（codex = `/side`）：宿主侧边会话 ephemeral（零落盘、零 hook 事件），
   *   开面板 → 发问句 → 轮询读屏 → 关面板，回答同步取回（`pollScreenAnswer`）。
   *
   * 返回归一化后的问句（已过 harness 的形态校验）：调用方据此落历史行。
   */
  async askSideQuestion(
    sessionId: string,
    question: string,
  ): Promise<{ ok: true; question: string } | { ok: false; status: 400 | 404 | 409; error: string }> {
    if (!this.deps.sessions.getBySessionId(sessionId)) {
      return { ok: false, status: 404, error: 'Session not found' };
    }
    const surface = this.surfaceOfSession(sessionId);
    const spec = surface?.sideQuestion ?? null;
    if (!spec) {
      return {
        ok: false,
        status: 409,
        error:
          surface?.unsupportedReasons?.sideQuestion ??
          '这个 harness 没有旁路会话通道',
      };
    }
    const valid = spec.validate(question);
    if (!valid.ok) return { ok: false, status: 400, error: valid.error };
    if (spec.prerequisite && this.deps.sessions.hasRunOf(sessionId) !== true) {
      return { ok: false, status: 409, error: spec.prerequisite };
    }
    const target = await this.sessionKeysTarget(sessionId, '发起旁路会话');
    if (!target.ok) return target;
    try {
      if (spec.screen) {
        this.pollScreenAnswer(sessionId, target.terminal, target.paneId, spec, valid.text);
        return { ok: true, question: valid.text };
      }
      await target.terminal.sendText(target.paneId, spec.command(valid.text));
      return { ok: true, question: valid.text };
    } catch (err) {
      return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 读屏通道的执行体（fire-and-forget：POST 先回、行先落 pending，回答到了经
   * `sideQuestion.answered` 帧推给前端）。时序全部实测钉死（2026-10-27）：
   * 开面板的 CR 常被吃 → 发完验屏、没开成补一发再验；**收尾前必须确认面板还
   * 开着**——用户中途关掉后，closeKey 落主线程语境（忙 = 中断确认菜单、闲 =
   * 退出 TUI），盲打比不收尾糟得多，面板不在就什么都不发。
   */
  private pollScreenAnswer(
    sessionId: string,
    terminal: PromptTerminal,
    paneId: string,
    spec: SideQuestionSpec,
    question: string,
  ): void {
    const screen = spec.screen!;
    const readScreen = async (): Promise<string | null> =>
      (await terminal.getPaneText?.(paneId).catch(() => null)) ?? null;
    void (async () => {
      const before = (await readScreen()) ?? '';
      // 开面板：CR 常被吃（实测），发完验屏、没开成补一发再验
      await terminal.sendKeys(paneId, screen.openKeys).catch(() => {});
      await sleep(SIDE_STEP_GAP_MS);
      await terminal.sendKeys(paneId, screen.submitKey).catch(() => {});
      await sleep(SIDE_PANEL_SETTLE_MS);
      let now = await readScreen();
      if (!now || !screen.panelOpen(now)) {
        await terminal.sendKeys(paneId, screen.submitKey).catch(() => {});
        await sleep(SIDE_PANEL_SETTLE_MS);
        now = await readScreen();
        if (!now || !screen.panelOpen(now)) return; // 面板开不成：放弃（不发问句，防落主线程）
      }
      // 问句进面板输入框并提交
      await terminal.sendText(paneId, question).catch(() => {});
      await sleep(SIDE_STEP_GAP_MS);
      await terminal.sendKeys(paneId, screen.submitKey).catch(() => {});
      // 轮询读屏取回答
      const deadline = Date.now() + SIDE_POLL_BUDGET_MS;
      let answer: string | null = null;
      while (Date.now() < deadline) {
        await sleep(SIDE_POLL_INTERVAL_MS);
        now = await readScreen();
        if (now == null) return; // pane 没了：静默放弃（行由超窗落 timeout）
        const got = screen.extractAnswer(question, before, now);
        if (!got.done) continue;
        answer = got.answer;
        break;
      }
      if (answer != null) {
        this.sideAnswerStore?.answerById(sessionId, question, answer);
        this.bus({ kind: 'sideQuestion.answered', sessionId, at: new Date().toISOString() } as never);
      }
      // 收尾：面板还开着才关（用户中途关掉后盲打 ctrl+c 会砸菜单/退 TUI）
      const final = await readScreen();
      if (final && screen.panelOpen(final)) {
        await terminal.sendKeys(paneId, screen.closeKey).catch(() => {});
      }
    })();
  }

  private async sessionKeysTarget(
    sessionId: string,
    action = '击键',
  ): Promise<{ ok: true; terminal: PromptTerminal; paneId: string } | Extract<AnswerResult, { ok: false }>> {
    return sessionKeysTarget(this.keysDeps(), sessionId, action);
  }

  /** bus 可选 → 必选形状（delivery 模块的入参）。 */
  private busSafe(): Pick<HookEventBus, 'emit'> {
    return {
      emit: (m) => this.bus(m as Parameters<HookEventBus['emit']>[0]),
    };
  }

  /** 层① 通道尝试的依赖切片（delivery/channels.ts 的入参形状）。 */
  private channelDeps() {
    return {
      setMemory: (msg: PipeMessage) => this.memory.set(msg.id, msg),
      deleteMemory: (messageId: string) => this.memory.delete(messageId),
      awaitAck: (sessionId: string, messageId: string) => this.gate.await(sessionId, messageId),
      commandModeOf: (text: string, sessionId: string) => this.commandModeOf(sessionId, text),
      armAckWatch: (msg: PipeMessage) => this.gate.armAckWatch(msg),
      armCommandAck: (messageId: string) =>
        this.gate.armCommandAck(messageId, (sessionId) => {
          if (this.queuedSessions.has(sessionId)) this.scheduleFlushContinuation(sessionId);
        }),
      emit: (m: { kind: string; [key: string]: unknown }) =>
        this.bus(m as Parameters<HookEventBus['emit']>[0]),
      ...(this.deps.spawnImpl ? { spawnImpl: this.deps.spawnImpl } : {}),
    };
  }

  /** 投递文本合成（delivery/channels.ts 的纯函数，绑本类的面解析）。 */
  private wireTextOfEntry(entry: PipeMessage): string {
    return wireTextOf(entry, (sessionId) => this.surfaceOfSession(sessionId));
  }

  /** 有没有图（delivery/channels.ts 的纯函数）。 */
  private hasImagesEntry(entry: PipeMessage): boolean {
    return hasImages(entry);
  }

  /** 键序域的依赖切片（delivery/keys.ts 的入参形状）。 */
  private keysDeps() {
    return {
      sessions: this.deps.sessions,
      projects: this.deps.projects,
      hookEvents: this.deps.hookEvents,
      terminalChannel: () => this.terminalChannel(),
      terminalPaneFor: (session: { sessionId: string; title: string | null }, project: { path: string }) =>
        this.terminalPaneFor(session, project),
      paneEnvConflictOf: (sessionId: string) => this.paneEnvConflictOf(sessionId),
    };
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
    this.gate.clearStall(msg.sessionId, messageId);
    // 层② 已把文本贴进输入框、回执却没到 = 那记回车没生效（本次实机：贴着图的长
    // 文本连贴两次都没提交，第三次才连前三份一起提交）。此时重发**只补回车**：
    // 重贴一份会让用户收到两遍正文与两遍图。
    if (msg.status === 'delivered' && msg.via === 'terminal' && this.terminalChannel()) {
      const pane = await this.terminalPaneFor(session, project);
      if (pane) {
        this.memory.set(messageId, { ...msg, status: 'delivering', stalled: false, settledAt: null });
        void this.runTerminalSubmit(messageId, pane.id);
        this.bus({
          kind: 'message.created',
          messageId,
          sessionId: msg.sessionId,
          mode: msg.mode,
          at: new Date().toISOString(),
        });
        return { ok: true, messageId, status: 'delivering', message: this.memory.get(messageId)! };
      }
    }
    // 旧内存态先清：deliverPrompt 的活路径会重建；回落入队时同 id 不能双行
    // （内存 failed/delivered 行 + promptbox pending 行）。
    this.memory.delete(messageId);
    // reason/error 是上一轮判死的落定，重发即作废：留着会让「会话未运行」的说明
    // 跟着一条正在重投的行继续显示。
    const entry: PipeMessage = {
      ...msg,
      status: 'pending',
      stalled: false,
      acked: false,
      settledAt: null,
      reason: undefined,
      error: null,
    };
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
   * 没有成因行可看、可操作），并续排空积压（下一条各自重新布防回执闸）。
   *
   * **在飞的投递行（delivering）也能强制移除**：投递卡住（后端不回）时它就是队头，
   * 压着后面每一条都发不出去，闸/行都不给人动手就永远解不开。落定回调按「当前行」
   * 收尾、行没了即返回（见 `runTerminal`），删了不会被写回来；泵闸也一并就地解除
   * （那一拍还挂在这次投递上，不解除的话闸看着开了、泵却永远占着）。running
   * 不在此列：那是编排域的一条真实子进程，删了行只是把活着的进程藏起来。
   */
  dismiss(sessionId: string, messageId: string): AnswerResult {
    const msg = this.memory.get(messageId);
    if (msg) {
      if (msg.status === 'running') {
        return { ok: false, status: 409, error: 'Message is still in flight' };
      }
      if (msg.status === 'delivering' && this.gate.headOf(msg.sessionId) === messageId) {
        this.flushing.delete(msg.sessionId);
      }
      this.memory.delete(messageId);
      this.gate.clearStall(msg.sessionId, messageId);
      this.gate.release(msg.sessionId, messageId);
      if (this.queuedSessions.has(msg.sessionId)) this.scheduleFlushContinuation(msg.sessionId);
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
   * **严格串行**：一轮只送一条，等它的 UPS 回执到了再自续下一拍——同一队列由各模式共用，
   * 顺序与「一条一条」是队列本身的语义，不是各通道各自节流的副产品。
   */
  async flushSession(sessionId: string): Promise<void> {
    // 暂停闸：未回执超窗 / 投递失败——继续灌只会堆更多不可确认的消息，等重发或回执。
    if (this.stalled.has(sessionId)) return;
    // 重入闸：冲洗是异步的（终端通道要 await 枚举 pane），两条触发源（事件 + 自续/刷新器）
    // 并发进来会各自读到同一批队列行 → 同一消息被投两次。
    if (this.flushing.has(sessionId)) return;
    if (!this.queuedSessions.has(sessionId)) return;
    const token = Symbol(sessionId);
    this.flushing.set(sessionId, token);
    try {
      await this.flushSessionInner(sessionId);
    } catch {
      // 冲洗失败永不影响调用方（事件路径是 fire-and-forget；自续拍可能与拆除竞态）
    } finally {
      if (this.flushing.get(sessionId) === token) this.flushing.delete(sessionId);
    }
  }

  private async flushSessionInner(sessionId: string): Promise<void> {
    // 队头等回执：下一条必须等它的 UPS（回执到达时才自续下一拍）。
    if (!this.ackGateOpen(sessionId)) return;
    const session = this.deps.sessions.getBySessionId(sessionId);
    if (session?.projectId == null) return;
    const project = this.deps.projects.getById(session.projectId);
    if (!project) return;
    const entries = readPromptbox(this.hooksDir, project.token).filter((e) => e.sessionId === sessionId);
    if (entries.length === 0) {
      this.queuedSessions.delete(sessionId);
      return;
    }
    // 目标已判死：队列行全是死信（socket 凭据随进程走、pane 随窗口没了、peer 登记
    // 是残留），整批落定 + 清队，不再每轮白探 pane 枚举。
    if (this.sessionJudgedDead(sessionId)) {
      this.failQueuedOffline(sessionId, entries.filter((e) => !this.dismissedIds.has(e.id)));
      return;
    }
    const surface = this.surfaceOfSession(sessionId);
    const relay = surface?.prompt ?? null;
    // 模态框在场：层② 不可盲注（见 modalBlocked），本轮只走非终端通道。
    const blocked = this.modalBlocked(sessionId);
    for (const entry of entries) {
      // 本轮中途置闸（中继即败 / 终端注入失败都是异步落定）：立即停，余下留队列
      if (this.stalled.has(sessionId)) return;
      // 本轮读到之后被删掉的行（dashboard「删除」是取消发送）：跳过
      if (this.dismissedIds.has(entry.id)) continue;
      const msg: PipeMessage = {
        id: entry.id,
        sessionId,
        text: entry.text,
        ...(entry.attachments && entry.attachments.length > 0 ? { attachments: entry.attachments } : {}),
        mode: 'prompt',
        oneWay: entry.oneWay === true,
        ...(entry.forceTerminal === true ? { forceTerminal: true } : {}),
        via: 'socket',
        channel: 'prompt',
        status: 'pending',
        at: entry.at,
      };
      // 带图同即时路径：层② 优先（只有 bracketed paste 能真贴图）。
      if (!blocked && this.hasImagesEntry(msg) && this.terminalChannel()) {
        const imgPane = await this.terminalPaneFor(session, project);
        if (imgPane) {
          removePromptboxEntries(this.hooksDir, project.token, new Set([entry.id]));
          this.memory.set(msg.id, { ...msg, via: 'terminal', status: 'delivering' });
          this.awaitingAck.set(sessionId, msg.id);
          await this.runTerminalPrompt(msg.id, imgPane.id, this.wireTextOfEntry(msg));
          // 终端层贴进框了：余下留队列，等这条的回执再发（同框叠字 = 两条并一条）
          this.settleQueueIndex(sessionId, project.token);
          return;
        }
      }
      // 层①-q 宿主队列（codex）：比终端击键更接近「用户本人发送」，手动面也先走它。
      if (surface && (await this.tryQueuedDeliver(msg, surface))) {
        removePromptboxEntries(this.hooksDir, project.token, new Set([entry.id]));
        this.settleQueueIndex(sessionId, project.token);
        return;
      }
      // 层①-a 直投优先：冲洗正是被「刚上报凭据的那条 hook 事件」触发的（本机毫秒级、
      // 零进程零 LLM），队列里的手动面行不该绕过它直奔中继。
      if (surface && (await this.tryInboxDeliver(msg, surface))) {
        removePromptboxEntries(this.hooksDir, project.token, new Set([entry.id]));
        // 一条在手：余下等这条的回执到了再发（回执命中时自续下一拍）
        this.settleQueueIndex(sessionId, project.token);
        return;
      }
      const peer = relay?.resolve(sessionId) ?? null;
      // 层序同即时路径（手动面中继退最后、强制终端只剩它）；本轮中继起不来就停轮，余行留队列。
      const layers: Array<'relay' | 'terminal'> =
        msg.forceTerminal === true
          ? ['terminal']
          : msg.oneWay === true
            ? ['terminal', 'relay']
            : ['relay', 'terminal'];
      for (const layer of layers) {
        if (layer === 'relay' && relay && peer) {
          this.memory.set(msg.id, { ...msg, status: 'delivering', via: 'relay' });
          if (!this.runRelay(msg, relay, peer.name)) {
            // 同会话中继在途：本轮到此为止，剩余行留队列
            this.memory.delete(msg.id);
            return;
          }
          this.awaitingAck.set(sessionId, msg.id);
          removePromptboxEntries(this.hooksDir, project.token, new Set([entry.id]));
          break;
        }
        if (layer === 'terminal' && !blocked && this.terminalChannel()) {
          const pane = await this.terminalPaneFor(session, project);
          if (pane) {
            removePromptboxEntries(this.hooksDir, project.token, new Set([entry.id]));
            this.memory.set(msg.id, { ...msg, via: 'terminal', status: 'delivering' });
            this.awaitingAck.set(sessionId, msg.id);
            await this.runTerminalPrompt(msg.id, pane.id, this.wireTextOfEntry(msg));
            break;
          }
        }
      }
      // 这条已经出手（直投 / 中继 / 终端任一）→ 本轮到此为止，等它的回执再自续下一拍。
      if (this.awaitingAck.get(sessionId) === msg.id) {
        this.settleQueueIndex(sessionId, project.token);
        return;
      }
      // 层均不可用（会话没开 / pane 找不到）：判不动的会话留队列等下一次事件或
      // 刷新器（判死的在本轮开头已整批落定，走不到这里）。
      return;
    }
    this.settleQueueIndex(sessionId, project.token);
  }

  /** 队列空了就把冲洗索引摘掉（本轮提前返回的路径都得过它，否则刷新器永远白探）。 */
  private settleQueueIndex(sessionId: string, token: string): void {
    if (readPromptbox(this.hooksDir, token).every((e) => e.sessionId !== sessionId)) {
      this.queuedSessions.delete(sessionId);
    }
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
    this.gate.clearStall(sessionId);
    this.gate.release(sessionId);
    this.inboxSockets.forget(sessionId); // 凭据随会话走（旧 socket 早已无效）
    this.paneEnvs.delete(sessionId); // pane 定位同样是会话生命周期内的旁路事实
    this.paneEnvConflicts.delete(sessionId);
    this.revokedPaneEnvs.add(sessionId); // 同退出：显式报 null 摘出终端分组
    this.persistPaneEnvs();
    return removed;
  }

  /** 项目归档级联（内存态按会话→项目归属判定；队列行按会话逐个清）。 */
  forgetProject(projectId: number): number {
    // 该项目的起点候选一并出队（项目没了，起点没意义）
    const before = this.pendingOrigins.length;
    this.pendingOrigins = this.pendingOrigins.filter((o) => o.projectId !== projectId);
    if (this.pendingOrigins.length !== before) this.persistPendingOrigins();
    let removed = 0;
    for (const [id, msg] of this.memory) {
      const session = this.deps.sessions.getBySessionId(msg.sessionId);
      if (session?.projectId === projectId) {
        this.memory.delete(id);
        this.inboxSockets.forget(msg.sessionId);
        this.paneEnvs.delete(msg.sessionId);
        this.gate.clearStall(msg.sessionId);
        this.gate.release(msg.sessionId);
        removed++;
      }
    }
    for (const sessionId of [...this.queuedSessions]) {
      const session = this.deps.sessions.getBySessionId(sessionId);
      if (session?.projectId === projectId) removed += this.forgetSession(sessionId);
    }
    this.persistPaneEnvs();
    return removed;
  }

  /** harness 归属 = 最新事件 source（open-terminal 同口径）。 */
  private surfaceOfSession(sessionId: string): MessagingSurface | null {
    const latest = this.deps.hookEvents.listBySession(sessionId, 1);
    const src = latest[latest.length - 1]?.source;
    if (!isHarness(src)) return null;
    return this.deps.surfaceFor?.(src) ?? messagingSurfaceFor(src);
  }

  /** 这段输入命中哪种命令形态（触发符表归能力面）；null = 普通 prompt。 */
  private commandModeOf(sessionId: string, text: string): CommandInputMode | null {
    const latest = this.deps.hookEvents.listBySession(sessionId, 1);
    const src = latest[latest.length - 1]?.source;
    if (!isHarness(src)) return null;
    const surface = this.deps.commandsFor?.(src) ?? commandsSurfaceFor(src);
    return surface ? commandModeAt(text, surface.inputModes) : null;
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
    return resolveChannelIn(this.deps.sessions, () => this.terminalChannel() != null, mode, sessionId, surface);
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
    // 定位被另一个会话占着（fork 继承同一 pane）：不猜、不回落标题启发式
    // ——那同样会命中别人的终端。投递如实落「找不到终端」。
    if (this.paneEnvConflicts.has(session.sessionId)) return null;
    return locateTerminalPane(this.terminalChannel(), this.paneEnvs, session, project);
  }

  /** 层② 通道现取（装配期注入；与 settings 的 preset 无关，只有「没装」才是 null）。 */
  private terminalChannel(): PromptTerminal | null {
    const terminal = this.deps.terminal;
    return terminal && terminal.available() ? terminal : null;
  }

  /** 模态框在场时层② 不可盲注（见 deps.blockedByQuestion）。 */
  private modalBlocked(sessionId: string): boolean {
    return this.deps.blockedByQuestion?.(sessionId) === true;
  }

  /** prompt 通道入口（send 的即时路径）：层① 命中即时中继，层② 异步找 pane，都不行入队。 */
  private async deliverPrompt(
    entry: PipeMessage,
    session: { sessionId: string; title: string | null },
    project: { token: string; path: string },
    surface: MessagingSurface,
  ): Promise<SendResult> {
    // 目标已判死：三层全是假象——socket 凭据活在会话进程里、pane 随窗口没了、
    // peer 登记是残留，投出去只会换来一条「送进虚空」的假 delivered（60s 后从
    // 待发送消失、120s 后才以 stalled 冒头）。直接落 offline：当场可见、可重发。
    if (this.sessionJudgedDead(entry.sessionId)) {
      return { ok: true, messageId: entry.id, status: 'failed', message: this.failOffline(entry) };
    }
    // 层①-a 会话本地收件箱直投（毫秒级、零进程零 LLM）：**机制由 harness 声明**
    // （`surface.promptInbox`；claude = inbox socket，其他 harness = null 即完全不尝试），
    // 目标地址由 hook 旁路上报。两域都排第一；手动面由 `forceTerminal` 排除在外
    // （直投在宿主眼里是「另一个会话发的」，人工对话要的是用户权威）。
    // 拿不到目标（会话没装 weave hooks / messaging 关闭）或投递失败 → 原路回落。
    // 带图消息层② 优先：只有 bracketed paste 能把绝对路径转成 `[Image #N]` + 真 image
    // block（socket / 中继拿到的是裸文本路径，图不进上下文，只能模型自己 Read）。
    // 模态框挂着时层② 整段让位（见 modalBlocked）：图只能走终端，就留队列等作答。
    const blocked = this.modalBlocked(entry.sessionId);
    if (!blocked && this.hasImagesEntry(entry) && this.terminalChannel()) {
      const imgPane = await this.terminalPaneFor(session, project);
      if (imgPane) {
        this.memory.set(entry.id, { ...entry, status: 'delivering', via: 'terminal' });
        this.awaitingAck.set(entry.sessionId, entry.id);
        void this.runTerminalPrompt(entry.id, imgPane.id, this.wireTextOfEntry(entry));
        return { ok: true, messageId: entry.id, status: 'delivering', message: this.memory.get(entry.id)! };
      }
    }
    // 层①-q 宿主自带队列（codex queue）：消息进目标会话自己的队列，活会话 <1s 注入。
    // 它在宿主眼里**就是用户输入**，故强制终端（手动面）也先走它——终端击键只在
    // 队列拒绝时回落（会话不在 / CLI 起不来）。带图不走它（CLI 硬拒 `--images`）。
    const queued = await this.tryQueuedDeliver(entry, surface);
    if (queued) {
      return { ok: true, messageId: entry.id, status: 'delivered', message: queued };
    }

    const socketDelivered = await this.tryInboxDeliver(entry, surface);
    if (socketDelivered) {
      return { ok: true, messageId: entry.id, status: 'delivered', message: socketDelivered };
    }

    const relay = surface.prompt;
    const peer = relay?.resolve(entry.sessionId) ?? null;
    // 层序随面变：**手动面（oneWay）中继退到最后**——跨会话包裹与「无需回复」注记
    // 只是同义外壳，却要多起一个 headless 子进程；层② 终端注入才是裸 user 文本的
    // 同形态替代。编排域反之：那里的 @weave 身份正是要投递的东西。
    // 发送人强制终端 = 只剩层②（另两层在宿主眼里都是「另一个会话发的」）。
    const layers: Array<'relay' | 'terminal'> =
      entry.forceTerminal === true
        ? ['terminal']
        : entry.oneWay === true
          ? ['terminal', 'relay']
          : ['relay', 'terminal'];
    for (const layer of layers) {
      if (layer === 'relay' && relay && peer) {
        this.memory.set(entry.id, { ...entry, status: 'delivering', via: 'relay' });
        if (this.runRelay(entry, relay, peer.name)) {
          this.awaitingAck.set(entry.sessionId, entry.id);
          return { ok: true, messageId: entry.id, status: 'delivering', message: this.memory.get(entry.id)! };
        }
        // 同会话中继在途：落队列，下轮冲洗
        this.memory.delete(entry.id);
      }
      if (layer === 'terminal' && !blocked && this.terminalChannel()) {
        const pane = await this.terminalPaneFor(session, project);
        if (pane) {
          this.memory.set(entry.id, { ...entry, status: 'delivering', via: 'terminal' });
          this.awaitingAck.set(entry.sessionId, entry.id);
          void this.runTerminalPrompt(entry.id, pane.id, this.wireTextOfEntry(entry));
          return { ok: true, messageId: entry.id, status: 'delivering', message: this.memory.get(entry.id)! };
        }
      }
    }
    // 三层全无通路（没凭据 / 没 peer / 没 pane / 模态框占着终端）：只有目标真的不在跑了才判死，
    // 判不出来（null）照旧入队等下一次事件或刷新器。
    if (this.sessionJudgedDead(entry.sessionId)) {
      return { ok: true, messageId: entry.id, status: 'failed', message: this.failOffline(entry) };
    }
    this.queueEntry(entry, project.token);
    const pending: PipeMessage = { ...entry, status: 'pending' };
    return { ok: true, messageId: entry.id, status: 'pending', message: pending };
  }

  /**
   * 层①-q 宿主自带队列（codex queue）：成功返回落定后的内存行；回落（无面 / 带图 /
   * CLI 失败）返回 null，调用方照旧走下一层。**队列冲洗也走它**。exit 0 只说明
   * 「已交给宿主队列」——真正的到达由 UPS 回执核销（codex 的队列投递在宿主眼里
   * 就是用户输入，UPS 原文与投递正文逐字相同，回执比对天然成立）。
   */
  private async tryQueuedDeliver(
    entry: PipeMessage,
    surface: MessagingSurface,
  ): Promise<PipeMessage | null> {
    const spec = surface.queuedPrompt;
    if (!spec || this.hasImagesEntry(entry)) return null;
    const { bin, args } = spec.command(entry.sessionId, this.wireTextOfEntry(entry));
    this.memory.set(entry.id, { ...entry, status: 'delivering', via: 'queue' });
    try {
      await spawnOnce(bin, args, spec.timeoutMs ?? 30_000, this.deps.spawnImpl);
    } catch {
      // 队列拒绝（会话不在 / CLI 起不来）：回落下一层，不留痕
      this.memory.delete(entry.id);
      return null;
    }
    return settleDelivered(this.channelDeps(), { ...entry, via: 'queue' } as PipeMessage, 'queue');
  }

  /**
   * 层①-a 直投尝试：成功返回落定后的内存行；回落（无面 / 无目标 / 强制终端 / 写失败）
   * 返回 null。**队列冲洗也走它**——冲洗恰好由「刚上报凭据的那条 hook 事件」触发，
   * 命中率最高；队列绕过它直奔中继，手动面就会凭空多出跨会话包裹与英文注记。
   */
  private async tryInboxDeliver(entry: PipeMessage, surface: MessagingSurface): Promise<PipeMessage | null> {
    const spec = surface.promptInbox;
    const target = this.inboxSockets.get(entry.sessionId);
    if (!spec || !target || entry.forceTerminal === true) return null;
    this.memory.set(entry.id, { ...entry, status: 'delivering', via: 'socket' });
    try {
      await deliverViaInboxSocket(spec, target, this.wireTextOfEntry(entry));
    } catch {
      // 凭据失效（resume 后 socket 名重生成等）：回落，不留痕
      this.memory.delete(entry.id);
      return null;
    }
    // 一条在手（任何层）：下一条先等它的 UPS 回执——同会话的队列必须是「1 送 1 回」。
    return settleDelivered(this.channelDeps(), entry, 'socket');
  }

  /** 入队（promptbox 追加 + 会话索引登记）。 */
  private queueEntry(entry: PipeMessage, token: string): void {
    appendQueueEntry(this.hooksDir, token, entry);
    this.queuedSessions.add(entry.sessionId);
  }

  private sessionJudgedDead(
    sessionId: string,
    liveness: Map<string, boolean> = this.deps.livenessOf?.() ?? combinedLivenessOf(),
  ): boolean {
    return sessionJudgedDeadIn(this.deps.sessions, sessionId, liveness);
  }

  private failOffline(entry: PipeMessage): PipeMessage {
    return failOfflineIn(this.memory, (m) => this.bus(m as Parameters<HookEventBus['emit']>[0]), entry);
  }

  private failQueuedOffline(sessionId: string, entries: readonly PromptboxEntry[]): void {
    failQueuedOfflineIn(this.deps, this.hooksDir, this.memory, (m) => this.bus(m as Parameters<HookEventBus['emit']>[0]), sessionId, entries);
    this.queuedSessions.delete(sessionId);
  }

  private relayDeps(): RelayDeps {
    return {
      headless: this.headless,
      getMemory: (id) => this.memory.get(id) ?? null,
      setMemory: (msg) => this.memory.set(msg.id, msg),
      awaitAck: (sessionId, messageId) => this.gate.await(sessionId, messageId),
      stall: (sessionId, msg, reason) => this.gate.stall(sessionId, msg, reason),
      commandModeOf: (text: string, sessionId: string) => this.commandModeOf(sessionId, text),
      armAckWatch: (msg) => this.gate.armAckWatch(msg),
      armCommandAck: (messageId, onRelease) =>
        this.gate.armCommandAck(messageId, (sessionId) => {
          onRelease(sessionId);
          if (this.queuedSessions.has(sessionId)) this.scheduleFlushContinuation(sessionId);
        }),
      onReleased: (sessionId) => {
        if (this.queuedSessions.has(sessionId)) this.scheduleFlushContinuation(sessionId);
      },
      emit: (m) => this.bus(m as Parameters<HookEventBus['emit']>[0]),
      ...(this.deps.bin ? { bin: this.deps.bin } : {}),
      ...(this.deps.relayTimeoutMs === undefined ? {} : { relayTimeoutMs: this.deps.relayTimeoutMs }),
    };
  }

  /** 层① 中继（判定与终态在 delivery/relay.ts）。 */
  private runRelay(entry: PipeMessage, relay: PromptRelaySpec, peerName: string): boolean {
    return runRelayIn(this.relayDeps(), entry, relay, peerName, this.wireTextOfEntry(entry));
  }

  /** 层② 终端注入终态（语义同中继：成功 delivered / 失败 failed 可见）。 */
  private async runTerminalPrompt(messageId: string, paneId: string, text: string): Promise<void> {
    await this.runTerminal(messageId, (terminal) => terminal.sendText(paneId, text));
  }

  /**
   * 层② 只补一记回车（重发「已贴进框、没回执」的行 / 队列行 Enter 按钮共用）：
   * 文本在上一次投递里已经落到会话的输入框，缺的只是那记提交键——重贴一次会在
   * 框里叠一份，用户收到两遍正文与两遍图。
   */
  private async runTerminalSubmit(messageId: string, paneId: string): Promise<void> {
    await this.runTerminal(messageId, (terminal) => terminal.sendKeys(paneId, '\r'));
  }

  private async runTerminal(
    messageId: string,
    write: (terminal: PromptTerminal) => Promise<void>,
  ): Promise<void> {
    const msg = this.memory.get(messageId);
    if (!msg) return;
    const terminal = this.terminalChannel();
    if (!terminal) return;
    try {
      await write(terminal);
      // write 期间回执可能已到：按**当前行**收尾，别用写之前的快照把 acked 抹回去。
      // 行没了 = 期间被强制移除（投递卡死时人工清队头）：不写回，删了就是删了。
      const current = this.memory.get(messageId);
      if (!current) return;
      const done: PipeMessage = { ...current, status: 'delivered', settledAt: new Date().toISOString() };
      this.memory.set(messageId, done);
      if (this.commandModeOf(current.sessionId, current.text)) this.armCommandAck(messageId);
      else this.armAckWatch(done);
      this.bus({
        kind: 'message.delivered',
        messageId,
        sessionId: msg.sessionId,
        at: new Date().toISOString(),
      });
    } catch (err) {
      const current = this.memory.get(messageId);
      if (!current) return; // 同上：被强制移除的行不写回、也不再置闸
      // 回执到了 = 文本确实进了会话（这次 write 报错也改不了这个事实）：按已送达收，不置闸
      if (current.acked === true) {
        const at = new Date().toISOString();
        this.memory.set(messageId, { ...current, status: 'delivered', settledAt: at });
        this.bus({ kind: 'message.delivered', messageId, sessionId: current.sessionId, at });
        return;
      }
      const failed: PipeMessage = {
        ...current,
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
    return deliverInjectIn(
      { hooksDir: this.hooksDir, memory: this.memory, bus: this.busSafe() },
      entry,
      token,
      meta,
      surface,
      this.wireTextOfEntry(entry),
    );
  }

  /** headless 通道：置 running → 无头 spawn；终态经 onSettle 后台回写。 */
  private deliverHeadless(
    entry: PipeMessage,
    cwd: string,
    meta: MessageMeta,
    surface: MessagingSurface,
  ): SendResult {
    return deliverHeadlessIn(
      {
        memory: this.memory,
        headless: this.headless,
        bus: this.busSafe(),
        ...(this.deps.bin ? { bin: this.deps.bin } : {}),
        ...(this.deps.timeoutMs === undefined ? {} : { timeoutMs: this.deps.timeoutMs }),
      },
      entry,
      cwd,
      meta,
      surface,
      this.wireTextOfEntry(entry),
    );
  }

  private bus(message: Parameters<HookEventBus['emit']>[0]): void {
    try {
      this.deps.bus?.emit(message);
    } catch {
      // 广播失败不影响投递
    }
  }
}
