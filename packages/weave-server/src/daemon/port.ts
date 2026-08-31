import net from 'node:net';

export const DEFAULT_PORT = 6420;
export const DAEMON_HOST = '127.0.0.1';

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
