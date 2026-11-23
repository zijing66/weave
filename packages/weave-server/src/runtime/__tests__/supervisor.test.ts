import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../db/db.js';
import { AgentInstanceRepository } from '../../repositories/agent-instances.js';
import { dataRoots, getAuthPath } from '../../db/paths.js';
import { runtimePipePath, RUNTIME_PROTOCOL_VERSION } from '../protocol.js';
import { RuntimeSupervisor } from '../supervisor.js';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 断线自愈 / single-flight / 停机不复活（守护 6 项的服务端闸）：
 * 假 Host 走真 Named Pipe——客户端、握手、断线回调全是真实链路。
 */
describe('RuntimeSupervisor 守护', () => {
  let dataDir: string;
  let db: DatabaseSync;
  let server: Server;
  let sockets: Set<Socket>;
  let connections: number;
  let pipePath: string;
  let spawnCalls: number;
  let current: RuntimeSupervisor | null = null;

  /** 假 Host 回报的实例清单（测试用例可改写；空 = 无实例）。 */
  let fakeInstances: Array<{ id: string; status: string }> = [];

  const startFakeHost = (): Promise<void> =>
    new Promise((resolve) => {
      server = createServer((socket) => {
        connections += 1;
        sockets.add(socket);
        socket.setEncoding('utf8');
        let buf = '';
        socket.on('data', (chunk: string) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            let msg: { id?: string; type?: string };
            try {
              msg = JSON.parse(line) as { id?: string; type?: string };
            } catch {
              continue;
            }
            if (msg.id == null) continue;
            const payload =
              msg.type === 'hello'
                ? { hostId: 'fake-host', protocolVersion: RUNTIME_PROTOCOL_VERSION, weaveVersion: 'test', instances: [] }
                : msg.type === 'instances.list'
                  ? { instances: fakeInstances }
                  : {};
            socket.write(JSON.stringify({ id: msg.id, success: true, payload }) + '\n');
          }
        });
        socket.on('close', () => sockets.delete(socket));
      });
      server.listen(pipePath, () => resolve());
    });

  const makeSupervisor = (): RuntimeSupervisor => {
    const sup = new RuntimeSupervisor(
      new AgentInstanceRepository(db),
      dataDir,
      () => {},
      async () => {
        spawnCalls += 1;
      },
    );
    current = sup;
    return sup;
  };

  const waitUntil = async (fn: () => boolean): Promise<void> => {
    for (let i = 0; i < 500; i++) {
      if (fn()) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error('condition not met');
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'weave-sup-'));
    const local = dataRoots(dataDir).local;
    mkdirSync(local, { recursive: true });
    writeFileSync(getAuthPath(dataDir), JSON.stringify({ localToken: 'test-token' }));
    pipePath = runtimePipePath(dataRoots(dataDir).data);
    db = openDatabase(':memory:');
  });

  afterAll(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // 只 fake 毫秒计时器：setImmediate / I/O 留真——waitUntil 靠它们推进
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    sockets = new Set();
    connections = 0;
    spawnCalls = 0;
    fakeInstances = [];
    await startFakeHost();
  });

  afterEach(async () => {
    // 跨测试不留活 supervisor：它的自愈定时器会在别的测试里重连这条 pipe
    current?.stop();
    current = null;
    // 先毁连接再关监听：server.close 的回调要等所有连接断开才回
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.useRealTimers();
  });

  it('并发 ensureHost 共享一次连接（single-flight）', async () => {
    const sup = makeSupervisor();
    await sup.ensureHost();
    // 已连即复用：再调直接返回，不起第二条连接
    const before = connections;
    await sup.ensureHost();
    expect(connections).toBe(before);
    expect(spawnCalls).toBe(0);
  });

  it('连接失败时并发调用只 spawn 一次', async () => {
    // 假 Host 停掉 → 连接必失败 → 走 spawn 桩
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const sup = makeSupervisor();
    const [a, b] = await Promise.allSettled([sup.ensureHost(), sup.ensureHost()]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect(spawnCalls).toBe(1);
  });

  it('运行中断线后 30s 自动重连（自愈）', async () => {
    const sup = makeSupervisor();
    let reachable: boolean | null = null;
    sup.onStatus((v) => (reachable = v));
    await sup.ensureHost();
    expect(reachable).toBe(true);
    // 服务端掐掉连接 → 断线回调 → 重试上闸
    for (const s of [...sockets]) s.destroy();
    await waitUntil(() => reachable === false);
    expect(sup.connected).toBe(false);
    // 断线后没有任何新请求（这正是旧缺口的窗口）——只靠定时器自愈
    await vi.advanceTimersByTimeAsync(30_000 + 5_000);
    await waitUntil(() => sup.connected);
    expect(reachable).toBe(true);
  });

  it('stop 后不再重连/拉起（手动停止不复活）', async () => {
    const sup = makeSupervisor();
    await sup.ensureHost();
    sup.stop();
    for (const s of [...sockets]) s.destroy();
    await waitUntil(() => !sup.connected);
    const before = connections;
    await vi.advanceTimersByTimeAsync(120_000);
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    expect(sup.connected).toBe(false);
    expect(connections).toBe(before); // 没有重连
    await expect(sup.ensureHost()).rejects.toThrow();
    expect(spawnCalls).toBe(0);
  });

  it('孤儿只报增量：同一枚孤儿连拍不重复刷屏，消失后重报', async () => {
    const logs: string[] = [];
    const sup = new RuntimeSupervisor(
      new AgentInstanceRepository(db),
      dataDir,
      (m) => logs.push(m),
      async () => {
        spawnCalls += 1;
      },
    );
    current = sup;
    await sup.ensureHost();
    fakeInstances = [{ id: 'wvt-orphan-1', status: 'running' }];
    const first = await sup.reconcile();
    expect(first.orphans.map((o) => o.id)).toEqual(['wvt-orphan-1']);
    expect(logs.filter((m) => m.includes('wvt-orphan-1'))).toHaveLength(1);
    // 同一枚再来一拍：不重复报
    const second = await sup.reconcile();
    expect(second.orphans.map((o) => o.id)).toEqual(['wvt-orphan-1']);
    expect(logs.filter((m) => m.includes('wvt-orphan-1'))).toHaveLength(1);
    // 孤儿消失（Host 清空）后：集合除名，再现身时重报
    fakeInstances = [];
    await sup.reconcile();
    fakeInstances = [{ id: 'wvt-orphan-1', status: 'running' }];
    await sup.reconcile();
    expect(logs.filter((m) => m.includes('wvt-orphan-1'))).toHaveLength(2);
  });
});
