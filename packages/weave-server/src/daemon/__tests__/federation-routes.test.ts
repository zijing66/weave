import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as netCreate } from 'node:net';
import { generate } from 'selfsigned';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { PeerRepository, tokenFileOf } from '../../repositories/peers.js';
import { createWeaveServer } from '../../daemon/server.js';
import { resetPairingForTest } from '../../daemon/federation-routes.js';
import { certFingerprint } from '../../daemon/federation.js';
import { readPeerToken, writePeerToken } from '../../daemon/peer-tokens.js';

/**
 * /federation/* 本批面：peer CRUD（认证门内）+ pairing 交换（per-peer token 门）+
 * 心跳。`/federation/call` 坚决不开（F1 的门）——404 即验收。
 */
describe('federation routes（E3）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let tokenDir: string;
  let peers: PeerRepository;
  const pemsPromise = generate([{ name: 'commonName', value: 'weave-daemon' }], { keySize: 2048 });
  let ownFp = '';

  const rest = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    ownFp = certFingerprint((await pemsPromise).cert)!;
    db = openDatabase(':memory:');
    new ProjectRepository(db).register({ path: 'D:/proj-x', name: 'proj-x', token: 't', source: 'scan' });
    peers = new PeerRepository(db);
    tokenDir = mkdtempSync(path.join(tmpdir(), 'weave-fed-'));
    const probe = netCreate();
    port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
    }).finally(() => new Promise<void>((resolve) => probe.close(() => resolve())));
    server = createWeaveServer({
      projects: new ProjectRepository(db),
      port,
      peers,
      peerTokensDir: tokenDir,
      ownCertPem: (await pemsPromise).cert,
      ownHostname: 'host-a',
      ownFingerprint: ownFp,
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

  it('peer CRUD：手动添加 host:port 是基础（D8）', async () => {
    const created = await rest('POST', '/federation/peers', {
      name: 'B 机', host: '10.0.0.2', port: 6443,
    });
    expect(created.status).toBe(201);
    const id = created.body.peer.id as string;
    expect(created.body.peer.source).toBe('manual');
    const listed = await rest('GET', '/federation/peers');
    expect(listed.body.peers).toHaveLength(1);
    const patched = await rest('PATCH', `/federation/peers/${id}`, { port: 7443 });
    expect(patched.body.peer.port).toBe(7443);
    const gone = await rest('DELETE', `/federation/peers/${id}`);
    expect(gone.status).toBe(200);
  });

  it('校验拒坏请求（端口越界 / 短码形状）', async () => {
    expect((await rest('POST', '/federation/peers', { name: 'x', host: 'h', port: 99_999 })).status).toBe(400);
    expect((await rest('POST', '/federation/pair', { code: '12ab', name: 'n', fingerprint: 'f'.repeat(64) })).status).toBe(400);
  });

  it('pairing 全链：要约 → 对端交换（短码核销 + 落 peer 行 + per-peer token）→ 心跳', async () => {
    const offer = await rest('POST', '/federation/pairing/offer');
    expect(offer.status).toBe(200);
    const code = offer.body.code as string;

    const swapped = await rest('POST', '/federation/pair', {
      code,
      name: 'peer-b',
      fingerprint: 'b'.repeat(64),
    });
    expect(swapped.status).toBe(200);
    const peerId = swapped.body.peerId as string;
    expect(swapped.body.fingerprint).toBe(ownFp);
    // 本机落了 peer 行（来源 pairing）+ per-peer token 文件（0600 落 tokenDir）
    const row = peers.getById(peerId)!;
    expect(row.source).toBe('pairing');
    expect(row.fingerprint).toBe('b'.repeat(64));
    const token = readPeerToken(tokenDir, peerId, tokenFileOf)!.token;
    expect(token).toBe(swapped.body.token);

    // 同一短码第二次交换被拒（一码一换）
    const reused = await rest('POST', '/federation/pair', { code, name: 'peer-b', fingerprint: 'b'.repeat(64) });
    expect(reused.status).toBe(403);

    // 心跳（per-peer token 门，无 dashboard 凭据也要通）
    const beat = await rest('POST', '/federation/heartbeat', { token });
    expect(beat.status).toBe(200);
    expect(peers.getById(peerId)!.lastSeenAt).toBeTruthy();
    // 坏 token 拒
    expect((await rest('POST', '/federation/heartbeat', { token: 'not-a-valid-token-xyz' })).status).toBe(403);
  });

  it('TOFU：同 peer 证书指纹变更即拒（409，重新 pairing）', async () => {
    // 预登记（手动建行带指纹）后再 initiate 且报不同指纹 → 出站前预检即拒
    peers.create({ name: 'peer-c', host: '127.0.0.1', port: 65000, fingerprint: 'c'.repeat(64), source: 'pairing' });
    const mismatch = await rest('POST', '/federation/pairing/initiate', {
      name: 'peer-c', host: '127.0.0.1', port: 65000, code: '111111', fingerprint: 'd'.repeat(64),
    });
    expect(mismatch.status).toBe(409);
    expect(String(mismatch.body.error)).toMatch(/re-pair/i);
  });

  it('call / caps 已由 F1 接线（per-peer token 门）：无凭据 403、invite 仍 404', async () => {
    // caps / call 不再是 404——per-peer token 门先拒（F1 测试套验全链）
    expect((await rest('GET', '/federation/caps')).status).toBe(403);
    expect((await rest('POST', '/federation/call', { service: 'sessions.list', params: {} })).status).toBe(403);
    expect((await rest('POST', '/federation/invite', {})).status).toBe(404);
  });
});
