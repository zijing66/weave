import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleHooksRoutes } from '../hooks-routes.js';
import type { WeaveServerDeps } from '../server.js';

/** 全局安装前的优雅停机入口：本机令牌门之后只做一件事——跑 shutdown 链。 */
describe('POST /daemon/shutdown', () => {
  const call = async (
    method: string,
    deps: WeaveServerDeps,
  ): Promise<{ handled: boolean; status: number }> => {
    const req = Readable.from([Buffer.from('')]) as unknown as IncomingMessage;
    req.method = method;
    const res = {
      statusCode: 0,
      setHeader: () => {},
      writeHead: (code: number) => {
        res.statusCode = code;
      },
      end: () => {},
    };
    const url = new URL('/daemon/shutdown', 'http://x');
    const handled = await handleHooksRoutes(
      req,
      res as unknown as ServerResponse,
      deps,
      url.pathname,
      url,
    );
    return { handled, status: res.statusCode };
  };

  it('回 200 之后再跑停机链（先让响应落地）', async () => {
    const shutdown = vi.fn();
    const res = await call('POST', { requestShutdown: shutdown } as unknown as WeaveServerDeps);
    expect(res).toEqual({ handled: true, status: 200 });
    await new Promise((r) => setTimeout(r, 20));
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('没有接停机链的 daemon（测试替身）回 503 且不认领 GET', async () => {
    expect((await call('POST', {} as WeaveServerDeps)).status).toBe(503);
    const shutdown = vi.fn();
    const get = await call('GET', { requestShutdown: shutdown } as unknown as WeaveServerDeps);
    expect(get.handled).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
  });
});
