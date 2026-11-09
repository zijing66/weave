import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { RpgGrowthRepository, RpgRoleRepository, archetypeBaseline } from '../roles.js';
import { provisionRole, provisionRoleFromTemplate, scaffoldCoordinator } from '../provisioning.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** RPG 域表迁移 + 角色仓储 + provisioning（项目注册走既有 ProjectRepository 单点）。 */

describe('rpg schema', () => {
  it('openDatabase 幂等建出 RPG 域表（rpg_roles/rpg_teams/rpg_growth/rpg_hexagram）', () => {
    const db = openDatabase(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['rpg_roles', 'rpg_teams', 'rpg_growth', 'rpg_hexagram']));
    // 幂等：再开一次不炸
    expect(() => db.exec("SELECT 1 FROM rpg_roles")).not.toThrow();
    db.close();
  });

  it('角色行随项目级联删（projects ON DELETE CASCADE）', () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const roles = new RpgRoleRepository(db);
    const p = projects.register({ path: '/tmp/rpg-cascade', name: 'r', token: 't', source: 'init' });
    roles.create({ projectId: p.id, name: 'r', archetype: '思考' });
    expect(roles.list()).toHaveLength(1);
    projects.remove(p.id);
    expect(roles.list()).toHaveLength(0);
    db.close();
  });
});

describe('provisionRole', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'weave-rpg-provision-'));

  it('建角色 = 建仓库目录 + 项目注册 + RPG 行（人设与装备声明落文件层）', async () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const roles = new RpgRoleRepository(db);
    const r = await provisionRole(
      { projects, roles, rolesRoot: tmp },
      { name: 'frontend-dev', archetype: '创造', persona: '你是前端工程师。' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.role.reused).toBe(false);
    expect(existsSync(path.join(tmp, 'frontend-dev', '.weave'))).toBe(true);
    expect(existsSync(path.join(tmp, 'frontend-dev', 'CLAUDE.md'))).toBe(true);
    const row = roles.getByProjectId(r.role.projectId)!;
    expect(row.name).toBe('frontend-dev');
    expect(row.archetype).toBe('创造');
    expect(row.hexagon).toEqual(archetypeBaseline('创造'));
    // 项目注册走既有仓储单点（getByPath 认得它）
    expect(projects.getByPath(r.role.path)?.id).toBe(r.role.projectId);
    db.close();
  });

  it('kebab-case 闸：非法名 400', async () => {
    const db = openDatabase(':memory:');
    const r = await provisionRole(
      { projects: new ProjectRepository(db), roles: new RpgRoleRepository(db), rolesRoot: tmp },
      { name: 'Bad Name!' },
    );
    expect(r).toMatchObject({ ok: false, status: 400 });
    db.close();
  });

  it('复用：同根已注册项目 = reused:true，不重建仓库', async () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const roles = new RpgRoleRepository(db);
    const first = await provisionRole({ projects, roles, rolesRoot: tmp }, { name: 'tester', archetype: '审核' });
    const second = await provisionRole({ projects, roles, rolesRoot: tmp }, { name: 'tester' });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.role.reused).toBe(true);
      expect(second.role.projectId).toBe(first.role.projectId);
    }
    db.close();
  });
});

describe('scaffoldCoordinator', () => {
  it('四目录骨架 + 基础七型物化进 roles/ + 项目注册，幂等（二次调用 reused / 不覆盖）', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'weave-rpg-coord-'));
    try {
      const db = openDatabase(':memory:');
      const projects = new ProjectRepository(db);
      const roles = new RpgRoleRepository(db);
      const first = await scaffoldCoordinator({ projects, roles }, root);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.created).toEqual(['teams', 'roles', 'playbooks', 'state']);
      expect(first.rolesSeeded).toHaveLength(7);
      expect(existsSync(path.join(root, 'playbooks'))).toBe(true);
      expect(existsSync(path.join(root, 'roles', 'thinker', 'weave-plugin.json'))).toBe(true);
      expect(projects.getByPath(first.path)?.name).toBe('coordinator');
      const second = await scaffoldCoordinator({ projects, roles }, root);
      expect(second.reused).toBe(true);
      expect(second.rolesSeeded).toHaveLength(0);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('从物化模板实例化角色：provisionRoleFromTemplate 读 role 段落仓库', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'weave-rpg-coord2-'));
    const rolesRoot = mkdtempSync(path.join(tmpdir(), 'weave-rpg-roles2-'));
    try {
      const db = openDatabase(':memory:');
      const projects = new ProjectRepository(db);
      const roles = new RpgRoleRepository(db);
      await scaffoldCoordinator({ projects, roles }, root);
      const r = await provisionRoleFromTemplate(
        { projects, roles, rolesRoot },
        { name: 'my-auditor', pluginDir: path.join(root, 'roles', 'auditor') },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const row = roles.getByProjectId(r.role.projectId)!;
      expect(row.archetype).toBe('审核');
      expect(row.hexagon).toEqual(archetypeBaseline('审核'));
      // 人设与装备声明按文件层落角色仓库
      expect(existsSync(path.join(rolesRoot, 'my-auditor', 'CLAUDE.md'))).toBe(true);
      expect(existsSync(path.join(rolesRoot, 'my-auditor', '.weave', 'role.json'))).toBe(true);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(rolesRoot, { recursive: true, force: true });
    }
  });
});

describe('RpgGrowthRepository', () => {
  it('成长记录插入与按角色倒序查询', () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const roles = new RpgRoleRepository(db);
    const growth = new RpgGrowthRepository(db);
    const p = projects.register({ path: '/tmp/rpg-growth', name: 'g', token: 't', source: 'init' });
    const role = roles.create({ projectId: p.id, name: 'g' });
    growth.insert({ roleId: role.id, verb: 'cultivate', target: 'skill-a' });
    growth.insert({ roleId: role.id, verb: 'equip', target: 'plugin-b', detail: 'user 档' });
    const rows = growth.listByRole(role.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.verb).toBe('equip');
    db.close();
  });
});
