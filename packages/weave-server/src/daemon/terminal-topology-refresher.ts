import type { SessionTerminal } from './opener.js';
import type { DataBus } from './data-bus.js';

/**
 * TerminalTopologyRefresher — 终端世界的隐藏刷新面，两个消费方：项目卡「终端」
 * 角标（每项目窗口数）+ 会话列表分块（会话 → 所在可见屏幕）。
 *
 * 为什么需要它：wezterm 不会向我们推送窗口开关，用户手动关一个窗口不产生任何
 * 事件，只能靠 spawn `wezterm cli list` 反查（见 opener.countOpenTerminals）；
 * 会话在哪块屏（window/tab）同样只能从那次枚举里读。探测要创建子进程（每存活
 * socket 一次，实测 wall ~180ms / CPU 62–125ms），所以**永远不在请求关键路径上
 * 等它**：GET 只回上次快照 + 后台对账，新 SSE 客户端先补上次快照再后台对账，
 * 探测结果经 push 帧（值变才推）到达。
 *
 * 形状与 SyncScheduler 一致（start/stop/tick + running 防重入），不新造抽象。
 */

export interface TerminalTopology {
  /** projectId → 本项目已开终端窗口数（项目卡角标）。 */
  counts: Record<number, number>;
  /**
   * sessionId → 所在可见屏幕；`null` = 确认不在了（pane 已关 / 换了 mux / 整个
   * GUI 没了），缺 = 这轮没探到或没上报过定位——web 据此保留上次分块，不摘行。
   */
  terminals: Record<string, SessionTerminal | null>;
}

export interface TerminalTopologyRefresherOptions {
  /** 扫描周期，ms。默认 30s——角标滞后半分钟无感，而每次扫描都要 spawn 子进程。 */
  intervalMs?: number;
  /** 是否值得探测（一般为「有 SSE 客户端」）。缺省恒真（测试用）。 */
  shouldRun?: () => boolean;
  /**
   * 启动饱和窗口，ms：daemon 刚起的几秒里 watcher/首轮同步占满事件循环，
   * 探测的 spawn 排队会把 ~200ms 拖成秒级还抢 CPU——窗口内 tick 直接跳过
   * （走陈旧值路径），用户动作（refreshNow）不受限。缺省 0（测试用）。
   */
  graceMs?: number;
}

export class TerminalTopologyRefresher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** 上次成功探测的快照（探测失败保留旧值）；GET 与新客户端首帧的数据源。 */
  private last: TerminalTopology | null = null;
  /** 上次推送的取值指纹；相同则不再推（只推变化）。 */
  private lastFingerprint: string | null = null;
  private startedAt = 0;

  constructor(
    /** 现算一份终端世界（窗口计数 + 会话所在屏幕）。探测失败应 throw，由本类吞掉。 */
    private readonly snapshot: () => Promise<TerminalTopology>,
    private readonly bus: DataBus,
    private readonly options: TerminalTopologyRefresherOptions = {},
  ) {}

  /** 上次成功快照（null = 还没探过）；GET 陈旧值直给用。 */
  get lastSnapshot(): TerminalTopology | null {
    return this.last;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 用户动作（开终端）后立刻对账：不受「没人看」与启动窗口限制，仍只在变化时推。 */
  async refreshNow(): Promise<void> {
    await this.run(true, true);
  }

  /**
   * 新 SSE 客户端接入：立即补一帧上次快照（推送只在变化时发，否则首帧要等
   * 下一个周期；还没探过就不补），随后后台对一次账——补上陈旧窗口的差量。
   */
  onSubscriberJoin(): void {
    if (this.last !== null) {
      this.lastFingerprint = JSON.stringify(this.last);
      this.bus.emit({ key: 'terminalTopology', payload: this.last });
    }
    void this.tick();
  }

  /** 一次扫描。ignoreSubscribers = true 时跳过「没人看」判定（用户动作触发）。 */
  async tick(ignoreSubscribers = false): Promise<void> {
    await this.run(ignoreSubscribers, false);
  }

  private async run(ignoreSubscribers: boolean, ignoreGrace: boolean): Promise<void> {
    if (this.running) return; // 探测本身 spawn 子进程，防重入
    const shouldRun = this.options.shouldRun;
    if (!ignoreSubscribers && shouldRun && !shouldRun()) return;
    if (!ignoreGrace && Date.now() - this.startedAt < (this.options.graceMs ?? 0)) return;
    this.running = true;
    try {
      const topology = await this.snapshot();
      this.last = topology;
      const fingerprint = JSON.stringify(topology);
      if (fingerprint === this.lastFingerprint) return;
      this.lastFingerprint = fingerprint;
      this.bus.emit({ key: 'terminalTopology', payload: topology });
    } catch {
      // 探测失败（wezterm 不在/挂死）不推不抛：下个周期自会重试，角标与分块保持旧值。
    } finally {
      this.running = false;
    }
  }
}
