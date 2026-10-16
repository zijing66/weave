import type { DataBus } from './data-bus.js';
import type { HookEventBus } from '../hooks/bus.js';
import type { ProjectUpdateSummary } from '../install/updates.js';

/**
 * ProjectUpdatesRefresher — 项目行「有更新待同步」角标的数据面（SSE 推送）。
 *
 * 与 InflightCountsRefresher 同形状（无定时器、指纹去重、值变才推**绝对值
 * 快照**），但触发源有两个：项目插件根变更（plugin-loader 的 watcher 重扫后
 * 广播 `plugin.reloaded`）与显式对账（新 SSE 客户端接入、同步落地后）——漂移
 * 只随盘面变化而变，没有轮询的理由。前端零请求：漏帧的客户端在下一次快照
 * 自我校正；`GET /projects/:id/updates` 仍是权威检测面（hover 兜底同源同算）。
 */
export class ProjectUpdatesRefresher {
  /** 上次取到的快照（null = 还没算过）；新客户端首帧的数据源。 */
  private lastCounts: Record<number, ProjectUpdateSummary> | null = null;
  /** 上次推送的取值指纹；相同则不再推（只推变化）。 */
  private lastFingerprint: string | null = null;
  /** 重算要读盘/算指纹，防重入（并发重算会让快照乱序到达）。 */
  private running = false;

  constructor(
    /** 现算一份每项目更新摘要（含 0/false）；失败应 throw，由本类吞掉。 */
    private readonly snapshot: () => Promise<Record<number, ProjectUpdateSummary>>,
    private readonly bus: DataBus,
    hookBus: HookEventBus,
    /** 是否值得重算（一般为「有 SSE 客户端」）。缺省恒真（测试用）。 */
    private readonly shouldRun: () => boolean = () => true,
  ) {
    hookBus.subscribe((message) => {
      if (message.kind === 'plugin.reloaded') void this.refreshNow();
    });
  }

  /** 显式对账（用户动作/同步落地）：无视「没人看」判定，仍只在值变化时推。 */
  async refreshNow(ignoreSubscribers = false): Promise<void> {
    if (this.running) return;
    if (!ignoreSubscribers && !this.shouldRun()) return;
    this.running = true;
    try {
      const counts = await this.snapshot();
      this.lastCounts = counts;
      const fingerprint = JSON.stringify(counts);
      if (fingerprint === this.lastFingerprint) return;
      this.lastFingerprint = fingerprint;
      this.bus.emit({ key: 'updates', payload: { counts } });
    } catch {
      // 扫描失败不推不抛：角标保持旧值，下一次触发自会重试。
    } finally {
      this.running = false;
    }
  }

  /**
   * 新 SSE 客户端接入：先无条件补一帧上次快照（帧是广播，值没变也得补，
   * 否则这个连接要等到下一次源变更），再后台对一次账补差量。
   */
  onSubscriberJoin(): void {
    if (this.lastCounts !== null) {
      this.lastFingerprint = JSON.stringify(this.lastCounts);
      this.bus.emit({ key: 'updates', payload: { counts: this.lastCounts } });
    }
    void this.refreshNow(true);
  }
}
