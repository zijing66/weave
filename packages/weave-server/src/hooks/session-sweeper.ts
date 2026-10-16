import { purgeSession, type SessionPurgeDeps } from './session-purge.js';
import type { WatchEngine } from './watch-engine.js';
import type { SequenceEngine } from './sequence-engine.js';

export const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * 定时清「无操作」过期会话：判据与期限的单一事实源 = sessions 仓储的
 * `listWithCounts`（`autoDeleteAt` 计算列 = lastSeenAt + settings `sessions.idleDays`
 * 闲置窗），**全会话统一**——本清扫器只做「过期即清」。
 *
 * 注：入库路径对**每个**首现 sessionId 都建档（含仅一条 SessionStart 的新会话
 * ——新建会话要马上出现在列表），新会话与长会话同一条闲置移除线：列表里挂够
 * n 天无操作才自动移除，期限倒计时随行展示。
 */
export class SessionSweeper {
  constructor(
    private readonly deps: SessionPurgeDeps & {
      /** 空闲订阅补射（批 2）：挂同一 tick——daemon 重启/目标异常终止后扫 pending。 */
      watchEngine?: Pick<WatchEngine, 'sweepTerminated'>;
      /** 序列补射（批 3）：同 tick——进行中序列的等待目标已死即序列失败。 */
      sequenceEngine?: Pick<SequenceEngine, 'sweepTerminated'>;
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** 清一轮，返回清掉的会话数（无候选即 0，可反复调用）。 */
  sweep(): number {
    const now = this.now();
    let purged = 0;
    for (const row of this.deps.sessions.listWithCounts()) {
      const deadline = row.autoDeleteAt == null ? null : Date.parse(row.autoDeleteAt);
      if (deadline == null || now < deadline) continue;
      purgeSession(this.deps, row.sessionId);
      purged++;
    }
    this.deps.watchEngine?.sweepTerminated();
    this.deps.sequenceEngine?.sweepTerminated();
    return purged;
  }

  /** 起定时器。unref：定时器不吊住 daemon 退出。 */
  start(): NodeJS.Timeout {
    // 启动即扫一轮：首个 tick 要等完整间隔，而 dev 下 tsx watch 随文件改动
    // 频繁重启（重启周期常短于间隔）→ 只靠间隔的清扫器永远赶不上第一拍，
    // 存量过期行一直挂在会话列表。清理判据按闲置窗算（缺省 90 天），起手扫安全。
    this.sweep();
    const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    timer.unref();
    return timer;
  }
}

/**
 * 两个 daemon 入口（生产 start.ts / dev dev-entry.ts）共用的装配点——
 * 这层封装的存在理由就是入口漂移：dev 入口曾漏挂清扫器，导致幽灵会话
 * 在 dev 下永远不被清（存量行一直显示在会话列表，判据见 autoDeleteAt）。
 */
export function startSessionSweeper(
  deps: SessionPurgeDeps & {
    watchEngine?: Pick<WatchEngine, 'sweepTerminated'>;
    sequenceEngine?: Pick<SequenceEngine, 'sweepTerminated'>;
  },
): NodeJS.Timeout {
  return new SessionSweeper(deps).start();
}
