import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { isPortFree, findFreePort } from '../daemon/port.js';

function listenOnEphemeral(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

describe('port', () => {
  it('reports a free port as free', async () => {
    const port = await findFreePort(20000);
    expect(await isPortFree(port)).toBe(true);
  });

  it('reports an occupied port as not free', async () => {
    const { server, port } = await listenOnEphemeral();
    expect(await isPortFree(port)).toBe(false);
    server.close();
  });

  it('findFreePort skips an occupied starting port', async () => {
    const { server, port } = await listenOnEphemeral();
    const found = await findFreePort(port);
    expect(found).not.toBe(port);
    expect(await isPortFree(found)).toBe(true);
    server.close();
  });
});
