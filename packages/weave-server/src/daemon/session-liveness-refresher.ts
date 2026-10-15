import type { DataBus } from './data-bus.js';

/**
 * SessionLivenessRefresher — 会话行「打开终端」图标的存活数据面（pidAlive）。
 *
 * 为什么需要它：claude 进程死掉不一定有事件（终端窗口被关 / 进程被杀 =
 * 无 SessionEnd hook），GET /sessions 里算好的 pidAlive 卡在旧值、图标常绿。
 * 判活本身零 spawn（`~/.claude/sessions` 注册表读 + kill(pid,0)），周期可以
 * 比终端角标（要 spawn wezterm cli，30s）短——只在**有人看**（有 SSE 客户端）
 * 时探，且**只在值变化时**推绝对值快照；null 态（codex/新鲜会话，判不动）
 * 不进快照，前端不猜。
 */

export interface SessionLivenessRefresherOptions {
  /** 扫描周期，ms。默认 15s——判活零子进程，图标滞后一个周期即可接受。 */
  intervalMs?: number;
  /** 是否值得探测（一般为「有 SSE 客户端」）。缺省恒真（测试用）。 */
  shouldRun?: () => boolean;
}

export class SessionLivenessRefresher {
  private timer: NodeJS.Timeout | undefined;
  /** 上次推送的取值指纹；相同则不再推（只推变化）。 */
  private lastFingerprint: string | null = null;

  constructor(
    /** 现算一份 sessionId → 判得动的存活值（true/false；null 不进图）。 */
    private readonly snapshot: () => Record<string, boolean>,
    private readonly bus: DataBus,
    private readonly options: SessionLivenessRefresherOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.options.intervalMs ?? 15_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 一次扫描（同步：注册表读 + kill 0，无 spawn 无重入风险）。 */
  tick(): void {
    const shouldRun = this.options.shouldRun;
    if (shouldRun && !shouldRun()) return;
    try {
      const alive = this.snapshot();
      const fingerprint = JSON.stringify(alive);
      if (fingerprint === this.lastFingerprint) return;
      this.lastFingerprint = fingerprint;
      this.bus.emit({ key: 'sessionLiveness', payload: { alive } });
    } catch {
      // 注册表读不到（claude 没装过）不推不抛：下个周期自会重试
    }
  }
}
