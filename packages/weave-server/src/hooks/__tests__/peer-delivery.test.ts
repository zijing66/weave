import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { HookEventBus } from '../bus.js';
import { MessageDeliverer } from '../message-deliverer.js';
import { startFederationHeartbeat } from '../../daemon/federation-heartbeat.js';
import { PeerRepository, tokenFileOf } from '../../repositories/peers.js';
import { writePeerToken } from '../../daemon/peer-tokens.js';

/**
 * 跨机分流（F1）的投递半边：`peer:<name>/<sessionId>` 目标 → peerRoute 查表 →
 * 对端 /federation/call inject。远程消息不进本地管道；未知 peer 404、无传输 503、
 * 对端拒绝映射。心跳出站（fake timers）只打 enabled 且有 token 的 peer。
 */

function makePeerRequestImpl(calls: Array<Record<string, unknown>>, status = 202) {
  return async (peer: unknown, req: { path: string; body?: unknown }) => {
    calls.push({ peer, req });
    return { ok: status < 400, status, body: JSON.stringify({ ok: true, status: 'injected' }) };
  };
}

describe('MessageDeliverer 跨机分流（peer: 目标）', () => {
  let db: DatabaseSync;
  let hooksDir: string;
  const PEER_HOST = '10.0.0.9';
  const PEER_PORT = 6443;

  const makeDeliverer = (
    calls: Array<Record<string, unknown>>,
    opts: { peerName?: string; status?: number; withRoute?: boolean } = {},
  ): MessageDeliverer => {
    const peerName = opts.peerName ?? 'lab-box';
    return new MessageDeliverer({
      sessions: new SessionRepository(db),
      projects: new ProjectRepository(db),
      hookEvents: new HookEventRepository(db),
      bus: new HookEventBus(),
      hooksDir,
      ...(opts.withRoute === false
        ? {}
        : {
            peerRoute: (name) =>
              name === peerName
                ? { peerId: 'uuid-1', host: PEER_HOST, port: PEER_PORT, fingerprint: null, token: 'peer-token-1' }
                : null,
          }),
      peerRequestImpl: makePeerRequestImpl(calls, opts.status ?? 202) as never,
    });
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    hooksDir = mkdtempSync(path.join(tmpdir(), 'weave-peer-'));
  });

  afterEach(() => {
    db.close();
    rmSync(hooksDir, { recursive: true, force: true });
  });

  it('peer 目标 → 转发对端 /federation/call inject（token 带、请求体带 sessionId）', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const deliverer = makeDeliverer(calls);
    const result = await deliverer.send({
      toSessionId: 'peer:lab-box/abc-123',
      text: 'hello across machines',
      mode: 'prompt',
      fromKind: 'session',
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('delivered');
    expect(calls).toHaveLength(1);
    const call = calls[0]! as { peer: { host: string; port: number }; req: { path: string; body: { service: string; params: { sessionId: string } }; token?: string } };
    expect(call.peer).toMatchObject({ host: PEER_HOST, port: PEER_PORT });
    expect(call.req.path).toBe('/federation/call');
    expect(call.req.body.service).toBe('inject');
    expect(call.req.body.params.sessionId).toBe('abc-123');
    expect(call.req.token).toBe('peer-token-1');
    // 远程消息不进本地管道
    expect(deliverer.getMessage((result as { messageId: string }).messageId)).toBeNull();
  });

  it('未知 peer → 404；坏格式 → 400；无传输 → 503', async () => {
    const calls: Array<Record<string, unknown>> = [];
    expect(
      await makeDeliverer(calls).send({ toSessionId: 'peer:who/abc', text: 'x', mode: 'prompt', fromKind: 'dashboard' }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await makeDeliverer(calls).send({ toSessionId: 'peer:nosegments', text: 'x', mode: 'prompt', fromKind: 'dashboard' }),
    ).toMatchObject({ ok: false, status: 400 });
    const deliverer = makeDeliverer(calls, { withRoute: false });
    // withRoute=false 仍有 route 闭包？不——上面分支给了 route。这里直接造一个无 route 的：
    const bare = new MessageDeliverer({
      sessions: new SessionRepository(db),
      projects: new ProjectRepository(db),
      hookEvents: new HookEventRepository(db),
      bus: new HookEventBus(),
      hooksDir,
      peerRequestImpl: makePeerRequestImpl(calls) as never,
    });
    expect(
      await bare.send({ toSessionId: 'peer:lab-box/abc', text: 'x', mode: 'prompt', fromKind: 'dashboard' }),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it('对端拒绝（403）→ 409；对端 404 → 404；不可达（throw）→ 502', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const deliverer403 = makeDeliverer(calls, { status: 403 });
    expect(
      await deliverer403.send({ toSessionId: 'peer:lab-box/abc', text: 'x', mode: 'prompt', fromKind: 'dashboard' }),
    ).toMatchObject({ ok: false, status: 409 });

    const deliverer404 = makeDeliverer(calls, { status: 404 });
    expect(
      await deliverer404.send({ toSessionId: 'peer:lab-box/abc', text: 'x', mode: 'prompt', fromKind: 'dashboard' }),
    ).toMatchObject({ ok: false, status: 404 });

    const delivererFail = new MessageDeliverer({
      sessions: new SessionRepository(db),
      projects: new ProjectRepository(db),
      hookEvents: new HookEventRepository(db),
      bus: new HookEventBus(),
      hooksDir,
      peerRoute: () => ({ peerId: 'u', host: PEER_HOST, port: PEER_PORT, fingerprint: null, token: 't' }),
      peerRequestImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as never,
    });
    expect(
      await delivererFail.send({ toSessionId: 'peer:lab-box/abc', text: 'x', mode: 'prompt', fromKind: 'dashboard' }),
    ).toMatchObject({ ok: false, status: 502 });
  });
});

describe('心跳出站（fake timers）', () => {
  let db: DatabaseSync;
  let tokenDir: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    tokenDir = mkdtempSync(path.join(tmpdir(), 'weave-hb-'));
  });

  afterEach(() => {
    db.close();
    rmSync(tokenDir, { recursive: true, force: true });
  });

  it('30s 一拍、只打 enabled 且有 token 的 peer；停表即静默', async () => {
    vi.useFakeTimers();
    const peers = new PeerRepository(db);
    const withToken = peers.create({ name: 'a', host: '10.0.0.1', port: 6443, source: 'manual' });
    writePeerToken(tokenDir, withToken.id, { token: 'tok-a', fingerprint: '', issuedAt: new Date().toISOString() }, tokenFileOf);
    const disabled = peers.create({ name: 'b', host: '10.0.0.2', port: 6443, source: 'manual' });
    writePeerToken(tokenDir, disabled.id, { token: 'tok-b', fingerprint: '', issuedAt: new Date().toISOString() }, tokenFileOf);
    peers.update(disabled.id, { enabled: false });
    peers.create({ name: 'c', host: '10.0.0.3', port: 6443, source: 'manual' }); // 无 token

    const calls: Array<Record<string, unknown>> = [];
    const hb = startFederationHeartbeat({
      peers,
      tokenDir,
      requestImpl: (async (peer, req) => {
        calls.push({ peer, req });
        return { ok: true, status: 200, body: '{"ok":true}' };
      }) as never,
      intervalMs: 30_000,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1);
    const call = calls[0]! as { peer: { host: string }; req: { path: string; body: { token: string } } };
    expect(call.peer.host).toBe('10.0.0.1');
    expect(call.req.path).toBe('/federation/heartbeat');
    expect(call.req.body.token).toBe('tok-a');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);

    hb.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2); // 停表后不再打
    vi.useRealTimers();
  });
});
