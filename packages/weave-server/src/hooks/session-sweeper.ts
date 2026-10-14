import type { SessionRow } from '../repositories/sessions.js';
import { purgeSession, type SessionPurgeDeps } from './session-purge.js';
import type { WatchEngine } from './watch-engine.js';

/** 空会话保活窗口：先留 10 分钟再清（新会话在第一条 prompt 落下前正是"空"的形状）。 */
export const EMPTY_SESSION_GRACE_MS = 10 * 60_000;
export const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * 「空会话」判据：只有一条采集事件且它就是 SessionStart，且最后一次活动已过保活
 * 窗口。典型来源是开了个新会话立刻 `/resume` 到别的会话，只在库里残留一条
 * SessionStart。必须靠时间窗口区分——刚开的会话长得一模一样，这就是"延迟删除"
 * 的全部意义。
 */
export function isEmptySession(
  row: SessionRow,
  now: number,
  graceMs = EMPTY_SESSION_GRACE_MS,
): boolean {
  if (row.eventCount !== 1 || row.lastEventType !== 'SessionStart') return false;
  const seen = Date.parse(row.lastSeenAt);
  return Number.isFinite(seen) && now - seen > graceMs;
}

/**
 * 定时清空会话。候选来自 `listWithCounts()`——它已经 LEFT JOIN 出 eventCount 与
 * lastEventType，零新增 SQL、零 schema 变更。
 *
 * 注：新入库路径已不再为「仅 SessionStart」会话建行（inbox-worker 的
 * needsSessionRow 判据——空会话根本不建档）；本清扫器只是该改动之前
 * 遗留存量行的兜底。
 */
export class SessionSweeper {
  constructor(
    private readonly deps: SessionPurgeDeps & {
      /** 空闲订阅补射（批 2）：挂同一 tick——daemon 重启/目标异常终止后扫 pending。 */
      watchEngine?: Pick<WatchEngine, 'sweepTerminated'>;
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** 清一轮，返回清掉的会话数（无候选即 0，可反复调用）。 */
  sweep(): number {
    const now = this.now();
    let purged = 0;
    for (const row of this.deps.sessions.listWithCounts()) {
      if (!isEmptySession(row, now)) continue;
      purgeSession(this.deps, row.sessionId);
      purged++;
    }
    this.deps.watchEngine?.sweepTerminated();
    return purged;
  }

  /** 起定时器。unref：定时器不吊住 daemon 退出。 */
  start(): NodeJS.Timeout {
    // 启动即扫一轮：首个 tick 要等完整间隔，而 dev 下 tsx watch 随文件改动
    // 频繁重启（重启周期常短于间隔）→ 只靠间隔的清扫器永远赶不上第一拍，
    // 存量空会话一直挂在会话列表。清理判据自带 10 分钟保活窗，起手扫安全。
    this.sweep();
    const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    timer.unref();
    return timer;
  }
}

/**
 * 两个 daemon 入口（生产 start.ts / dev dev-entry.ts）共用的装配点——
 * 这层封装的存在理由就是入口漂移：dev 入口曾漏挂清扫器，导致空会话
 * 在 dev 下永远不被清（存量行一直显示在会话列表，判据见 isEmptySession）。
 */
export function startSessionSweeper(
  deps: SessionPurgeDeps & { watchEngine?: Pick<WatchEngine, 'sweepTerminated'> },
): NodeJS.Timeout {
  return new SessionSweeper(deps).start();
}
