import { purgeSession, type SessionPurgeDeps } from './session-purge.js';
import type { WatchEngine } from './watch-engine.js';
import type { OrchestrationEngine } from './orchestration-engine.js';
import { claudeLivenessById, shellDiscardedByClaude } from '../daemon/claude-liveness.js';

export const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * 定时清过期会话，两条判据：
 * 1. `autoDeleteAt`（期限与档位唯一事实源 = sessions 仓储的 `listWithCounts`：没等到
 *    用户 prompt 的新会话 1 小时快过期、收到过 prompt 的走 settings `sessions.idleDays`）；
 * 2. 宿主已丢弃的空壳会话（`shellDiscardedByClaude`）——claude 一句没说就退出会连 id 带
 *    转录一起删，等满保活期只是让列表多摆一条幽灵。
 *
 * 注：入库路径对**每个**首现 sessionId 都建档（含仅一条 SessionStart 的新会话
 * ——新建会话要马上出现在列表），期限倒计时随行展示，看得见它还剩多久。
 */
export class SessionSweeper {
  constructor(
    private readonly deps: SessionPurgeDeps & {
      /** 空闲订阅补射（批 2）：挂同一 tick——daemon 重启/目标异常终止后扫 pending。 */
      watchEngine?: Pick<WatchEngine, 'sweepTerminated'>;
      /** 编排补射：同 tick——待回目标已死即复活会话或丢弃待回。 */
      orchestrationEngine?: Pick<OrchestrationEngine, 'sweepTerminated'>;
      /** 存活图来源（空壳判据要用）；不给就只按期限清。 */
      livenessOf?: () => Map<string, boolean>;
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** 清一轮，返回清掉的会话数（无候选即 0，可反复调用）。 */
  sweep(): number {
    const now = this.now();
    const liveness = this.deps.livenessOf?.();
    let purged = 0;
    for (const row of this.deps.sessions.listWithCounts()) {
      if (liveness && shellDiscardedByClaude(row, liveness, now)) {
        purgeSession(this.deps, row.sessionId);
        purged++;
        continue;
      }
      const deadline = row.autoDeleteAt == null ? null : Date.parse(row.autoDeleteAt);
      if (deadline == null || now < deadline) continue;
      purgeSession(this.deps, row.sessionId);
      purged++;
    }
    // 与过期会话无关的孤儿上传件（选了图没发出去、事件早已清掉的）同轮收走
    this.deps.uploads?.pruneUnreferenced();
    this.deps.watchEngine?.sweepTerminated();
    this.deps.orchestrationEngine?.sweepTerminated();
    return purged;
  }

  /** 起定时器。unref：定时器不吊住 daemon 退出。 */
  start(): NodeJS.Timeout {
    // 启动即扫一轮：首个 tick 要等完整间隔，而 dev 下 tsx watch 随文件改动
    // 频繁重启（重启周期常短于间隔）→ 只靠间隔的清扫器永远赶不上第一拍，
    // 存量过期行一直挂在会话列表。清理判据按 autoDeleteAt 算，起手扫安全。
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
    orchestrationEngine?: Pick<OrchestrationEngine, 'sweepTerminated'>;
  },
): NodeJS.Timeout {
  return new SessionSweeper({ ...deps, livenessOf: () => claudeLivenessById() }).start();
}
