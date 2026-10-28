import { openSync, readSync, closeSync, statSync } from 'node:fs';
import type { HookEventBus } from '../hooks/bus.js';
import type { NarrationSurface, NarrationText } from '@weavecode/harness';

/**
 * 旁白增量监视器：宿主写转录没有 hook 事件照会，但**每条 hook 事件本身就是
 * 「转录刚被写过」的信号**（同一轮里宿主先写转录再发 hook）。订阅 hookBus 的
 * `event.ingested`，per-session debounce 聚合突发，然后**字节游标增量读**转录
 * ——只碰新增字节，半行存 carry，新段经 `narration.updated` 帧广播（读一次
 * 服务所有标签页，web 零轮询）。
 *
 * 游标与 carry 只在内存：daemon 重启后首拍全量重读（转录是 append-only，
 * 重读即重建游标，代价一次全量扫描——与 web 初载同价）。
 */

/** 同一会话突发事件的聚合窗：宿主一轮里事件一票接一票，每票都读就失去增量意义。 */
const DEBOUNCE_MS = 500;
/** 单会话游标态。 */
interface Cursor {
  /** 已消费的字节数。 */
  offset: number;
  /** 尾部不完整的半行（等下一拍补齐再 parse）。 */
  carry: string;
  /** 转录路径变了（压缩重建 / resume 换文件）→ 游标作废重读。 */
  path: string;
}

/** 广播出去的一帧。 */
export interface NarrationUpdatedFrame {
  kind: 'narration.updated';
  sessionId: string;
  /** 本拍新认出的段（时间序）。 */
  segs: NarrationText[];
  at: string;
}

export class NarrationWatcher {
  private readonly cursors = new Map<string, Cursor>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private off: (() => void) | null = null;

  constructor(
    private readonly bus: HookEventBus,
    private readonly surfaceOf: (harness: string) => NarrationSurface | null,
    private readonly pathOf: (sessionId: string) => string | null,
    private readonly harnessOf: (sessionId: string) => string | null,
  ) {}

  /** 挂上 hookBus（daemon 装配时调一次）。 */
  start(): void {
    if (this.off) return;
    this.off = this.bus.subscribe((message) => {
      if (message.kind !== 'event.ingested' || !message.sessionId) return;
      this.schedule(message.sessionId);
    });
  }

  stop(): void {
    this.off?.();
    this.off = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(sessionId: string): void {
    const hit = this.timers.get(sessionId);
    if (hit) return; // 已有一拍在等：聚合
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        void this.pump(sessionId);
      }, DEBOUNCE_MS),
    );
  }

  /** 测试口：跳过 debounce 直接泵一次（装配不变）。 */
  pumpForTest(sessionId = 'test'): Promise<void> {
    return this.pump(sessionId);
  }

  /** 一拍：增量读该会话转录的新增字节，新段广播。 */
  private async pump(sessionId: string): Promise<void> {
    const harness = this.harnessOf(sessionId);
    const surface = harness ? this.surfaceOf(harness) : null;
    const parser = surface?.lineParser;
    const path = this.pathOf(sessionId);
    if (!parser || !path) return;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      this.cursors.delete(sessionId); // 文件没了（清理/换文件）：游标作废
      return;
    }
    const cur = this.cursors.get(sessionId);
    // 首拍 / 路径变了 / 文件被截断重写：游标作废，全量重读重建（append-only 转录
    // 的代价 = 一次全量扫描，与 web 初载同价；不广播历史段——web 初载自己拉）。
    if (!cur || cur.path !== path || size < cur.offset) {
      this.cursors.set(sessionId, { offset: size, carry: '', path });
      return;
    }
    if (size === cur.offset) return; // 没有新字节
    let text: string;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(size - cur.offset);
      readSync(fd, buf, 0, buf.length, cur.offset);
      text = buf.toString('utf8');
    } catch {
      return;
    } finally {
      closeSync(fd);
    }
    const lines = (cur.carry + text).split('\n');
    cur.carry = lines.pop() ?? ''; // 尾段是半行（宿主写到一半），留给下一拍
    cur.offset = size;
    const segs: NarrationText[] = [];
    for (const line of lines) {
      const seg = parser(line);
      if (seg) segs.push(seg);
    }
    if (segs.length > 0) {
      this.bus.emit({
        kind: 'narration.updated',
        sessionId,
        segs,
        at: new Date().toISOString(),
      } satisfies NarrationUpdatedFrame);
    }
  }
}
