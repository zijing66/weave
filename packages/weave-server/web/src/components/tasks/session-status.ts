/**
 * 会话状态机（纯函数，可单测）。
 * 优先级：SSE overlay（帧已到、refetch 未回的即时覆盖）→ running（派发执行中
 * 或后台子 agent 进行中）→ failed → completed（最新事件 SessionEnd，无条件）
 * → active → idle。
 * active 两档：turnOpen 且静默 < STALE_TURN_MS（无视 30s 窗口——长工具/长思考
 * 不丢状态）；或 30s 窗口内有事件。turnOpen 但静默超 STALE_TURN_MS = 异常退出
 * 兜底 → idle（不永久卡死）。
 * 5 态：active = 呼吸点（刚有事件），running = spinner（派发/子 agent 执行中）。
 */

export type SessionStatus = 'running' | 'active' | 'failed' | 'completed' | 'idle';

export interface StatusInput {
  /** sessions.last_seen_at（ingest touch，可信）。 */
  lastSeenAt: string;
  /** 已加载事件中最新一条的时间与类型（可选——事件可能未拉取）。 */
  latestEventAt?: string;
  latestEventType?: string;
  /** 该会话存在 running 状态的 dispatch（webhook/resume 执行中）。 */
  hasRunningDispatch: boolean;
  /** 后台子 agent 进行中（spawn 已见且未 Stop、且 10 分钟内有该 agent 的事件）。
   *  子 agent 静默可远超主会话窗口——单独一条 running 通路，调用方负责过期。 */
  hasRunningSubagent?: boolean;
  /** 最新 dispatch 为 failed/timeout 且其后无 running/succeeded。 */
  latestDispatchFailed?: boolean;
  /** SSE 帧即时覆盖（dispatch.started/finished 已到，refetch 未回）。 */
  overlay?: SessionStatus;
  /** 当前 turn 是否开着：从尾部扫到 UserPromptSubmit=true / Stop=false（未
   *  知=undefined，不改判）。Stop 后 30s 窗口内有事件也只是「打开」等输入，
   *  不是进行中。 */
  turnOpen?: boolean;
  /** 注入时间（默认 Date.now()，测试可注入）。 */
  now?: number;
}

const ACTIVE_WINDOW_MS = 30_000;
/** turn 开着但静默超此时长 = 异常退出兜底（回 idle，不永久卡死）。 */
const STALE_TURN_MS = 5 * 60_000;
/** 子 agent 条目超此时长无该 agent 的事件 = 失联兜底（崩溃不永久卡 running）。 */
export const STALE_SUBAGENT_MS = 10 * 60_000;

export function deriveSessionStatus(input: StatusInput): SessionStatus {
  if (input.overlay) return input.overlay;
  if (input.hasRunningDispatch) return 'running';
  if (input.hasRunningSubagent) return 'running';
  if (input.latestDispatchFailed) return 'failed';
  if (input.latestEventType === 'SessionEnd') return 'completed';

  const now = input.now ?? Date.now();
  const lastEvent = input.latestEventAt ? Date.parse(input.latestEventAt) : NaN;
  const lastSeen = Date.parse(input.lastSeenAt);
  const freshest = Math.max(Number.isNaN(lastEvent) ? 0 : lastEvent, Number.isNaN(lastSeen) ? 0 : lastSeen);

  // turn 开着且未静默超时 → 进行中（长工具/长思考无视 30s 窗口）
  if (input.turnOpen === true && freshest > 0 && now - freshest < STALE_TURN_MS) {
    return 'active';
  }
  if (freshest > 0 && now - freshest < ACTIVE_WINDOW_MS) {
    // 30s 窗口内：turn 已 Stop → 会话只是「打开」等输入，不是进行中
    if (input.turnOpen === false) return 'idle';
    return 'active';
  }
  return 'idle';
}

/** 状态 → 展示文案的 dict key。 */
export const STATUS_KEY: Record<SessionStatus, 'tasks.statusRunning' | 'tasks.statusActive' | 'tasks.statusFailed' | 'tasks.statusCompleted' | 'tasks.statusIdle'> = {
  running: 'tasks.statusRunning',
  active: 'tasks.statusActive',
  failed: 'tasks.statusFailed',
  completed: 'tasks.statusCompleted',
  idle: 'tasks.statusIdle',
};

/** 状态 → 圆点/spinner 颜色（running 的 spinner 由渲染层用 Loader2）。 */
export const STATUS_DOT: Record<SessionStatus, string> = {
  running: 'bg-orange-400',
  active: 'bg-emerald-400 animate-pulse',
  failed: 'bg-red-500',
  completed: 'bg-emerald-600',
  idle: 'bg-neutral-600',
};

/** 状态 → 文字徽标配色（活跃/失败彩色醒目，完成/空闲收敛）。 */
export const STATUS_BADGE: Record<SessionStatus, string> = {
  running: 'bg-orange-900/50 text-orange-300',
  active: 'bg-emerald-900/50 text-emerald-300',
  failed: 'bg-red-900/50 text-red-300',
  completed: 'bg-neutral-800 text-neutral-400',
  idle: 'bg-neutral-900 text-neutral-500',
};
