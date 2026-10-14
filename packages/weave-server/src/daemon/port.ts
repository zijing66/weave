import net from 'node:net';

export const DEFAULT_PORT = 6420;
/** 客户端连接目标（CLI / vite 代理）：连本机永远走回环。 */
export const DAEMON_HOST = '127.0.0.1';
/**
 * 服务端默认绑定地址（settings `server.bindHost` 可改回 127.0.0.1）。与上面的
 * DAEMON_HOST 是**两个概念**：那个是「客户端连哪」，这个是「服务端听哪」——
 * 绑 0.0.0.0 = 局域网可达，由 dashboard 密码认证兜底（见 daemon/auth.ts）。
 */
export const DEFAULT_BIND_HOST = '0.0.0.0';

/** Resolve `true` when the port can be bound (no existing listener). */
export function isPortFree(port: number, host: string = DAEMON_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** Find the first free port starting at `start`, scanning up to `maxScan` ports. */
export async function findFreePort(start: number, maxScan = 100): Promise<number> {
  for (let p = start; p < start + maxScan; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port found in range ${start}-${start + maxScan - 1}`);
}
