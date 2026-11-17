import { purgeSession, type SessionPurgeDeps } from './session-purge.js';
import type { WatchEngine } from './watch-engine.js';
import type { OrchestrationEngine } from './orchestration-engine.js';
import { shellDiscardedByHost } from '../daemon/claude-liveness.js';
import { combinedLivenessOf } from '../daemon/liveness.js';

export const SWEEP_INTERVAL_MS = 5 * 60_000;

/** 归档关闭的静默窗：回合跑着时宿主不发事件（长工具/长思考），最近事件太近
 *  说明可能正在干活——关 pane 就是打断工作。5 分钟与前端 STALE_TURN_MS 同口径。 */
const ARCHIVE_CLOSE_QUIET_MS = 5 * 60_000;

/**
 * 定时清过期会话，两条判据：
 * 1. `autoDeleteAt`（期限与档位唯一事实源 = sessions 仓储的 `listWithCounts`：没等到
 *    用户 prompt 的新会话 1 小时快过期、收到过 prompt 的走 settings `sessions.idleDays`）；
 * 2. 宿主已丢弃的空壳会话（`shellDiscardedByHost`）——一句没说就退出会连 id 带转录一起
 *    丢（claude 删注册表、codex 连 thread 锁一起没），等满保活期只是让列表多摆一条幽灵。
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
      /** 列表收纳的自动关 pane（用户裁决 2026-11-17：超收纳天数还开着终端窗口的
       *  会话，先关 pane 让宿主随 pane 退出，再由前端沉进「已收纳」区；会话行
       *  与对话照常保留——这是收尾，不是删除）。null/缺省 = 不做。 */
      archiveCloser?: { closePane(sessionId: string): Promise<unknown> } | null;
      /** 收纳阈值（天；settings sessions.archiveDays，现取——设置改动即时生效）。≤0 = 关闭。 */
      archiveDays?: number | (() => number);
      /** 关完补一拍终端分块刷新（角标/分组立刻跟上）；缺省不打。 */
      terminalRefresher?: { refreshNow(): void | Promise<void> };
      /** 分块上传的半截件（过期回收；同轮顺带扫）。 */
      uploadSessions?: { sweep(): Promise<number> };
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** 清一轮，返回清掉的会话数（无候选即 0，可反复调用）。 */
  sweep(): number {
    const now = this.now();
    const liveness = this.deps.livenessOf?.();
    let purged = 0;
    /** 归档关闭的候选（本轮先收集，清完统一异步关——closePane 是 await 慢操作，
     *  不吊 sweep 的同步路径）。 */
    const toArchiveClose: string[] = [];
    for (const row of this.deps.sessions.listWithCounts()) {
      if (liveness && shellDiscardedByHost(row, liveness, now)) {
        purgeSession(this.deps, row.sessionId);
        purged++;
        continue;
      }
      const deadline = row.autoDeleteAt == null ? null : Date.parse(row.autoDeleteAt);
      if (deadline == null || now < deadline) {
        // 没到删除期限但超过收纳阈值且进程还活着：自动关 pane（事件静默窗内的
        // 可能还在跑回合，不关——关了就是打断工作）。判活用存活图（claude 注册表
        // + codex 锁探针；查不到登记不关——宁可漏关不误关）。
        const rawDays = this.deps.archiveDays;
        const days = typeof rawDays === 'function' ? rawDays() : (rawDays ?? 0);
        if (
          days > 0 &&
          this.deps.archiveCloser &&
          liveness?.get(row.sessionId) === true &&
          now - Date.parse(row.lastSeenAt) > days * 86_400_000 &&
          now - Date.parse(row.lastSeenAt) > ARCHIVE_CLOSE_QUIET_MS
        ) {
          toArchiveClose.push(row.sessionId);
        }
        continue;
      }
      purgeSession(this.deps, row.sessionId);
      purged++;
    }
    if (toArchiveClose.length > 0) {
      const closer = this.deps.archiveCloser!;
      void Promise.allSettled(toArchiveClose.map((id) => closer.closePane(id))).then(() => {
        this.deps.terminalRefresher?.refreshNow();
      });
    }
    // 与过期会话无关的孤儿上传件（选了图没发出去、事件早已清掉的）同轮收走；
    // 分块上传留下半截件的同理（异步扫，不吊这一拍）
    this.deps.uploads?.pruneUnreferenced();
    void this.deps.uploadSessions?.sweep();
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
    uploadSessions?: { sweep(): Promise<number> };
    /** 存活图来源；缺省合并图（claude 注册表 + codex 锁探针缓存）。 */
    livenessOf?: () => Map<string, boolean>;
    /** 列表收纳的自动关 pane（透传 SessionSweeper）。 */
    archiveCloser?: { closePane(sessionId: string): Promise<unknown> } | null;
    /** 收纳阈值（天；现取函数或常量）。 */
    archiveDays?: number | (() => number);
    /** 关完补一拍终端分块刷新。 */
    terminalRefresher?: { refreshNow(): void | Promise<void> };
  },
): NodeJS.Timeout {
  return new SessionSweeper({ ...deps, livenessOf: deps.livenessOf ?? combinedLivenessOf }).start();
}
