import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { OrchestrationRepository } from '../../repositories/orchestrations.js';
import { RpgGrowthRepository, RpgRoleRepository, archetypeBaseline, APPEARANCE_SEED_MAX } from '../roles.js';
import { provisionRole, provisionRoleFromTemplate, scaffoldCoordinator } from '../provisioning.js';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';

const readStampVersion = (stampFile: string): string => {
  const raw = readFileSync(stampFile, 'utf-8').trim();
  return /^initVersion:\s*(\S+)$/m.exec(raw)?.[1] ?? raw;
};
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WEAVE_VERSION } from '../../version.js';

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

  it('旧库迁移：缺 gender/appearance_seed 列的存量表幂等补列，旧角色读侧 null 不随机洗脸', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'weave-rpg-migrate-'));
    const file = path.join(dir, 'old.db');
    // 第一拍：新 schema 建表后剥掉两列，模拟存量旧库 + 塞一行旧角色
    const db = openDatabase(file);
    db.exec('ALTER TABLE rpg_roles DROP COLUMN gender; ALTER TABLE rpg_roles DROP COLUMN appearance_seed');
    const p = new ProjectRepository(db).register({ path: '/tmp/rpg-legacy', name: 'legacy', token: 't', source: 'init' });
    db.exec(`INSERT INTO rpg_roles (project_id, name, created_at) VALUES (${p.id}, 'legacy', '2026-01-01')`);
    db.close();

    // 第二拍：openDatabase 走列级兜底迁移 → 补列幂等
    const db2 = openDatabase(file);
    const cols = (db2.prepare('PRAGMA table_info(rpg_roles)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['gender', 'appearance_seed']));
    const row = new RpgRoleRepository(db2).getByProjectId(p.id)!;
    expect(row.gender).toBeNull();
    expect(row.appearanceSeed).toBeNull();
    db2.close();

    // 第三拍：再开一次（列已在）不炸 = 幂等
    expect(() => openDatabase(file).close()).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('RpgRoleRepository 性别/外貌种子', () => {
  const seedProject = (db: DatabaseSync): number =>
    new ProjectRepository(db).register({ path: `/tmp/rpg-gender-${Math.random()}`, name: 'r', token: 't', source: 'init' }).id;

  it('显式 gender/appearanceSeed 持久化；seed 落在 0..2147483647', () => {
    const db = openDatabase(':memory:');
    const roles = new RpgRoleRepository(db);
    const pid = seedProject(db);
    const row = roles.create({ projectId: pid, name: 'r', gender: 'female', appearanceSeed: 123456789 });
    expect(row.gender).toBe('female');
    expect(row.appearanceSeed).toBe(123456789);
    expect(roles.getByProjectId(pid)!.appearanceSeed).toBe(123456789);
    db.close();
  });

  it('缺省随机：gender ∈ {male,female}，seed ∈ [0, 2147483647] 且多次创建有分布', () => {
    const db = openDatabase(':memory:');
    const roles = new RpgRoleRepository(db);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const pid = seedProject(db);
      const row = roles.create({ projectId: pid, name: 'r' });
      expect(['male', 'female']).toContain(row.gender);
      expect(row.appearanceSeed).toBeGreaterThanOrEqual(0);
      expect(row.appearanceSeed).toBeLessThanOrEqual(APPEARANCE_SEED_MAX);
      expect(Number.isInteger(row.appearanceSeed)).toBe(true);
      seen.add(row.gender!);
    }
    expect(seen.size).toBe(2); // 40 次至少两种性别都出现过
    db.close();
  });

  it('upsert 未显式给新参数 = 保留已有外貌（不随机洗脸）', () => {
    const db = openDatabase(':memory:');
    const roles = new RpgRoleRepository(db);
    const pid = seedProject(db);
    const first = roles.create({ projectId: pid, name: 'r', gender: 'male', appearanceSeed: 42 });
    const second = roles.create({ projectId: pid, name: 'r2', archetype: '思考' });
    expect(second.gender).toBe('male');
    expect(second.appearanceSeed).toBe(42);
    expect(second.id).toBe(first.id);
    // 显式给 = 覆盖
    const third = roles.create({ projectId: pid, name: 'r3', gender: 'female', appearanceSeed: 7 });
    expect(third.gender).toBe('female');
    expect(third.appearanceSeed).toBe(7);
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

  it('性别/外貌种子透传：显式值持久化 + role.json 带外貌元数据；缺省随机填充', async () => {
    const root2 = mkdtempSync(path.join(tmpdir(), 'weave-rpg-gender-'));
    try {
      const db = openDatabase(':memory:');
      const projects = new ProjectRepository(db);
      const roles = new RpgRoleRepository(db);
      const r = await provisionRole(
        { projects, roles, rolesRoot: root2 },
        { name: 'seeded-role', gender: 'female', appearanceSeed: 987654321 },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.role.gender).toBe('female');
      expect(r.role.appearanceSeed).toBe(987654321);
      const row = roles.getByProjectId(r.role.projectId)!;
      expect(row.gender).toBe('female');
      expect(row.appearanceSeed).toBe(987654321);
      const roleJson = JSON.parse(
        readFileSync(path.join(root2, 'seeded-role', '.weave', 'role.json'), 'utf-8'),
      ) as { gender: unknown; appearanceSeed: unknown };
      expect(roleJson.gender).toBe('female');
      expect(roleJson.appearanceSeed).toBe(987654321);

      // 缺省 = 随机（范围内合法值），DB 与 role.json 一致
      const r2 = await provisionRole({ projects, roles, rolesRoot: root2 }, { name: 'random-role' });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(['male', 'female']).toContain(r2.role.gender);
      expect(r2.role.appearanceSeed).toBeGreaterThanOrEqual(0);
      expect(r2.role.appearanceSeed).toBeLessThanOrEqual(APPEARANCE_SEED_MAX);
      const roleJson2 = JSON.parse(
        readFileSync(path.join(root2, 'random-role', '.weave', 'role.json'), 'utf-8'),
      ) as { appearanceSeed: unknown };
      expect(roleJson2.appearanceSeed).toBe(r2.role.appearanceSeed);
      db.close();
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
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

  it('内建仓库（E4）：hidden 登记 + .mcp.json 四内置服务 + .gitignore 收 .mcp.json', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'weave-rpg-e4-'));
    try {
      const db = openDatabase(':memory:');
      const projects = new ProjectRepository(db);
      const roles = new RpgRoleRepository(db);
      const r = await provisionRole(
        { projects, roles, rolesRoot: root, mcpEndpoint: { port: 6421, token: 'tok-1' } },
        { name: 'e4-keeper', archetype: '思考' },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(projects.getById(r.role.projectId)?.hidden).toBe(true);

      const json = JSON.parse(
        readFileSync(path.join(root, 'e4-keeper', '.mcp.json'), 'utf-8'),
      ) as { mcpServers: Record<string, { type?: string; url?: string; headers?: Record<string, string> }> };
      expect(Object.keys(json.mcpServers).sort()).toEqual([
        'weave-events',
        'weave-orchestration',
        'weave-projects',
        'weave-sessions',
      ]);
      const orch = json.mcpServers['weave-orchestration']!;
      expect(orch.type).toBe('http');
      expect(orch.url).toBe('http://127.0.0.1:6421/api/mcp');
      expect(orch.headers).toEqual({ 'x-weave-local': 'tok-1' });
      // 会话/事件等子服务走 /api/mcp/<server>（端口同源）
      expect(json.mcpServers['weave-sessions']!.url).toBe('http://127.0.0.1:6421/api/mcp/sessions');

      const ignore = readFileSync(path.join(root, 'e4-keeper', '.gitignore'), 'utf-8');
      expect(ignore.split(/\r?\n/)).toContain('.mcp.json');

      // 幂等：不覆盖用户已有键，ignore 不重复追加
      const serverFile = path.join(root, 'e4-keeper', '.mcp.json');
      const userJson = {
        mcpServers: { 'weave-orchestration': { command: 'mine' }, 'user-own': { command: 'x' } },
      };
      writeFileSync(serverFile, JSON.stringify(userJson, null, 2));
      await provisionRole(
        { projects, roles, rolesRoot: root, mcpEndpoint: { port: 6421, token: 'tok-1' } },
        { name: 'e4-second', archetype: '执行' },
      );
      const merged = JSON.parse(readFileSync(serverFile, 'utf-8')) as { mcpServers: Record<string, unknown> };
      expect(merged.mcpServers['weave-orchestration']).toEqual({ command: 'mine' });
      expect(merged.mcpServers['user-own']).toBeDefined();
      const ignoreLines = readFileSync(path.join(root, 'e4-keeper', '.gitignore'), 'utf-8').match(/\.mcp\.json/g);
      expect(ignoreLines).toHaveLength(1);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scaffoldCoordinator', () => {
  it('目录骨架 + 基础七型物化进 agents/roles/ + 项目注册，幂等（二次调用 reused / 不覆盖）', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'weave-rpg-coord-'));
    try {
      const db = openDatabase(':memory:');
      const projects = new ProjectRepository(db);
      const roles = new RpgRoleRepository(db);
      const first = await scaffoldCoordinator({ projects, roles }, root);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.created).toEqual(['teams', 'playbooks', 'state', 'agents', 'projects']);
      expect(first.rolesSeeded).toHaveLength(7);
      expect(first.skillsSeeded).toEqual(['supervise', 'breakout', 'downgrade']);
      expect(existsSync(path.join(root, 'playbooks'))).toBe(true);
      expect(existsSync(path.join(root, 'agents', 'roles', 'thinker', 'weave-plugin.json'))).toBe(true);
      expect(existsSync(path.join(root, '.claude', 'skills', 'supervise', 'SKILL.md'))).toBe(true);
      expect(projects.getByPath(first.path)?.name).toBe('weave');
      const second = await scaffoldCoordinator({ projects, roles }, root);
      expect(second.reused).toBe(true);
      expect(second.rolesSeeded).toHaveLength(0);
      expect(second.skillsSeeded).toHaveLength(0);
      // 2026-11-11 升格：coordinator = superagent 置顶常驻（不再 hidden）
      expect(projects.getByPath(first.path)?.superagent).toBe(true);
      expect(projects.getByPath(first.path)?.hidden).toBe(false);
      expect(existsSync(path.join(root, '.mcp.json'))).toBe(true);
      expect(existsSync(path.join(root, '.gitignore'))).toBe(true);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('出厂 skill 不覆盖用户同名（改后的 SKILL.md 幂等跳过）', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'weave-rpg-coord3-'));
    try {
      const db = openDatabase(':memory:');
      const projects = new ProjectRepository(db);
      const roles = new RpgRoleRepository(db);
      await scaffoldCoordinator({ projects, roles }, root);
      const skillFile = path.join(root, '.claude', 'skills', 'supervise', 'SKILL.md');
      writeFileSync(skillFile, 'user edited', 'utf-8');
      const again = await scaffoldCoordinator({ projects, roles }, root);
      expect(again.skillsSeeded).toHaveLength(0);
      expect(readFileSync(skillFile, 'utf-8')).toBe('user edited');
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('版本戳不同 = 出厂待更新不自动覆盖；force 刷新才重物化', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'weave-rpg-coord4-'));
    try {
      const db = openDatabase(':memory:');
      const projects = new ProjectRepository(db);
      const roles = new RpgRoleRepository(db);
      await scaffoldCoordinator({ projects, roles }, root);
      const skillFile = path.join(root, '.claude', 'skills', 'supervise', 'SKILL.md');
      const stampFile = path.join(root, '.weave', 'scaffold-version');
      expect(readStampVersion(stampFile)).toBe(WEAVE_VERSION);
      // 同版本：用户编辑保留（上一用例同判据，这里顺带盖一遍往返）
      writeFileSync(skillFile, 'user edited', 'utf-8');
      // 版本变化：**不自动覆盖**（2026-11-13 裁决——更新不覆盖，手动按钮驱动），
      // 只标 factoryOutdated；用户点按钮（force）才重物化 + stamp 回写。
      writeFileSync(stampFile, '0.0.0-stale\n', 'utf-8');
      const stale = await scaffoldCoordinator({ projects, roles }, root);
      expect(stale.factoryOutdated).toBe(true);
      expect(readFileSync(skillFile, 'utf-8')).toBe('user edited');
      const refreshed = await scaffoldCoordinator({ projects, roles }, root, { force: true });
      expect(refreshed.factoryOutdated).toBeUndefined();
      expect(refreshed.skillsSeeded).toEqual(['supervise', 'breakout', 'downgrade']);
      expect(readFileSync(skillFile, 'utf-8')).not.toBe('user edited');
      expect(readStampVersion(stampFile)).toBe(WEAVE_VERSION);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('给了编排仓储 → 出厂示例编排（记忆出口演示，停用态）；同名即用户资产不覆盖', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'weave-rpg-coord5-'));
    try {
      const db = openDatabase(':memory:');
      const projects = new ProjectRepository(db);
      const roles = new RpgRoleRepository(db);
      const orchestrations = new OrchestrationRepository(db);
      await scaffoldCoordinator({ projects, roles, orchestrations }, root);
      const project = projects.getByPath(path.resolve(root))!;
      const rows = orchestrations.list().filter((o) => o.projectId === project.id);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.name).toBe('记忆出口示例');
      expect(row.enabled).toBe(false); // 出厂即停用：演示形状，用户启用/复制才跑
      expect(row.nodes.map((n) => n.kind)).toEqual(['trigger', 'memory']);
      expect(row.edges[0]).toMatchObject({ from: 't:memory-demo', to: 'm:project-verdicts' });
      // 第二次物化：同名已在 → 幂等不叠
      await scaffoldCoordinator({ projects, roles, orchestrations }, root);
      expect(orchestrations.list().filter((o) => o.projectId === project.id)).toHaveLength(1);
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
        { name: 'my-auditor', pluginDir: path.join(root, 'agents', 'roles', 'auditor') },
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
  }, 30_000);
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
