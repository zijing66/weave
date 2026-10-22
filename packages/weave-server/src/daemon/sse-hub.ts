import { randomBytes } from 'node:crypto';
import type { WatchService } from '../watch/watch-service.js';
import type { HookEventBus } from '../hooks/bus.js';
import type { DataBus } from './data-bus.js';

/**
 * 事件流中枢：三个源只订阅一次 → 编号 + 环形缓冲 → 每个连接各写一份。
 *
 * 编号只为「断流重连补发」服务：客户端把最后收到的帧 id（`<纪元>-<序号>`）带回来，
 * 这里把中间漏掉的帧原样重放。缓冲有限、且没有连接时压根不订阅源（隐藏刷新器
 * 靠 `DataBus.hasSubscribers()` 判断有没有人在看，不能因为中枢常驻而被永远唤醒），
 * 所以补不齐是常态的一种：那会儿回 `gap`，由前端整页刷新——宁可重来一遍，
 * 也不留一个悄悄缺帧的界面。
 */

/** 环形缓冲上限：几百帧足够覆盖一次普通断流，再多就不值得占内存了。 */
const SSE_BUFFER_MAX = 1000;

/** 最后一个连接走后再挂一会儿：刷新页面、网络抖动、判死重建都落在这一分钟内，
 *  落在里面就还是同一条连续的流（不用整页重来）。 */
const UNWIRE_GRACE_MS = 60_000;

export interface SseSources {
  watch?: Pick<WatchService, 'subscribe' | 'subscribeProjects'>;
  hookBus?: HookEventBus;
  dataBus?: DataBus;
  /** 首个连接（或宽限期后重新挂源）时回调：按需补发「连接即要」的快照帧。 */
  onAttach?: () => void;
}

export interface SseFrameOut {
  id: string;
  /** 已序列化的 JSON（重放时原样再写一遍，不重新拼）。 */
  data: string;
}

export class SseHub {
  /** 本进程的流纪元：daemon 重启后序号从头来，旧客户端的 offset 一看就不认。 */
  readonly epoch = randomBytes(4).toString('hex');
  private seq = 0;
  private readonly buffer: { seq: number; data: string }[] = [];
  private readonly subs = new Set<(frame: SseFrameOut) => void>();
  private detach: (() => void) | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 源被摘掉那一刻的序号：客户端拿着比它早（或正好）的 offset 回来，中间那段
   *  没人在听、帧是真的丢了，补不回来。 */
  private brokenAt = 0;

  constructor(private readonly sources: SseSources) {}

  /** 每个连接一个写出口；第一个连接进来才订阅源。返回退订。 */
  subscribe(fn: (frame: SseFrameOut) => void): () => void {
    this.subs.add(fn);
    this.attach();
    return () => {
      this.subs.delete(fn);
      if (this.subs.size === 0) this.scheduleDetach();
    };
  }

  /** 广播一帧：编号、入环、各写一份。 */
  push(payload: Record<string, unknown>): void {
    const seq = ++this.seq;
    const data = JSON.stringify(payload);
    this.buffer.push({ seq, data });
    if (this.buffer.length > SSE_BUFFER_MAX) this.buffer.shift();
    const frame = { id: this.frameId(seq), data };
    for (const fn of this.subs) fn(frame);
  }

  /** 断线重连：`offset` 之后的帧；补不齐（纪元不同 / 缓冲越界 / 中途没人听）→ gap。
   *  gap 时不给帧：那段历史已经不可信，前端要整页重来，补一半的帧只会白写一屏。 */
  replay(offset: string | null): { frames: SseFrameOut[]; gap: boolean } {
    if (!offset) return { frames: [], gap: false };
    const [epoch, raw] = offset.split('-');
    const since = Number(raw);
    if (epoch !== this.epoch || !Number.isInteger(since) || since < 0) {
      return { frames: [], gap: true };
    }
    const oldest = this.buffer[0]?.seq;
    if (since <= this.brokenAt || (oldest !== undefined && since < oldest - 1)) {
      return { frames: [], gap: true };
    }
    const frames = this.buffer
      .filter((f) => f.seq > since)
      .map((f) => ({ id: this.frameId(f.seq), data: f.data }));
    return { frames, gap: false };
  }

  private frameId(seq: number): string {
    return `${this.epoch}-${seq}`;
  }

  private attach(): void {
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.detach) return;
    this.sources.onAttach?.();
    const offs: Array<() => void> = [];
    const { watch, hookBus, dataBus } = this.sources;
    if (watch) {
      offs.push(watch.subscribe((e) => this.push({ type: 'asset', ...e })));
      offs.push(watch.subscribeProjects((e) => this.push({ type: 'project', ...e })));
    }
    if (hookBus) offs.push(hookBus.subscribe((message) => this.push({ type: 'hook', ...message })));
    // 数据变更帧：带 payload = 后端已算好（前端直写状态）；不带 = 失效键
    if (dataBus) {
      offs.push(
        dataBus.subscribe((frame) =>
          this.push({ type: frame.payload === undefined ? 'invalidate' : 'push', ...frame }),
        ),
      );
    }
    this.detach = () => {
      for (const off of offs) off();
    };
  }

  private scheduleDetach(): void {
    if (this.graceTimer !== null || !this.detach) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.brokenAt = this.seq;
      this.detach?.();
      this.detach = null;
    }, UNWIRE_GRACE_MS);
    this.graceTimer.unref?.();
  }
}
