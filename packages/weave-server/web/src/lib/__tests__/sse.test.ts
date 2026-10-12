import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * lib/sse 的两条契约：
 *   1. 全站只有一条连接（懒创建、退订不关）——这是「单个 SSE 接口」的实现基础；
 *   2. `invalidate` 帧按 key 分发到注册的重拉函数，`push` 帧不走这条路
 *      （push 由订阅者自己写状态）。
 */

/** 最小 EventSource 替身：只保留 lib/sse 用到的那几面。 */
class FakeEventSource {
  static latest: FakeEventSource | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.latest = this;
  }

  close(): void {
    this.closed = true;
  }

  /** 推一帧（序列化后走 onmessage，和真实链路一致）。 */
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

vi.stubGlobal('EventSource', FakeEventSource);

describe('lib/sse', () => {
  beforeEach(() => {
    FakeEventSource.latest = null;
    vi.resetModules(); // 模块级 handlers/invalidators/source 每个用例都要是干净的
  });

  it('懒创建：首次订阅才建连接，多个订阅者共用同一条；退订不关流', async () => {
    const { subscribeSse } = await import('../sse');

    const offA = subscribeSse(() => {});
    const source = FakeEventSource.latest;
    expect(source).not.toBeNull();

    const offB = subscribeSse(() => {});
    expect(FakeEventSource.latest).toBe(source); // 没有第二条连接

    offA();
    offB();
    expect(source!.closed).toBe(false); // SPA 生命周期内复用，不因没人听就断
  });

  it('invalidate 帧按 key 调注册的重拉函数；push / 未注册 / 已退订都不调', async () => {
    const { subscribeSse, registerInvalidator } = await import('../sse');
    const offSubscribe = subscribeSse(() => {});
    const calls: string[] = [];
    const offInvalidator = registerInvalidator('projects', () => calls.push('projects'));
    const source = FakeEventSource.latest!;

    source.emit({ type: 'invalidate', key: 'projects' });
    expect(calls).toEqual(['projects']);

    // push 帧带 payload = 后端已算好，由订阅者写状态，不该触发重拉
    source.emit({ type: 'push', key: 'projects', payload: { counts: { 1: 2 } } });
    expect(calls).toEqual(['projects']);

    source.emit({ type: 'invalidate', key: 'nobody-registered' }); // 未注册不炸
    expect(calls).toEqual(['projects']);

    offInvalidator();
    source.emit({ type: 'invalidate', key: 'projects' });
    expect(calls).toEqual(['projects']); // 退订后不再触发

    offSubscribe();
  });
});
