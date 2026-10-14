import type { DataBus } from './data-bus.js';
import type { HookEventBus } from '../hooks/bus.js';

/**
 * InflightCountsRefresher — 会话行「在途消息」角标的数据面（SSE 推送）。
 *
 * 与 TerminalCountsRefresher 同形状（指纹去重、值变才推），但**没有定时器**：
 * 在途计数的变化源全是事件（`message.*` 帧），所以由 hook 帧驱动重算即可——
 * 前端零定时器、零轮询，只看到一个推来的帧。推的是**绝对值快照**：漏帧的
 * 客户端在下一次事件自我校正，不累积漂移。
 */

export class InflightCountsRefresher {
  /** 上次推送的取值指纹；相同则不再推（只推变化）。 */
  private lastFingerprint: string | null = null;

  constructor(
    /** 现算一份在途计数（sessionId → 条数）。 */
    private readonly snapshot: () => Map<string, number>,
    private readonly bus: DataBus,
    hookBus: HookEventBus,
  ) {
    hookBus.subscribe((message) => {
      if (message.kind.startsWith('message.')) this.push();
    });
  }

  /** 新 SSE 客户端接入时补一份快照（否则首帧要等到下一次消息事件）。 */
  refreshNow(): void {
    this.push();
  }

  private push(): void {
    // 键序排序：指纹去重靠稳定序列化，Map 的插入序会随落点变化而抖
    const snapshot = this.snapshot();
    const counts: Record<string, number> = {};
    for (const sessionId of [...snapshot.keys()].sort()) {
      counts[sessionId] = snapshot.get(sessionId)!;
    }
    const fingerprint = JSON.stringify(counts);
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.bus.emit({ key: 'inflightCounts', payload: { counts } });
  }
}
