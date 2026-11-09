import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as netCreate } from 'node:net';
import { generate } from 'selfsigned';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { PeerRepository, tokenFileOf } from '../../repositories/peers.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { createWeaveServer } from '../../daemon/server.js';
import { MessageDeliverer } from '../../hooks/message-deliverer.js';
import { HookEventBus } from '../../hooks/bus.js';
import { resetPairingForTest } from '../../daemon/federation-routes.js';
import { certFingerprint, peerLiveness, FEDERATION_SERVICES, capsSummary } from '../../daemon/federation.js';
import { writePeerToken, readPeerToken } from '../../daemon/peer-tokens.js';
import { maskPath, originOf, type ApiLogOrigin } from '../../daemon/api-log.js';
import { parsePeerTarget } from '../../hooks/delivery/peer.js';

/**
 * F1 跨机投递闭环（服务端半边）：caps 互报（服务表 = 默认拒绝的白名单，红线
 * = /mcp* 不进表）、/federation/call 的 per-peer token 门与未知 service 404、
 * pairing 出站（mock 对端）、心跳判离线（fake timers）、api-log peer 档。
 */

function freePort(): Promise<number> {
  const probe = netCreate();
  return new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
  }).finally(() => new Promise<void>((resolve) => probe.close(() => resolve())));
}

const rest = async (
  port: number,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const res = await fetch(`http://127.0.0.1:${port}/api${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

describe('F1 federation（跨机投递闭环）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let tokenDir: string;
  let peers: PeerRepository;
  const pemsPromise = generate([{ name: 'commonName', value: 'weave-daemon' }], { keySize: 2048 });
  let ownFp = '';

  beforeAll(async () => {
    ownFp = certFingerprint((await pemsPromise).cert)!;
    db = openDatabase(':memory:');
    new ProjectRepository(db).register({ path: 'D:/proj-f1', name: 'proj-f1', token: 't', source: 'scan' });
    peers = new PeerRepository(db);
    tokenDir = mkdtempSync(path.join(tmpdir(), 'weave-f1-'));
    port = await freePort();
    const hookEventsRepo = new HookEventRepository(db);
    server = createWeaveServer({
      projects: new ProjectRepository(db),
      port,
      peers,
      peerTokensDir: tokenDir,
      ownCertPem: (await pemsPromise).cert,
      ownHostname: 'host-f1',
      ownFingerprint: ownFp,
      // call 的只读/投递行要真走本机服务：sessions.list 查 hookSessions、
      // inject 走真 MessageDeliverer（claude 面 + UserPromptSubmit 事件 → surface 可判）。
      hookSessions: new SessionRepository(db),
      hookEvents: hookEventsRepo,
      messageDeliverer: new MessageDeliverer({
        sessions: new SessionRepository(db),
        projects: new ProjectRepository(db),
        hookEvents: hookEventsRepo,
        bus: new HookEventBus(),
        hooksDir: mkdtempSync(path.join(tmpdir(), 'weave-f1-hooks-')),
      }),
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    server.close();
    db.close();
    rmSync(tokenDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetPairingForTest();
  });

  it('GET /federation/caps：per-peer token 门（错 token 403）+ 服务表外露 + /mcp* 永不进表', async () => {
    // 无 token → 403（caps 也不白给）
    expect((await rest(port, 'GET', '/federation/caps')).status).toBe(403);
    expect((await rest(port, 'GET', '/federation/caps', undefined, { authorization: 'Bearer nope-not-a-token' })).status).toBe(403);

    const offer = await rest(port, 'POST', '/federation/pairing/offer');
    const swapped = await rest(port, 'POST', '/federation/pair', {
      code: offer.body.code as string,
      name: 'peer-caps',
      fingerprint: 'c'.repeat(64),
    });
    expect(swapped.status).toBe(200);
    const token = swapped.body.token as string;

    const caps = await rest(port, 'GET', '/federation/caps', undefined, { authorization: `Bearer ${token}` });
    expect(caps.status).toBe(200);
    expect(caps.body.hostname).toBe('host-f1');
    expect(caps.body.fingerprint).toBe(ownFp);
    const services = caps.body.services as Array<{ service: string; effect: string }>;
    const names = services.map((s) => s.service);
    expect(names).toContain('inject');
    expect(names).toContain('sessions.list');
    expect(names).toContain('sessions.events');
    // 红线（2026-11-08 裁决 15③）：raw MCP HTTP 端点绝不进外露服务表
    for (const n of names) expect(n.startsWith('mcp')).toBe(false);
    for (const n of names) expect(n.startsWith('/mcp')).toBe(false);
    // 副作用标注在表（只读 / delivering）
    expect(services.find((s) => s.service === 'inject')!.effect).toBe('delivering');
    expect(services.find((s) => s.service === 'sessions.list')!.effect).toBe('readonly');
    // caps 摘要短码 ≤255 字节（mDNS TXT 约束）
    expect(capsSummary().length).toBeLessThanOrEqual(255);
  });

  it('POST /federation/call：per-peer token 门 + inject 落地（走真 MessageDeliverer）+ 未知 service 404', async () => {
    const offer = await rest(port, 'POST', '/federation/pairing/offer');
    const swapped = await rest(port, 'POST', '/federation/pair', {
      code: offer.body.code as string,
      name: 'peer-call',
      fingerprint: 'd'.repeat(64),
    });
    const token = swapped.body.token as string;

    // 无 token / 错 token → 403
    expect((await rest(port, 'POST', '/federation/call', { service: 'inject', params: {} })).status).toBe(403);
    expect(
      (await rest(port, 'POST', '/federation/call', { service: 'inject', params: {} }, { authorization: 'Bearer bad' })).status,
    ).toBe(403);

    // 未知 service = 404（默认拒绝：表里没有就不可触达）
    const unknown = await rest(
      port,
      'POST',
      '/federation/call',
      { service: 'mcp.sessions.list', params: {} },
      { authorization: `Bearer ${token}` },
    );
    expect(unknown.status).toBe(404);

    // 只读查询走通（sessions.list = 最小字段集）
    const listed = await rest(
      port,
      'POST',
      '/federation/call',
      { service: 'sessions.list', params: { limit: 10 } },
      { authorization: `Bearer ${token}` },
    );
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body.sessions)).toBe(true);

    // inject：本地会话存在 → 走真 MessageDeliverer（claude 面，inject 通道）
    const hookEvents = new HookEventRepository(db);
    hookEvents.insert({ projectId: 1, source: 'claude', eventType: 'UserPromptSubmit', sessionId: 'sess-f1', payload: '{}' });
    new SessionRepository(db).touch('sess-f1', 1);
    const injected = await rest(
      port,
      'POST',
      '/federation/call',
      { service: 'inject', params: { sessionId: 'sess-f1', text: 'hello from peer', fromPeerName: 'peer-call' } },
      { authorization: `Bearer ${token}` },
    );
    expect(injected.status).toBe(202);
    expect(injected.body.ok).toBe(true);
    expect(injected.body.status).toBe('injected');
    // 心跳副带：call 能过门 = lastSeenAt 已被刷新
    expect(peers.list().find((p) => p.name === 'peer-call')!.lastSeenAt).toBeTruthy();
  });

  it('pairing 出站全链：mock 对端 /federation/pair（token 落盘 + TOFU mismatch 拒）', async () => {
    // mock 对端：本地 https server 假装对端（联邦出站恒 HTTPS + TOFU pin——
    // 出站侧对本机证书首见即信，指纹落 peer 行）。
    const peerToken = 'issued-by-peer-0123456789abcdef';
    const peerFp = 'e'.repeat(64);
    let pairCalls = 0;
    const mockPeerPort = await freePort();
    const { createServer } = await import('node:https');
    const peerPems = await generate([{ name: 'commonName', value: 'host-b' }], { keySize: 2048 });
    const mock = createServer(
      { key: peerPems.private, cert: peerPems.cert },
      (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          let raw = '';
          req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
          await new Promise<void>((r) => req.on('end', r));
          if (req.url === '/federation/pair' && req.method === 'POST') {
            const body = JSON.parse(raw || '{}') as { code?: string };
            if (body.code === '999999') {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: 'refused: pairing offer missing' }));
              return;
            }
            pairCalls++;
            res.statusCode = 200;
            res.end(
              JSON.stringify({
                peerId: 'peer-uuid-from-b',
                token: pairCalls === 1 ? peerToken : 'second-token',
                fingerprint: pairCalls === 1 ? peerFp : 'f'.repeat(64), // 第二次证书变了
                hostname: 'host-b',
              }),
            );
            return;
          }
          res.statusCode = 404;
          res.end('{}');
        })();
      },
    );
    await new Promise<void>((resolve) => mock.listen(mockPeerPort, '127.0.0.1', resolve));

    try {
      // 拒绝路径：对端 403（短码无效）
      const refused = await rest(port, 'POST', '/federation/pairing/initiate', {
        name: 'peer-b', host: '127.0.0.1', port: mockPeerPort, code: '999999',
      });
      expect(refused.status).toBe(403);

      // 正常路径：对端 200 → peer 行落库（host/port/指纹）+ per-peer token 落盘
      const ok = await rest(port, 'POST', '/federation/pairing/initiate', {
        name: 'peer-b', host: '127.0.0.1', port: mockPeerPort, code: '123456',
      });
      expect(ok.status).toBe(200);
      const row = peers.list().find((p) => p.name === 'peer-b')!;
      expect(row.host).toBe('127.0.0.1');
      expect(row.port).toBe(mockPeerPort);
      expect(row.fingerprint).toBe(peerFp);
      expect(row.source).toBe('pairing');
      expect(readPeerToken(tokenDir, row.id, tokenFileOf)?.token).toBe(peerToken);

      // TOFU mismatch：同 peer 再 initiate，对端回不同指纹 → 409 + 明说要重 pairing
      const mismatch = await rest(port, 'POST', '/federation/pairing/initiate', {
        name: 'peer-b', host: '127.0.0.1', port: mockPeerPort, code: '123457',
      });
      expect(mismatch.status).toBe(409);
      expect(String(mismatch.body.error)).toMatch(/re-pair/i);
    } finally {
      mock.close();
    }
  });

  it('peerLiveness：90s 判 offline（心跳出站停走即离线）', () => {
    vi.useFakeTimers();
    const now = Date.now();
    expect(peerLiveness(null, now)).toBe('never-seen');
    expect(peerLiveness(new Date(now - 30_000).toISOString(), now)).toBe('online');
    expect(peerLiveness(new Date(now - 89_000).toISOString(), now)).toBe('online');
    expect(peerLiveness(new Date(now - 91_000).toISOString(), now)).toBe('offline');
    vi.useRealTimers();
  });

  it('api-log：/federation 对端门 = peer 档；webhook 扇入路径脱敏', () => {
    const mkReq = (url: string, headers: Record<string, string> = {}) =>
      ({ headers, url }) as unknown as IncomingMessage;
    expect(originOf(mkReq('/federation/call'))).toBe<ApiLogOrigin>('peer');
    expect(originOf(mkReq('/federation/heartbeat'))).toBe<ApiLogOrigin>('peer');
    expect(originOf(mkReq('/federation/pair'))).toBe<ApiLogOrigin>('peer');
    expect(originOf(mkReq('/federation/caps'))).toBe<ApiLogOrigin>('peer');
    expect(originOf(mkReq('/federation/peers'))).toBe<ApiLogOrigin>('user');
    expect(originOf(mkReq('/federation/pairing/offer'))).toBe<ApiLogOrigin>('user');
    // x-weave-origin 头优先（peer 侧请求可自带）
    expect(originOf(mkReq('/api/other', { 'x-weave-origin': 'peer' }))).toBe<ApiLogOrigin>('peer');
    expect(maskPath('/webhooks/extensions/secret-token-xyz?x=1')).toBe('/webhooks/extensions/[redacted]?x=1');
  });
});

describe('peer 目标解析（hooks/delivery/peer）', () => {
  it('parsePeerTarget：peer:<name>/<sessionId> 双段切分', () => {
    expect(parsePeerTarget('peer:lab-box/abc-123')).toEqual({ peerName: 'lab-box', sessionId: 'abc-123' });
    expect(parsePeerTarget('local-session')).toBeNull();
    expect(parsePeerTarget('peer:noname')).toBeNull();
  });
});
