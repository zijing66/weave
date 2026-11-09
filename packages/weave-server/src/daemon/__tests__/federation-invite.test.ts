import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { PeerRepository } from '../../repositories/peers.js';
import { RpgRoleRepository } from '../../rpg/roles.js';
import { RpgInvitationRepository, F2_INVITE_SERVICE } from '../../rpg/invitations.js';
import { createWeaveServer } from '../../daemon/server.js';
import { resetPairingForTest } from '../../daemon/federation-routes.js';
import { FEDERATION_SERVICES, certFingerprint } from '../../daemon/federation.js';

/**
 * F2 call 服务表 invite 行：服务表含 rpg.invite（effect=delivering，方向 = 对端
 * 用户面向——只落待确认记录、不执行任何动作，不违反 inject-only）；per-peer token
 * 门内落 rpg_invitations pending 行；管理面 invitations 列表/决定（HITL 手动）。
 */

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

describe('F2 邀请（call 服务表 + 落表 + HITL 决定）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let tokenDir: string;
  let peers: PeerRepository;
  const pemsPromise = generate([{ name: 'commonName', value: 'weave-daemon' }], { keySize: 2048 });

  beforeAll(async () => {
    db = openDatabase(':memory:');
    new ProjectRepository(db).register({ path: 'D:/proj-f2', name: 'proj-f2', token: 't', source: 'scan' });
    peers = new PeerRepository(db);
    tokenDir = mkdtempSync(path.join(tmpdir(), 'weave-f2-'));
    port = 35512;
    server = createWeaveServer({
      projects: new ProjectRepository(db),
      port,
      peers,
      peerTokensDir: tokenDir,
      ownCertPem: (await pemsPromise).cert,
      ownHostname: 'host-f2',
      ownFingerprint: certFingerprint((await pemsPromise).cert) ?? undefined,
      rpgRoles: new RpgRoleRepository(db),
      rpgInvitations: new RpgInvitationRepository(db),
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

  async function pairedToken(name: string): Promise<string> {
    const offer = await rest(port, 'POST', '/federation/pairing/offer');
    const swapped = await rest(port, 'POST', '/federation/pair', {
      code: offer.body.code as string,
      name,
      fingerprint: 'a'.repeat(64),
    });
    expect(swapped.status).toBe(200);
    return swapped.body.token as string;
  }

  it('服务表含 rpg.invite 行（delivering；描述写明 HITL 不执行）', () => {
    const row = FEDERATION_SERVICES.find((s) => s.service === 'rpg.invite');
    expect(row).toBeTruthy();
    expect(row!.effect).toBe('delivering');
    expect(row!.description).toMatch(/HITL/i);
    expect(F2_INVITE_SERVICE).toBe('rpg.invite');
  });

  it('call rpg.invite：token 门 → 落 pending 记录；无 rpgInvitations 装配 → 503；坏参数 400', async () => {
    const token = await pairedToken('peer-invite');
    const ok = await rest(
      port,
      'POST',
      '/federation/call',
      { service: 'rpg.invite', params: { team: '前端小队', scene: '教室', message: '一起打 Boss' } },
      { authorization: `Bearer ${token}` },
    );
    expect(ok.status).toBe(201);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.status).toBe('pending');

    const bad = await rest(
      port,
      'POST',
      '/federation/call',
      { service: 'rpg.invite', params: { scene: 'no team' } },
      { authorization: `Bearer ${token}` },
    );
    expect(bad.status).toBe(400);

    const noAuth = await rest(port, 'POST', '/federation/call', { service: 'rpg.invite', params: { team: 'x' } });
    expect(noAuth.status).toBe(403);
  });

  it('管理面：列表（对端名 join）→ 手动接受 → 状态 accepted；非 pending 再决定 409', async () => {
    const list = await rest(port, 'GET', '/federation/invitations');
    expect(list.status).toBe(200);
    const pending = (list.body.invitations as Array<{ id: number; status: string; peerName: string | null }>).filter(
      (r) => r.status === 'pending',
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0]!.peerName).toBe('peer-invite');

    const accepted = await rest(port, 'POST', `/federation/invitations/${pending[0]!.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.invitation.status).toBe('accepted');
    expect(accepted.body.invitation.decidedBy).toBe('manual');

    const again = await rest(port, 'POST', `/federation/invitations/${pending[0]!.id}/accept`);
    expect(again.status).toBe(409);

    const declined = await rest(port, 'GET', '/federation/invitations');
    expect((declined.body.invitations as Array<{ status: string }>).every((r) => r.status !== 'pending')).toBe(true);
  });
});
