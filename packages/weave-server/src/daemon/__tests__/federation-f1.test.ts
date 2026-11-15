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
      orchestrations: new (await import('../../repositories/orchestrations.js')).OrchestrationRepository(db),
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

  it('会话共享范围：peer 的 scopeProjects 裁 sessions.list / sessions.events / inject（客户端无感知）', async () => {
    // 两个项目各一条会话：范围外的会话对 scoped peer 必须不可见、不可触达
    new ProjectRepository(db).register({ path: 'D:/proj-f1b', name: 'proj-f1b', token: 't2', source: 'scan' });
    const sessions = new SessionRepository(db);
    sessions.touch('sess-in-scope', 1);
    sessions.touch('sess-out-scope', 2);

    const offer = await rest(port, 'POST', '/federation/pairing/offer');
    const swapped = await rest(port, 'POST', '/federation/pair', {
      code: offer.body.code as string,
      name: 'peer-scope',
      fingerprint: 'b'.repeat(64),
    });
    const token = swapped.body.token as string;

    // 缺省 = 全量共享（存量语义不动）
    const all = await rest(
      port, 'POST', '/federation/call',
      { service: 'sessions.list', params: {} },
      { authorization: `Bearer ${token}` },
    );
    expect(all.status).toBe(200);
    expect((all.body.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId)).toContain('sess-out-scope');

    // PATCH 收窄到项目 1：客户端照原样调，拿到的就是子集
    const patched = await rest(port, 'PATCH', `/federation/peers/${swapped.body.peerId as string}`, { scopeProjects: [1] });
    expect(patched.status).toBe(200);
    expect(patched.body.peer.scopeProjects).toEqual([1]);

    const scoped = await rest(
      port, 'POST', '/federation/call',
      { service: 'sessions.list', params: {} },
      { authorization: `Bearer ${token}` },
    );
    expect(scoped.status).toBe(200);
    const scopedIds = (scoped.body.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId);
    expect(scopedIds).toContain('sess-in-scope');
    expect(scopedIds).toContain('sess-f1'); // 前序用例的项目 1 会话——范围内照常放行
    expect(scopedIds).not.toContain('sess-out-scope');

    // 范围外会话：events / inject 一并把关（范围闸不只在清单上）
    const evOut = await rest(
      port, 'POST', '/federation/call',
      { service: 'sessions.events', params: { sessionId: 'sess-out-scope' } },
      { authorization: `Bearer ${token}` },
    );
    expect(evOut.status).toBe(403);
    const injOut = await rest(
      port, 'POST', '/federation/call',
      { service: 'inject', params: { sessionId: 'sess-out-scope', text: 'x' } },
      { authorization: `Bearer ${token}` },
    );
    expect(injOut.status).toBe(403);
    // 范围内会话照常
    const evIn = await rest(
      port, 'POST', '/federation/call',
      { service: 'sessions.events', params: { sessionId: 'sess-in-scope' } },
      { authorization: `Bearer ${token}` },
    );
    expect(evIn.status).toBe(200);

    // 清回全量（不动别的测试的语义）
    await rest(port, 'PATCH', `/federation/peers/${swapped.body.peerId as string}`, { scopeProjects: null });
  });

  it('范围切面（ALS）：scoped peer 走扩面服务——projects.list / search / projects.files / sessions.list 全按范围裁', async () => {
    // 造数据：p1 会话带对话事件（标题命中搜索），p2 同构——scope=[p1] 的 peer 只见 p1
    const hookEvents = new HookEventRepository(db);
    const sessions = new SessionRepository(db);
    sessions.touch('sess-search-p1', 1);
    sessions.touch('sess-search-p2', 2);
    for (const [pid, sid, title] of [
      [1, 'sess-search-p1', 'alphahit-title'],
      [2, 'sess-search-p2', 'alphahit-title'],
    ] as const) {
      hookEvents.insert({
        projectId: pid,
        source: 'claude',
        eventType: 'UserPromptSubmit',
        sessionId: sid,
        payload: JSON.stringify({ raw: { prompt: `alphahit body on p${pid}` } }),
      });
      sessions.setTitle(sid, title);
    }

    const offer = await rest(port, 'POST', '/federation/pairing/offer');
    const swapped = await rest(port, 'POST', '/federation/pair', {
      code: offer.body.code as string,
      name: 'peer-als',
      fingerprint: 'a'.repeat(64),
    });
    const token = swapped.body.token as string;
    await rest(port, 'PATCH', `/federation/peers/${swapped.body.peerId as string}`, { scopeProjects: [1] });
    const call = (service: string, params: Record<string, unknown>) =>
      rest(port, 'POST', '/federation/call', { service, params }, { authorization: `Bearer ${token}` });

    // projects.list：只见 p1（p2 被裁，不是标不可见）
    const pl = await call('projects.list', {});
    expect(pl.status).toBe(200);
    const plIds = (pl.body.projects as Array<{ id: number }>).map((p) => p.id);
    expect(plIds).toContain(1);
    expect(plIds).not.toContain(2);

    // search：三路命中只含 p1 —— ALS 穿 HTTP 链的端到端证明
    const sr = await call('search', { q: 'alphahit' });
    expect(sr.status).toBe(200);
    expect((sr.body.sessions as Array<{ projectId: number }>).map((s) => s.projectId)).not.toContain(2);
    expect((sr.body.messages as Array<{ projectId: number }>).map((m) => m.projectId)).not.toContain(2);

    // projects.files：范围内浏览照常、范围外 403
    const pfIn = await call('projects.files', { projectId: 1, limit: 10 });
    expect(pfIn.status).toBe(200);
    expect(pfIn.body.root).toBeTruthy();
    const pfOut = await call('projects.files', { projectId: 2 });
    expect(pfOut.status).toBe(403);

    // sessions.list：p2 会话从清单消失（仓储层 ALS 裁，非内存 filter）
    const sl = await call('sessions.list', {});
    expect(sl.status).toBe(200);
    expect((sl.body.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId)).not.toContain('sess-search-p2');

    await rest(port, 'PATCH', `/federation/peers/${swapped.body.peerId as string}`, { scopeProjects: null });
  });

  it('副作用扩面：sessions.create / orchestration.trigger 过 caller 范围闸（表外仍 404）', async () => {
    const offer = await rest(port, 'POST', '/federation/pairing/offer');
    const swapped = await rest(port, 'POST', '/federation/pair', {
      code: offer.body.code as string,
      name: 'peer-write',
      fingerprint: '9'.repeat(64),
    });
    const token = swapped.body.token as string;
    await rest(port, 'PATCH', `/federation/peers/${swapped.body.peerId as string}`, { scopeProjects: [1] });
    const call = (service: string, params: Record<string, unknown>) =>
      rest(port, 'POST', '/federation/call', { service, params }, { authorization: `Bearer ${token}` });

    // sessions.create：范围外 403（闸在执行核之前，不暴露项目存在性——999 也 403）
    const scOut = await call('sessions.create', { projectId: 2 });
    expect(scOut.status).toBe(403);
    const scMissing = await call('sessions.create', { projectId: 999 });
    expect(scMissing.status).toBe(403);
    const scBad = await call('sessions.create', { projectId: 1, harness: 'nope' });
    expect(scBad.status).toBe(400);

    // orchestration.trigger：范围外挂靠的编排 403；需要编排仓储行
    const { OrchestrationRepository } = await import('../../repositories/orchestrations.js');
    const orchestrations = new OrchestrationRepository(db);
    const orchId = orchestrations.insert({
      name: 'fed-orch',
      projectId: 2,
      startText: '',
      nodes: [{ id: 't:x', kind: 'trigger' }],
      edges: [],
    }).id;
    const otOut = await call('orchestration.trigger', { orchestrationId: orchId });
    expect(otOut.status).toBe(403);

    await rest(port, 'PATCH', `/federation/peers/${swapped.body.peerId as string}`, { scopeProjects: null });
    // 清回全量后同一条编排可过闸（无 engine = 503 如实报因，不是 403）
    const otIn = await call('orchestration.trigger', { orchestrationId: orchId });
    expect(otIn.status).toBe(503);
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

describe('双实例回环（本机以跨机方式调自己的服务）', () => {
  /** 回环两实例都是 https：REST 走 https（自签证书，rejectUnauthorized 关——测试只关心业务）。 */
  const restTls = async (
    port: number,
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const res = await fetch(`https://127.0.0.1:${port}/api${url}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    } finally {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  };
  const restB = (method: string, url: string, body?: unknown, headers?: Record<string, string>) =>
    restTls(portB, method, url, body, headers);
  /**
   * 全真链路的「单机双面」验证：A 与 B 都是 https 真实例（各自自签证书 +
   * weaveRequestHandler 原样跑），互为联邦 peer。双向 pairing 出站（https+TOFU
   * 指纹比对走 node https 真通道）、A 用 `peer:` 目标投递 → B 收 inject、B 的
   * caller 视角经 call 门读 A。跑完即弃、不碰活库。
   */
  let dbA: DatabaseSync;
  let dbB: DatabaseSync;
  let httpsA: import('node:https').Server;
  let httpsB: import('node:https').Server;
  let portA: number;
  let portB: number;
  let tokenDirA: string;
  let tokenDirB: string;
  let delivererA: MessageDeliverer;

  beforeAll(async () => {
    portA = await freePort();
    portB = await freePort();
    dbA = openDatabase(':memory:');
    dbB = openDatabase(':memory:');
    new ProjectRepository(dbA).register({ path: 'D:/loop-a', name: 'loop-a', token: 'ta', source: 'scan' });
    new ProjectRepository(dbB).register({ path: 'D:/loop-b', name: 'loop-b', token: 'tb', source: 'scan' });
    tokenDirA = mkdtempSync(path.join(tmpdir(), 'weave-loop-a-'));
    tokenDirB = mkdtempSync(path.join(tmpdir(), 'weave-loop-b-'));
    const pemsA = await generate([{ name: 'commonName', value: 'host-loop-a' }], { keySize: 2048 });
    const pemsB = await generate([{ name: 'commonName', value: 'host-loop-b' }], { keySize: 2048 });
    const { createServer: httpsCreate } = await import('node:https');
    const { weaveRequestHandler } = await import('../../daemon/server.js');

    // A：https 真实例——peerRoute 全真（按名查 peers 表 + token 盘），出站走缺省
    // https+TOFU 通道（动态 import 那条，正是本回环要验的活装配路径）。
    const hookEventsA = new HookEventRepository(dbA);
    const peerRepoA = new PeerRepository(dbA);
    delivererA = new MessageDeliverer({
        sessions: new SessionRepository(dbA),
        projects: new ProjectRepository(dbA),
        hookEvents: hookEventsA,
        bus: new HookEventBus(),
        hooksDir: mkdtempSync(path.join(tmpdir(), 'weave-loop-a-hooks-')),
        peerRoute: (peerName) => {
          const row = peerRepoA.list().find((p) => p.name === peerName && p.enabled);
          if (!row) return null;
          const token = readPeerToken(tokenDirA, row.id, tokenFileOf)?.token;
          if (!token) return null;
          return { peerId: row.id, host: row.host, port: row.port, fingerprint: row.fingerprint, token };
        },
      });
    httpsA = httpsCreate(
      { key: pemsA.private, cert: pemsA.cert },
      weaveRequestHandler({
        projects: new ProjectRepository(dbA),
        port: portA,
        peers: peerRepoA,
        peerTokensDir: tokenDirA,
        ownCertPem: pemsA.cert,
        ownHostname: 'host-loop-a',
        ownFingerprint: certFingerprint(pemsA.cert),
        hookSessions: new SessionRepository(dbA),
        hookEvents: hookEventsA,
        messageDeliverer: delivererA,
      }),
    );
    await new Promise<void>((resolve) => httpsA.listen(portA, '127.0.0.1', resolve));

    // B：https 真实例——同一个请求处理器，TLS 全真（A 的 TOFU 指纹比对打在真证书上）
    const hookEventsB = new HookEventRepository(dbB);
    const peerRepoB = new PeerRepository(dbB);
    const delivererB = new MessageDeliverer({
      sessions: new SessionRepository(dbB),
      projects: new ProjectRepository(dbB),
      hookEvents: hookEventsB,
      bus: new HookEventBus(),
      hooksDir: mkdtempSync(path.join(tmpdir(), 'weave-loop-b-hooks-')),
      peerRoute: (peerName) => {
        const row = peerRepoB.list().find((p) => p.name === peerName && p.enabled);
        if (!row) return null;
        const token = readPeerToken(tokenDirB, row.id, tokenFileOf)?.token;
        if (!token) return null;
        return { peerId: row.id, host: row.host, port: row.port, fingerprint: row.fingerprint, token };
      },
    });
    httpsB = httpsCreate(
      { key: pemsB.private, cert: pemsB.cert },
      weaveRequestHandler({
        projects: new ProjectRepository(dbB),
        port: portB,
        peers: peerRepoB,
        peerTokensDir: tokenDirB,
        ownCertPem: pemsB.cert,
        ownHostname: 'host-loop-b',
        ownFingerprint: certFingerprint(pemsB.cert),
        hookSessions: new SessionRepository(dbB),
        hookEvents: hookEventsB,
        messageDeliverer: delivererB,
      }),
    );
    await new Promise<void>((resolve) => httpsB.listen(portB, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    httpsA.close();
    httpsB.close();
    dbA.close();
    dbB.close();
    rmSync(tokenDirA, { recursive: true, force: true });
    rmSync(tokenDirB, { recursive: true, force: true });
  });

  it('A→B：pairing 出站（真 https+TOFU）→ peer: 目标投递进 B → B 的对话事件落库', async () => {
    // B 给短码，A 出站 pairing——对端半边是真 weave 实例（不是 mock 脚本）
    const offerB = await restB('POST', '/federation/pairing/offer');
    const swapped = await restTls(portA, 'POST', '/federation/pairing/initiate', {
      name: 'loop-b',
      host: '127.0.0.1',
      port: portB,
      code: offerB.body.code as string,
    });
    expect(swapped.status).toBe(200);
    const peerRow = new PeerRepository(dbA).list().find((p) => p.name === 'loop-b')!;
    expect(peerRow.fingerprint).toBeTypeOf('string');
    expect(peerRow.fingerprint!.length).toBe(64);

    // B 侧造一条本地会话（A 将把消息投给它）
    new HookEventRepository(dbB).insert({
      projectId: 1,
      source: 'claude',
      eventType: 'UserPromptSubmit',
      sessionId: 'sess-loop-b',
      payload: '{}',
    });
    new SessionRepository(dbB).touch('sess-loop-b', 1);

    // A 以跨机方式投递：peer: 目标 → 出站 https call inject → B 落库
    const result = await delivererA.send({
      toSessionId: 'peer:loop-b/sess-loop-b',
      text: 'hi across the loop',
      mode: 'inject',
      fromKind: 'dashboard',
      oneWay: true,
    });
    expect(result.ok, `send failed: ${JSON.stringify(result)}`).toBe(true);
    // B 的消息账里真的有了（inject 通道写 B 的 outbox）
    const bInbox = new HookEventRepository(dbB).listBySession('sess-loop-b', 10);
    expect(bInbox.length).toBeGreaterThan(0);

    // 反向：B 配对到 A，B 的 caller 视角经 call 门读 A 的会话清单（范围闸 = 全量）
    const offerA = await restTls(portA, 'POST', '/federation/pairing/offer');
    const swappedBA = await restB('POST', '/federation/pairing/initiate', {
      name: 'loop-a',
      host: '127.0.0.1',
      port: portA,
      code: offerA.body.code as string,
    });
    expect(swappedBA.status).toBe(200);
    new HookEventRepository(dbA).insert({
      projectId: 1,
      source: 'claude',
      eventType: 'UserPromptSubmit',
      sessionId: 'sess-loop-a',
      payload: '{}',
    });
    new SessionRepository(dbA).touch('sess-loop-a', 1);
    // B 侧拿到 A 签发的 per-peer token（pairing 交换时 A 已写进 A 的 tokenDir，
    // 文件名 = A 视角里来访 peer 行的 id——A 看到的来访名 = B 的 hostname）。
    const peerRowBA = new PeerRepository(dbA).list().find((p) => p.name === 'host-loop-b')!;
    const tokenBA = readPeerToken(tokenDirA, peerRowBA.id, tokenFileOf)?.token;
    expect(tokenBA).toBeTruthy();
    const called = await restTls(portA, 'POST', '/federation/call', { service: 'sessions.list', params: {} }, {
      authorization: `Bearer ${tokenBA}`,
    });
    expect(called.status).toBe(200);
    expect((called.body.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId)).toContain('sess-loop-a');
  });
});
