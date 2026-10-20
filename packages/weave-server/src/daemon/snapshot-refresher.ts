import type { DataBus, DataKey } from './data-bus.js';

/**
 * SnapshotRefresher — 「前端不轮询，后端有人看时定期探、只在值变化时推绝对值快照」
 * 的通用骨架（使用者：会话存活 pidAlive、会话中断态、状态栏底条的 git 事实）。
 *
 * 为什么要有它：这两类事实都可能**没有** hook 事件来触发变化（claude 进程被杀 =
 * 无 SessionEnd；用户按 ESC 打断 = 无任何事件），GET /sessions 里算好的值于是卡在
 * 旧值上。探测本身零子进程（读注册表 / 读转录尾），周期可以短；只在**有人看**
 * （有 SSE 客户端）时探，且**只在值变化时**推——漏帧由下一次推自我校正。
 */

export interface SnapshotRefresherOptions {
  /** 帧键（前端按 key 写状态）。 */
  key: DataKey;
  /** 扫描周期，ms。默认 15s。 */
  intervalMs?: number;
  /** 是否值得探测（一般为「有 SSE 客户端」）。缺省恒真（测试用）。 */
  shouldRun?: () => boolean;
  /**
   * 只发失效帧（不带 payload）：前端按 key 调既有 fetcher 重拉，而不是拿这份
   * 快照直写状态。用于「快照是别的进程算的、前端已经有一份更完整的取数口」的域
   * （如 statusline 底条的 git 事实：同一份 GET 里还带着配置与脚本）。
   */
  invalidateOnly?: boolean;
}

export class SnapshotRefresher {
  private timer: NodeJS.Timeout | undefined;
  /** 上次推送的取值指纹；相同则不再推（只推变化）。 */
  private lastFingerprint: string | null = null;

  constructor(
    /** 现算一份载荷（前端直接写状态的那份绝对值快照）。 */
    private readonly snapshot: () => unknown,
    private readonly bus: DataBus,
    private readonly options: SnapshotRefresherOptions,
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

  /** 一次扫描（同步；调用方保证探测自身无重入风险）。 */
  tick(): void {
    if (this.options.shouldRun && !this.options.shouldRun()) return;
    try {
      const payload = this.snapshot();
      const fingerprint = JSON.stringify(payload);
      if (fingerprint === this.lastFingerprint) return;
      this.lastFingerprint = fingerprint;
      this.bus.emit(this.options.invalidateOnly ? { key: this.options.key } : { key: this.options.key, payload });
    } catch {
      // 探测失败（注册表/转录读不到）不推不抛：下个周期自会重试
    }
  }
}
