import type { DataBus } from './data-bus.js';

/**
 * TerminalCountsRefresher — 项目卡「终端」角标的数据面，改成后端隐藏刷新。
 *
 * 为什么需要它：wezterm 不会向我们推送窗口开关，用户手动关一个窗口不产生任何
 * 事件，只能靠 spawn `wezterm cli list` 反查（见 opener.countOpenTerminals）。
 * 前端为此每 5s 打一次枪，代价是**每个存活 socket 一次进程创建**——实测
 * wall ~180ms / CPU 62–125ms，60s 内 19 次 spawn。把这些收到后端：
 * 只在**有人看**（有 SSE 客户端）时探，且**只在值变化时**才推帧——于是前端零
 * 定时器，只看到一个推来的帧。
 *
 * 形状与 SyncScheduler 一致（start/stop/tick + running 防重入），不新造抽象。
 */

export interface TerminalCountsRefresherOptions {
  /** 扫描周期，ms。默认 30s——角标滞后半分钟无感，而每次扫描都要 spawn 子进程。 */
  intervalMs?: number;
  /** 是否值得探测（一般为「有 SSE 客户端」）。缺省恒真（测试用）。 */
  shouldRun?: () => boolean;
}

export class TerminalCountsRefresher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** 上次推送的取值指纹；相同则不再推（只推变化）。 */
  private lastFingerprint: string | null = null;

  constructor(
    /** 现算一份每项目窗口数（projectId → 窗口数）。探测失败应 throw，由本类吞掉。 */
    private readonly snapshot: () => Promise<Record<number, number>>,
    private readonly bus: DataBus,
    private readonly options: TerminalCountsRefresherOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 用户动作（开终端）后立刻对账：不受「有没有人看」限制，但仍只在变化时推。 */
  async refreshNow(): Promise<void> {
    await this.tick(true);
  }

  /** 一次扫描。ignoreSubscribers = true 时跳过「没人看」判定（用户动作触发）。 */
  async tick(ignoreSubscribers = false): Promise<void> {
    if (this.running) return; // 探测本身 spawn 子进程，防重入
    const shouldRun = this.options.shouldRun;
    if (!ignoreSubscribers && shouldRun && !shouldRun()) return;
    this.running = true;
    try {
      const counts = await this.snapshot();
      const fingerprint = JSON.stringify(counts);
      if (fingerprint === this.lastFingerprint) return;
      this.lastFingerprint = fingerprint;
      this.bus.emit({ key: 'terminalCounts', payload: { counts } });
    } catch {
      // 探测失败（wezterm 不在/挂死）不推不抛：下个周期自会重试，角标保持旧值。
    } finally {
      this.running = false;
    }
  }
}
