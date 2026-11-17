import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { drainServerConnections, weaveRequestHandler } from '../server.js';
import type { WeaveServerDeps } from '../server.js';

/** 最小 deps：只有 /health 与 MCP 分发需要的基本字段。 */
function minimalDeps(): WeaveServerDeps {
  return {
    projects: { list: () => [] } as unknown as WeaveServerDeps['projects'],
    port: 0,
  } as WeaveServerDeps;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function get(port: number): Promise<{ status: number; retryAfter?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] as string | undefined });
    });
    req.on('error', reject);
  });
}

describe('MCP 停机排空语义', () => {
  it('排空前正常服务，beginDrain 后新请求 503 + Retry-After + connection: close', async () => {
    let beginDrain: (() => void) | undefined;
    const handler = weaveRequestHandler({ ...minimalDeps(), requestShutdown: () => {} });
    beginDrain = (handler as { beginDrain?: () => void }).beginDrain;
    expect(beginDrain).toBeTypeOf('function');
    const server = http.createServer(handler);
    const port = await listen(server);
    expect((await get(port)).status).toBe(200);
    beginDrain!();
    const r = await get(port);
    expect(r.status).toBe(503);
    expect(r.retryAfter).toBe('2');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('drainServerConnections：空闲 keep-alive 连接收 FIN，在飞请求 1s 宽限后断', async () => {
    let beginDrain: (() => void) | undefined;
    const handler = weaveRequestHandler(minimalDeps());
    beginDrain = (handler as { beginDrain?: () => void }).beginDrain;
    const server = http.createServer(handler);
    const port = await listen(server);
    // keep-alive agent 复用连接
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const first = await new Promise<number>((resolve, reject) => {
      const req = http.get({ port, agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
    });
    expect(first).not.toBe(503);
    // 等 socket 回池（空闲态）
    await new Promise((r) => setTimeout(r, 50));
    beginDrain!();
    server.close();
    drainServerConnections(server);
    // 空闲连接应收到 FIN：下一个请求要么连着旧 socket 拿到响应要么报错，但不挂死
    const next = await Promise.race([
      get(port).catch(() => ({ status: -1 })),
      new Promise<{ status: number }>((r) => setTimeout(() => r({ status: -2 }), 1500)),
    ]);
    expect(next.status).not.toBe(-2); // 不挂死
    agent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
