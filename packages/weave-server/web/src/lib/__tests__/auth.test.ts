import { describe, it, expect, beforeEach, vi } from 'vitest';

/** lib/auth：认证态 store + 登录语义（网络层全 stub，不碰真实 daemon）。 */

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => handler(String(input))),
  );
}

describe('lib/auth', () => {
  beforeEach(() => {
    vi.resetModules(); // 模块级 state/listeners 每个用例都要干净
  });

  it('refreshAuth：已登录 / 未登录两态；不可达保持现状', async () => {
    const { authState, refreshAuth } = await import('../auth');

    stubFetch(() => new Response(JSON.stringify({ authenticated: true }), { status: 200 }));
    await refreshAuth();
    expect(authState()).toBe('authenticated');

    stubFetch(() => new Response(JSON.stringify({ authenticated: false }), { status: 200 }));
    await refreshAuth();
    expect(authState()).toBe('anonymous');

    stubFetch(() => {
      throw new Error('daemon down');
    });
    await refreshAuth(); // 不可达：不翻态（daemon 没起来不该被甩到登录页）
    expect(authState()).toBe('anonymous');
  });

  it('login：错密码抛 AuthError(401) 且不翻态；成功翻已登录', async () => {
    const { AuthError, authState, login } = await import('../auth');

    stubFetch(() => new Response(JSON.stringify({ error: 'Invalid password' }), { status: 401 }));
    await expect(login('nope')).rejects.toBeInstanceOf(AuthError);
    expect(authState()).toBe('unknown');

    stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await login('right-password');
    expect(authState()).toBe('authenticated');
  });

  it('markUnauthorized（401 钩子）与 logout 都回匿名', async () => {
    const { markUnauthorized, logout, authState, refreshAuth } = await import('../auth');

    stubFetch(() => new Response(JSON.stringify({ authenticated: true }), { status: 200 }));
    await refreshAuth();
    expect(authState()).toBe('authenticated');

    markUnauthorized(); // 任一 API 401 → 回登录页
    expect(authState()).toBe('anonymous');

    stubFetch(() => new Response(JSON.stringify({ authenticated: true }), { status: 200 }));
    await refreshAuth();
    stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await logout();
    expect(authState()).toBe('anonymous');
  });
});
