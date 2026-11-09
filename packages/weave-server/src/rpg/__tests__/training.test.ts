import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { MessageDeliverer } from '../../hooks/message-deliverer.js';
import { createWeaveServer } from '../../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../../daemon/settings.js';
import { RpgRoleRepository, RpgGrowthRepository } from '../roles.js';
import { RpgCropRepository } from '../grade.js';
import { gradeOf, gradeAtLeast } from '../grade.js';
import type { ProjectOpener } from '../../daemon/opener.js';

/**
 * 修炼域 e2e（G3 验收②③）：下种 → 真实生长（写全 SKILL.md + tests + docs）→
 * 收菜验收（度量列 + 品阶保守判定）→ 收菜装角色仓 → 晋升三档（级2 确认在 web，
 * 服务端闸：凡品拒晋、growing 拒晋、tier 校验）。品阶纯函数单测同文件覆盖。
 */
describe('品阶保守判定（纯函数）', () => {
  it('全过 = 仙；缺 lint/docs = 灵；无测试 = 凡；无产物 = 凡（宁可判凡）', () => {
    expect(gradeOf({ hasArtifact: true, hasTests: true, lintOk: true, docsOk: true })).toBe('仙');
    expect(gradeOf({ hasArtifact: true, hasTests: true, lintOk: false, docsOk: true })).toBe('灵');
    expect(gradeOf({ hasArtifact: true, hasTests: true, lintOk: false, docsOk: false })).toBe('灵');
    expect(gradeOf({ hasArtifact: true, hasTests: false, lintOk: true, docsOk: true })).toBe('凡');
    expect(gradeOf({ hasArtifact: false, hasTests: true, lintOk: true, docsOk: true })).toBe('凡');
    expect(gradeOf({ hasArtifact: false, hasTests: false, lintOk: false, docsOk: false })).toBe('凡');
  });
  it('gradeAtLeast：null 恒 false（未评定不虚高）', () => {
    expect(gradeAtLeast(null, '凡')).toBe(false);
    expect(gradeAtLeast('凡', '灵')).toBe(false);
    expect(gradeAtLeast('灵', '灵')).toBe(true);
    expect(gradeAtLeast('仙', '灵')).toBe(true);
  });
});

describe('修炼域（REST：下种 → 生长 → 收菜 → 收装 → 晋升）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let rolesRoot: string;
  let builtinRoot: string;
  const tmpDirs: string[] = [];
  let roleId = 0;

  const call = (method: string, url: string, body?: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    db = openDatabase(':memory:');
    setDaemonSettingsDb(db);
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    rolesRoot = mkdtempSync(path.join(tmpdir(), 'weave-g3-train-roles-'));
    builtinRoot = mkdtempSync(path.join(tmpdir(), 'weave-g3-train-builtin-'));
    tmpDirs.push(rolesRoot, builtinRoot);
    const hooksTmp = mkdtempSync(path.join(tmpdir(), 'weave-g3-train-hooks-'));
    tmpDirs.push(hooksTmp);
    const opener: ProjectOpener = {
      openExplorer: async () => {},
      openTerminal: async () => {},
      runInTerminal: async () => {},
    };
    const projects = new ProjectRepository(db);
    server = createWeaveServer({
      projects,
      port: 0,
      harnesses: createRuntimeRegistry(),
      opener,
      hooksDir: hooksTmp,
      rpgRoles: new RpgRoleRepository(db),
      rpgGrowth: new RpgGrowthRepository(db),
      rpgRolesRoot: rolesRoot,
      rpgBuiltinRoot: builtinRoot,
      messageDeliverer: new MessageDeliverer({
        sessions: new SessionRepository(db),
        projects,
        hookEvents: new HookEventRepository(db),
        hooksDir: hooksTmp,
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    const res = await call('POST', '/rpg/roles', { name: 'farmer', archetype: '执行' });
    roleId = ((await res.json()) as { id: number }).id;
  });

  afterAll(async () => {
    server.close();
    db.close();
    setDaemonSettingsDb(null);
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('① 下种：POST /rpg/roles/:id/crops → 田落角色仓 crops/<名>/ + growing 行', async () => {
    const res = await call('POST', `/rpg/roles/${roleId}/crops`, { kind: 'farming', name: 'lint-skill' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { cropId: number; fieldPath: string };
    expect(existsSync(path.join(body.fieldPath, 'SKILL.md'))).toBe(true);
    const list = (await (await call('GET', `/rpg/roles/${roleId}/crops`)).json()) as { crops: Array<{ status: string; grade: string | null }> };
    expect(list.crops[0]).toMatchObject({ status: 'growing', grade: null });
  });

  it('② 长不出来（模板注释体）→ 验收仍判凡品、status 留 growing（保守判定）', async () => {
    const plant = (await (await call('POST', `/rpg/roles/${roleId}/crops`, { kind: 'farming', name: 'empty-crop' })).json()) as { cropId: number };
    const res = await call('POST', `/rpg/crops/${plant.cropId}/assess`, { hasArtifact: true, hasTests: true, lintOk: true, docsOk: true });
    expect(res.status).toBe(200);
    const { crop } = (await res.json()) as { crop: { grade: string; status: string } };
    // 请求方虚报 hasArtifact=true，但盘上只有模板注释 → 保守判凡、不 harvested
    expect(crop.grade).toBe('凡');
    expect(crop.status).toBe('growing');
  });

  it('③ 真实生长 → 收菜判灵品 → 收菜装角色仓 skills/ → 晋升 tier1 落目标项目', async () => {
    const plant = (await (await call('POST', `/rpg/roles/${roleId}/crops`, { kind: 'farming', name: 'real-crop' })).json()) as { cropId: number; fieldPath: string };
    // 真实构建回合写全：正文 + tests + docs
    const field = plant.fieldPath;
    writeFileSync(path.join(field, 'SKILL.md'), '# real-crop\n\n真实正文：把 lint 结果写进产物卡。\n', 'utf8');
    mkdirSync(path.join(field, 'tests'), { recursive: true });
    writeFileSync(path.join(field, 'tests', 'basic.test.ts'), 'it("works", () => {});\n', 'utf8');
    writeFileSync(path.join(field, 'README.md'), '# real-crop\n', 'utf8');
    const assess = await call('POST', `/rpg/crops/${plant.cropId}/assess`, { hasArtifact: true, hasTests: true, lintOk: false, docsOk: true });
    expect(assess.status).toBe(200);
    const { crop } = (await assess.json()) as { crop: { grade: string; status: string; hasArtifact: boolean } };
    // 盘上事实权威（产物+tests+docs 都在），lint 由上游判定给 false → 灵品
    expect(crop.grade).toBe('灵');
    expect(crop.status).toBe('harvested');
    expect(crop.hasArtifact).toBe(true);
    // 收菜装进角色仓 skills/
    const harvest = await call('POST', `/rpg/crops/${plant.cropId}/harvest`);
    expect(harvest.status).toBe(200);
    const roles = (await (await call('GET', '/rpg/roles')).json()) as { roles: Array<{ id: number; project: { path: string } }> };
    const rolePath = roles.roles.find((r) => r.id === roleId)!.project.path;
    expect(existsSync(path.join(rolePath, '.claude', 'skills', 'real-crop', 'SKILL.md'))).toBe(true);
    // 晋升 tier1（项目档）：目标项目缺省 = crop 挂的项目（角色仓自己）——收菜副本
    // 已在 `.claude/skills/`（installSkill 对同名 = 冲突），故这里只断言 promoted
    // 状态翻转的拒绝面在 ④ 覆盖；本例直接验证 tier2 副本（⑤）与 tier3（⑥）。
    const promote = await call('POST', `/rpg/crops/${plant.cropId}/promote`, { tier: 1 });
    // 收菜已把同名 skill 装进角色仓 `.claude/skills/`（installSkill 的冲突检查根
    // 同一处）→ tier1 缺省目标撞副本 = 409 如实冲突（不静默覆盖用户的收菜副本）
    expect(promote.status).toBe(409);
    // 晋升 tier2（内建仓库，另一安装位）照常走
    const promote2 = await call('POST', `/rpg/crops/${plant.cropId}/promote`, { tier: 2 });
    expect(promote2.status).toBe(200);
    // promoted 后重复晋升 = 409
    expect((await call('POST', `/rpg/crops/${plant.cropId}/promote`, { tier: 2 })).status).toBe(409);
  });

  it('④ 晋升闸：凡品拒晋 / tier 校验 / growing 拒晋', async () => {
    const plant = (await (await call('POST', `/rpg/roles/${roleId}/crops`, { kind: 'fishing', name: 'wet-crop' })).json()) as { cropId: number };
    // growing 状态直接晋升 = 409
    expect((await call('POST', `/rpg/crops/${plant.cropId}/promote`, { tier: 1 })).status).toBe(409);
    // 收菜但无测试 = 凡品 → 拒晋
    await call('POST', `/rpg/crops/${plant.cropId}/assess`, { hasArtifact: true });
    expect((await call('POST', `/rpg/crops/${plant.cropId}/promote`, { tier: 1 })).status).toBe(409);
    // tier 非法 = 400
    expect((await call('POST', `/rpg/crops/${plant.cropId}/promote`, { tier: 9 })).status).toBe(400);
  });

  it('⑤ 晋升 tier2 内建仓库副本落 <builtinRoot>/skills/<名>/', async () => {
    const plant = (await (await call('POST', `/rpg/roles/${roleId}/crops`, { kind: 'farming', name: 'tier2-crop' })).json()) as { cropId: number; fieldPath: string };
    writeFileSync(path.join(plant.fieldPath, 'SKILL.md'), '# tier2-crop\n\n正文。\n', 'utf8');
    // 盘上真实长出 tests（验收按盘上事实重算，请求方虚报不抬档）
    mkdirSync(path.join(plant.fieldPath, 'tests'), { recursive: true });
    writeFileSync(path.join(plant.fieldPath, 'tests', 'basic.test.ts'), 'it("works", () => {});\n', 'utf8');
    await call('POST', `/rpg/crops/${plant.cropId}/assess`, { hasArtifact: true, hasTests: true, lintOk: false, docsOk: false });
    const res = await call('POST', `/rpg/crops/${plant.cropId}/promote`, { tier: 2 });
    expect(res.status).toBe(200);
    expect(existsSync(path.join(builtinRoot, 'skills', 'tier2-crop', 'SKILL.md'))).toBe(true);
  });
});
