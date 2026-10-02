/**
 * 会话状态机（纯函数，可单测）。
 * 优先级：SSE overlay（帧已到、refetch 未回的即时覆盖）→ running → failed
 * → active（30s 窗口）→ completed（最新事件 SessionEnd）→ idle。
 * 5 态：active = 呼吸点（刚有事件），running = spinner（派发执行中）。
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
  /** 最新 dispatch 为 failed/timeout 且其后无 running/succeeded。 */
  latestDispatchFailed?: boolean;
  /** SSE 帧即时覆盖（dispatch.started/finished 已到，refetch 未回）。 */
  overlay?: SessionStatus;
  /** 注入时间（默认 Date.now()，测试可注入）。 */
  now?: number;
}

const ACTIVE_WINDOW_MS = 30_000;

export function deriveSessionStatus(input: StatusInput): SessionStatus {
  if (input.overlay) return input.overlay;
  if (input.hasRunningDispatch) return 'running';
  if (input.latestDispatchFailed) return 'failed';

  const now = input.now ?? Date.now();
  const lastEvent = input.latestEventAt ? Date.parse(input.latestEventAt) : NaN;
  const lastSeen = Date.parse(input.lastSeenAt);
  const freshest = Math.max(Number.isNaN(lastEvent) ? 0 : lastEvent, Number.isNaN(lastSeen) ? 0 : lastSeen);
  if (freshest > 0 && now - freshest < ACTIVE_WINDOW_MS) {
    // 30s 窗口内：若最新事件是会话收尾，优先显示完成而非活跃
    if (input.latestEventType === 'SessionEnd') return 'completed';
    return 'active';
  }
  if (input.latestEventType === 'SessionEnd') return 'completed';
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
