/**
 * 会话状态机（纯函数，可单测）。六态：运行中 / 压缩中 / 失败 / 打开 / 关闭 /
 * 已终止。
 *
 * 优先级：SSE overlay（帧已到、refetch 未回的即时覆盖）→ 运行中（派发执行中 /
 * 后台子 agent 进行中 / 回合开着且有近期活动）→ 失败（最新派发 failed/timeout）
 * → 关闭（最新事件 SessionEnd，正常退出）→ 已终止（claude 注册表判死，
 * 异常被杀）→ 压缩中（最新事件是压缩开始事件且未静默超窗）→ 打开。
 *
 * 「压缩中」判据走 core 的 `HARNESS_COMPACTION`（镜像见 tasks/lifecycle.ts），
 * 本函数只认表里的事件名。它排在回合逻辑之前：压缩期间宿主一个 hook 事件都不发，
 * 回合逻辑会把这段静默读成「运行中/打开」；收尾笔（SessionStart(source=compact)
 * 等）到达即顶掉。
 *
 * 「打开」= 会话仍在（未收到 SessionEnd、进程活着或无从判定）且当前不在
 * 干活——等输入或已静默；无 SessionEnd 的旧会话一律「打开」（不按静默时长
 * 兜底）。「关闭」只由 SessionEnd 判定；「已终止」只在 claude 注册表明确
 * 判死（pidAlive === false）时成立——查不到登记（codex/旧会话）不猜。
 */

import type { Harness } from '@weavecode/core/harness';
import { HARNESS_ORDER } from '@/lib/harness-meta';
import { HARNESS_COMPACTION } from './lifecycle';

export type SessionStatus =
  | 'running'
  | 'compacting'
  | 'failed'
  | 'open'
  | 'closed'
  | 'terminated';

export interface StatusInput {
  /** sessions.last_seen_at（ingest touch，可信）。 */
  lastSeenAt: string;
  /** 已加载事件中最新一条的时间与类型（可选——事件可能未拉取）。 */
  latestEventAt?: string;
  latestEventType?: string;
  /** claude 注册表判活：false=进程确死；null/undefined=查不到登记（不猜）。 */
  pidAlive?: boolean | null;
  /** 该会话存在 running 状态的 dispatch（webhook/resume 执行中）。 */
  hasRunningDispatch: boolean;
  /** 后台子 agent 进行中（spawn 已见且未 Stop、且 10 分钟内有该 agent 的事件）。
   *  子 agent 静默可远超主会话窗口——单独一条 running 通路，调用方负责过期。 */
  hasRunningSubagent?: boolean;
  /** 最新 dispatch 为 failed/timeout 且其后无 running/succeeded。 */
  latestDispatchFailed?: boolean;
  /** SSE 帧即时覆盖（dispatch.started/finished 已到，refetch 未回）。 */
  overlay?: SessionStatus;
  /** 当前 turn 是否开着（服务端基线）：最后 UPS 晚于最后 Stop/SessionEnd。
   *  未知（undefined）= 旧 daemon 或该会话无 UPS 事件，不改判。 */
  turnOpen?: boolean;
  /** 会话归属 harness（查压缩信号表；未知/缺失 = 无压缩态）。 */
  harness?: HarnessKey | null;
  /** 注入时间（默认 Date.now()，测试可注入）。 */
  now?: number;
}

const ACTIVE_WINDOW_MS = 30_000;
/** 回合开着但静默超此时长 = 长工具/长思考兜底窗口；超窗不再算运行中（回打开）。 */
const STALE_TURN_MS = 5 * 60_000;
/** 压缩中的超窗兜底：压缩本身就不发事件，窗口给得比回合兜底宽；超过 = 会话被杀在压缩中，回常规逻辑。 */
const COMPACTING_STALE_MS = 10 * 60_000;
/** 子 agent 条目超此时长无该 agent 的事件 = 失联兜底（崩溃不永久卡 running）。 */
export const STALE_SUBAGENT_MS = 10 * 60_000;

export function deriveSessionStatus(input: StatusInput): SessionStatus {
  if (input.overlay) return input.overlay;
  if (input.hasRunningDispatch) return 'running';
  if (input.hasRunningSubagent) return 'running';
  if (input.latestDispatchFailed) return 'failed';
  if (input.latestEventType === 'SessionEnd') return 'closed';
  // 无 SessionEnd 而 claude 注册表判死 → 异常终止（被杀 terminal/进程）；
  // 只认明确 false——pid 复用残差与查不到登记都不猜
  if (input.pidAlive === false) return 'terminated';

  const now = input.now ?? Date.now();
  const lastEvent = input.latestEventAt ? Date.parse(input.latestEventAt) : NaN;
  const lastSeen = Date.parse(input.lastSeenAt);
  const freshest = Math.max(
    Number.isNaN(lastEvent) ? 0 : lastEvent,
    Number.isNaN(lastSeen) ? 0 : lastSeen,
  );
  const quietMs = freshest > 0 ? now - freshest : Number.POSITIVE_INFINITY;

  // 压缩中：最新事件正是该 harness 的压缩开始事件（收尾笔/后续任何事件即顶掉）。
  // 超窗兜底只防「会话被杀在压缩中」永久卡住——压缩期间本就无事件可刷新。
  const compactStart =
    input.harness != null ? HARNESS_COMPACTION[input.harness]?.start : null;
  if (
    compactStart != null &&
    input.latestEventType === compactStart &&
    quietMs < COMPACTING_STALE_MS
  ) {
    return 'compacting';
  }

  // 回合开着且未静默超时 → 运行中（无视 30s 窗口——长工具/长思考不丢状态）
  if (input.turnOpen === true && quietMs < STALE_TURN_MS) return 'running';
  // 回合已关（收到 Stop）→ 会话只是打开等输入，不是进行中
  if (input.turnOpen === false) return 'open';
  // 回合开合未知（旧 daemon / 无 UPS 事件）：30s 窗口内有活动视为运行中
  if (quietMs < ACTIVE_WINDOW_MS) return 'running';
  return 'open';
}

/** 会话是否在干活（压缩中也算——它在跑，只是压缩期间宿主不发事件）：
 *  组头徽标 / 画布动效 / 状态图标共用，别各自写 `=== 'running'`。 */
export function isSessionBusy(status: SessionStatus): boolean {
  return status === 'running' || status === 'compacting';
}

/** 状态 → 展示文案的 dict key。 */
export const STATUS_KEY: Record<
  SessionStatus,
  | 'tasks.statusRunning'
  | 'tasks.statusCompacting'
  | 'tasks.statusFailed'
  | 'tasks.statusOpen'
  | 'tasks.statusClosed'
  | 'tasks.statusTerminated'
> = {
  running: 'tasks.statusRunning',
  compacting: 'tasks.statusCompacting',
  failed: 'tasks.statusFailed',
  open: 'tasks.statusOpen',
  closed: 'tasks.statusClosed',
  terminated: 'tasks.statusTerminated',
};

/** 状态 → 圆点颜色（运行中/压缩中由渲染层用 HarnessIcon 动效，打开用其静态形）。 */
export const STATUS_DOT: Record<SessionStatus, string> = {
  running: 'bg-orange-400',
  compacting: 'bg-amber-400',
  failed: 'bg-red-500',
  open: 'bg-neutral-500',
  closed: 'bg-neutral-700',
  terminated: 'bg-rose-800',
};

/** 状态 → 文字徽标配色（运行中/压缩中/失败彩色醒目，打开/关闭收敛；终止取暗红示「被杀」）。 */
export const STATUS_BADGE: Record<SessionStatus, string> = {
  running: 'bg-orange-900/50 text-orange-300',
  compacting: 'bg-amber-900/50 text-amber-300',
  failed: 'bg-red-900/50 text-red-300',
  open: 'bg-neutral-800 text-neutral-300',
  closed: 'bg-neutral-900 text-neutral-500',
  terminated: 'bg-rose-950/60 text-rose-400',
};

/** 会话归属 harness——直接引 core 名表（类型层，无运行时依赖）。 */
export type HarnessKey = Harness;

/** 只取状态计数所需的最小结构——SessionRow 结构化满足（避免 lib/api 进纯测试）。 */
export interface SessionLike {
  sessionId: string;
  harness?: HarnessKey | null;
}

export interface HarnessSessionCounts {
  harness: HarnessKey | null;
  running: number;
  open: number;
}

/**
 * 项目维度会话计数（项目行徽标用）：按 harness 分桶，只计「运行中」与「打开」
 * 两类（失败/关闭 不在项目行提示——失败由任务视图承载，关闭无需提醒）；
 * 压缩中也算运行中——会话正忙，不该在项目行掉成「打开」。
 * 桶序 = 名表序（claude → codex）→ 未知，同项目徽标顺序稳定。
 */
export function countSessionsByHarness(
  sessions: readonly SessionLike[],
  statuses: ReadonlyMap<string, SessionStatus>,
): HarnessSessionCounts[] {
  const buckets = new Map<HarnessKey | null, HarnessSessionCounts>();
  for (const s of sessions) {
    const status = statuses.get(s.sessionId) ?? 'open';
    if (status !== 'running' && status !== 'compacting' && status !== 'open') continue;
    const key: HarnessKey | null =
      s.harness != null && HARNESS_ORDER.includes(s.harness) ? s.harness : null;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { harness: key, running: 0, open: 0 };
      buckets.set(key, bucket);
    }
    if (status === 'open') bucket.open += 1;
    else bucket.running += 1;
  }
  const rank = (h: HarnessKey | null): number =>
    h === null ? HARNESS_ORDER.length : HARNESS_ORDER.indexOf(h);
  return [...buckets.values()].sort((a, b) => rank(a.harness) - rank(b.harness));
}
