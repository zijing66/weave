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

/** 认证态是 SSE 的门：stub `/auth/status` 置已登录后再订阅（真实路径 refreshAuth）。 */
async function markAuthenticated(): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ authenticated: true }), { status: 200 })),
  );
  const { refreshAuth } = await import('../auth');
  await refreshAuth();
}

describe('lib/sse', () => {
  beforeEach(() => {
    FakeEventSource.latest = null;
    vi.resetModules(); // 模块级 handlers/invalidators/source 每个用例都要是干净的
  });

  it('懒创建：首次订阅才建连接，多个订阅者共用同一条；退订不关流', async () => {
    await markAuthenticated();
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

  it('未登录不建连；认证态翻到已登录即补连', async () => {
    const { subscribeSse } = await import('../sse');
    const off = subscribeSse(() => {});
    expect(FakeEventSource.latest).toBeNull(); // 未登录：连上也是 401，不建连

    await markAuthenticated();
    expect(FakeEventSource.latest).not.toBeNull(); // 认证态订阅者把既有订阅补连
    off();
  });

  it('invalidate 帧按 key 调注册的重拉函数；push / 未注册 / 已退订都不调', async () => {
    await markAuthenticated();
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

  it('同一 key 的多个注册者都被调到，退订只摘自己', async () => {
    await markAuthenticated();
    const { subscribeSse, registerInvalidator } = await import('../sse');
    const offSubscribe = subscribeSse(() => {});
    const calls: string[] = [];
    // 三处都关心 settings（设置弹窗 / 会话面板能力矩阵 / AI 助手浮层），
    // 单槽 Map 时只有最后注册的那个收得到——AI 助手就落后成「要刷新页面才出现」。
    const offA = registerInvalidator('settings', () => calls.push('a'));
    const offB = registerInvalidator('settings', () => calls.push('b'));
    const offC = registerInvalidator('settings', () => calls.push('c'));
    const source = FakeEventSource.latest!;

    source.emit({ type: 'invalidate', key: 'settings' });
    expect(calls).toEqual(['a', 'b', 'c']);

    offB();
    source.emit({ type: 'invalidate', key: 'settings' });
    expect(calls.slice(3)).toEqual(['a', 'c']); // 摘了 b，其余照旧

    offA();
    offC();
    expect(() => source.emit({ type: 'invalidate', key: 'settings' })).not.toThrow();
    expect(calls.length).toBe(5); // 全退订后没人接，也不炸

    offSubscribe();
  });
});
