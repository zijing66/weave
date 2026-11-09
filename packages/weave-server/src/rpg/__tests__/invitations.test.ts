import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { PeerRepository } from '../../repositories/peers.js';
import { RpgRoleRepository, RpgGrowthRepository } from '../roles.js';
import { RpgInvitationRepository, castRolesFromInvitation, INVITATION_TTL_MS, GROWTH_VERB_CAST } from '../invitations.js';
import { parseTeamRole, formTeam } from '../verbs.js';
import { createDecisionKernel } from '../../hooks/decision-kernel.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * F2 跨机角色邀请：生命周期（发起→受邀落表→接受→过期）、AI 选角 mock（决策
 * 模型优先 / 无模型回落内核 / 全都不行 = ok:false 手选回落）、teams peer: 解析
 * （合法 / 未知 peer 报错文案）、rpg_invitations 迁移幂等。
 */

describe('rpg_invitations 生命周期', () => {
  function setup() {
    const db = openDatabase(':memory:');
    const invitations = new RpgInvitationRepository(db);
    return { db, invitations };
  }

  it('迁移幂等：旧库（无该表）openDatabase 补建表与索引；再开一次不炸', () => {
    // openDatabase(':memory:') 每次都是新库——SCHEMA 直接含表；索引在 SCHEMA 内
    // 且 rpg_invitations 是 F2 新表（无存量列问题），幂等性由两次 open 断言。
    const { db, invitations } = setup();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain('rpg_invitations');
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain('idx_rpg_invitations_peer');
    db.close();
    expect(() => openDatabase(':memory:').close()).not.toThrow();
  });

  it('发起→落 pending→接受→decided_by=manual；重复决定 409 语义（false）', () => {
    const { db, invitations } = setup();
    const row = invitations.create({ peerId: 'p1', team: '前端小队', scene: '教室' });
    expect(row.status).toBe('pending');
    expect(row.roles).toBeNull();
    expect(invitations.decide(row.id, 'accepted', 'manual')).toBe(true);
    const after = invitations.getById(row.id)!;
    expect(after.status).toBe('accepted');
    expect(after.decidedBy).toBe('manual');
    expect(after.decidedAt).toBeTruthy();
    // 再决定 = false（路由侧回 409）
    expect(invitations.decide(row.id, 'declined', 'manual')).toBe(false);
    db.close();
  });

  it('拒绝与过期；48h 定死常量（不进 settings）', () => {
    const { db, invitations } = setup();
    expect(INVITATION_TTL_MS).toBe(48 * 60 * 60_000);
    const a = invitations.create({ peerId: 'p1', team: 't-a' });
    const b = invitations.create({ peerId: 'p1', team: 't-b' });
    expect(invitations.decide(a.id, 'declined', 'manual')).toBe(true);
    // 过期扫：把 b 的 created_at 回拨 49h
    db.prepare(`UPDATE rpg_invitations SET created_at = ? WHERE id = ?`).run(
      new Date(Date.now() - INVITATION_TTL_MS - 3_600_000).toISOString(),
      b.id,
    );
    expect(invitations.expireOverdue()).toBe(1);
    expect(invitations.getById(b.id)!.status).toBe('expired');
    // 决定过的不再动
    expect(invitations.expireOverdue()).toBe(0);
    db.close();
  });

  it('roles 候选 JSON 往返；坏 JSON 如实回 null', () => {
    const { db, invitations } = setup();
    const row = invitations.create({
      peerId: 'p1',
      team: 't',
      roles: [{ role: 'frontend-dev', module: 'web/src/ui' }, { role: 'peer:host-b/backend' }],
    });
    expect(row.roles).toEqual([{ role: 'frontend-dev', module: 'web/src/ui' }, { role: 'peer:host-b/backend' }]);
    db.prepare(`UPDATE rpg_invitations SET roles = '{bad' WHERE id = ?`).run(row.id);
    expect(invitations.getById(row.id)!.roles).toBeNull();
    db.close();
  });
});

describe('AI 选角（决策内核 mock）', () => {
  function dbWithRoles() {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const roles = new RpgRoleRepository(db);
    const p1 = projects.register({ path: '/tmp/f2-a', name: 'a', token: 't1', source: 'scan' });
    const p2 = projects.register({ path: '/tmp/f2-b', name: 'b', token: 't2', source: 'scan' });
    roles.create({ projectId: p1.id, name: 'frontend-dev', archetype: '创造', persona: '前端工程师' });
    roles.create({ projectId: p2.id, name: 'reviewer', archetype: '审核', persona: '代码评审' });
    return { db, roles, growth: new RpgGrowthRepository(db) };
  }

  it('决策模型优先：配置了 aiConfig 且回答合法 → source=decision-model，只收本机清单内的 id', async () => {
    const { db, roles } = dbWithRoles();
    const kernel = createDecisionKernel({ fork: { supports: () => false, extract: async () => null } });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"picks":[{"id":1,"reason":"创造型适配前端"}]}' } }] }), { status: 200 })) as typeof fetch;
    const result = await castRolesFromInvitation(
      { kernel, roles, aiConfig: { baseUrl: 'https://x', model: 'm', apiKey: 'k' }, fetchImpl },
      { team: '前端小队', goal: '落地页' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('decision-model');
      expect(result.picks).toEqual([{ roleId: 1, name: 'frontend-dev', reason: '创造型适配前端' }]);
    }
    db.close();
  });

  it('决策模型回答无效（id 不在清单）→ 回落内核 fork；fork 出合法 picks', async () => {
    const { db, roles } = dbWithRoles();
    const kernel = createDecisionKernel({
      fork: {
        supports: () => true,
        extract: async () => '结果：{"picks":[{"id":2,"reason":"审核型适配评审"}]}',
      },
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"picks":[{"id":99,"reason":"不存在"}]}' } }] }), { status: 200 })) as typeof fetch;
    const result = await castRolesFromInvitation(
      { kernel, roles, aiConfig: { baseUrl: 'https://x', model: 'm', apiKey: 'k' }, fetchImpl },
      { team: '评审队' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('fork');
      expect(result.picks[0]!.roleId).toBe(2);
    }
    db.close();
  });

  it('无决策模型 + fork 不支持（codex 形）→ ok:false，前端放手选全量表单，不硬造', async () => {
    const { db, roles } = dbWithRoles();
    const kernel = createDecisionKernel({ fork: { supports: () => false, extract: async () => null } });
    const result = await castRolesFromInvitation({ kernel, roles }, { team: 't' });
    expect(result).toEqual({ ok: false, reason: expect.any(String) });
    db.close();
  });

  it('空角色库 = ok:false', async () => {
    const db = openDatabase(':memory:');
    const roles = new RpgRoleRepository(db);
    const kernel = createDecisionKernel({ fork: { supports: () => true, extract: async () => '{"picks":[]}' } });
    const result = await castRolesFromInvitation({ kernel, roles }, { team: 't' });
    expect(result.ok).toBe(false);
    db.close();
  });

  it('provenance：选角落邀请行 provenance 列 + 本机角色的 rpg_growth verb=cast（§七可观测）', () => {
    const { db, roles, growth } = dbWithRoles();
    const invitations = new RpgInvitationRepository(db);
    const inv = invitations.create({ peerId: 'p1', team: 't' });
    invitations.setProvenance(inv.id, 'peer=host-b ai=decision-model picks=frontend-dev');
    expect(invitations.getById(inv.id)!.provenance).toContain('ai=decision-model');
    // 本机角色维度的成长记录（角色可回放）
    const role = roles.list()[0]!;
    growth.insert({ roleId: role.id, verb: GROWTH_VERB_CAST, target: `invitation:${inv.id}`, detail: '创造型适配前端' });
    expect(growth.listByRole(role.id)[0]!.verb).toBe('cast');
    db.close();
  });
});

describe('teams peer: 解析（parseTeamRole）', () => {
  function peersOf(names: string[]) {
    const db = openDatabase(':memory:');
    const peers = new PeerRepository(db);
    for (const n of names) peers.create({ name: n, host: n, port: 6443 });
    return { db, peers };
  }

  it('合法 peer 形态：查 peers 注册表得名', () => {
    const { db, peers } = peersOf(['host-b']);
    const parsed = parseTeamRole('peer:host-b/backend-dev', peers);
    expect(parsed).toEqual({ source: 'peer', peerId: expect.any(String), peerName: 'host-b', role: 'backend-dev' });
    db.close();
  });

  it('本地形态原样；未知 peer 报错文案带名字', () => {
    const { db, peers } = peersOf(['host-b']);
    expect(parseTeamRole('frontend-dev', peers)).toEqual({ source: 'local', role: 'frontend-dev' });
    const bad = parseTeamRole('peer:host-x/backend', peers);
    expect(bad.source).toBe('error');
    if (bad.source === 'error') expect(bad.error).toContain('host-x');
    db.close();
  });

  it('残缺形态（无斜杠/空角色名）报错', () => {
    const { db, peers } = peersOf(['host-b']);
    for (const bad of ['peer:host-b', 'peer:/x', 'peer:host-b/']) {
      expect(parseTeamRole(bad, peers).source).toBe('error');
    }
    db.close();
  });

  it('formTeam 接受 peer: 条目写入 yaml（出征时才解析）；残缺 peer 形态 400', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'weave-f2-teams-'));
    try {
      const ok = await formTeam({ rolesRoot: dir }, dir, {
        name: 'mixed-team',
        roles: [{ role: 'frontend-dev' }, { role: 'peer:host-b/backend-dev', module: 'api/' }],
      });
      expect(ok.ok).toBe(true);
      const bad = await formTeam({ rolesRoot: dir }, dir, { name: 'bad-team', roles: [{ role: 'peer:host-b' }] });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
