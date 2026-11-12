import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { assertGoalTerminal, GOAL_STATUSES, RpgGoalRepository } from '../goals.js';
import { openDatabase } from '../../db/db.js';
import { RpgRoleRepository, RpgGrowthRepository } from '../roles.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { MessageDeliverer } from '../../hooks/message-deliverer.js';
import { createWeaveServer } from '../../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../../daemon/settings.js';
import type { ProjectOpener } from '../../daemon/opener.js';

/**
 * goal 域仓储（G6 批4a）：终态闸（无明确可终止条件不立项）+ CRUD + 级2 词表口径
 * 的状态机。端点面（POST/GET/PATCH /rpg/goals + 落账）走 rpg-server e2e。
 */
describe('RpgGoalRepository（终态闸 + CRUD）', () => {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  const roles = new RpgRoleRepository(db);
  const goals = new RpgGoalRepository(db);
  const project = projects.register({ path: 'D:/p/goal-demo', name: 'goal-demo', token: 't', source: 'init' });
  const role = roles.create({ projectId: project.id, name: 'gardener', archetype: '执行' });

  it('终态闸：terminal 空/非串拒；trim 后有字放行', () => {
    expect(assertGoalTerminal('')).toEqual({ ok: false, error: expect.any(String) });
    expect(assertGoalTerminal('   ')).toEqual({ ok: false, error: expect.any(String) });
    expect(assertGoalTerminal(42)).toEqual({ ok: false, error: expect.any(String) });
    expect(assertGoalTerminal(' 测试全绿 ')).toEqual({ ok: true });
  });

  it('insert 撞闸抛错；过闸行 terminal 已 trim、status 缺省 active', () => {
    expect(() => goals.insert({ roleId: role.id, title: 'x', terminal: '' })).toThrow();
    const g = goals.insert({
      roleId: role.id,
      title: '让构建稳定',
      terminal: ' 指定测试套件全绿 ',
      houseId: null,
      projectId: project.id,
      budgetTurns: 30,
    });
    expect(g.terminal).toBe('指定测试套件全绿');
    expect(g.status).toBe('active');
    expect(g.budgetTurns).toBe(30);
    expect(g.budgetTokens).toBeNull();
  });

  it('list 按 role/house/project/status 过滤，id 倒序', () => {
    goals.insert({ roleId: role.id, title: 'g2', terminal: '文档齐' });
    const mine = goals.list({ roleId: role.id });
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine[0]!.title).toBe('g2');
    expect(goals.list({ roleId: 404 })).toEqual([]);
    expect(goals.list({ status: 'active', roleId: role.id }).length).toBe(mine.length);
  });

  it('patch 变更走终态闸；updateStatus 落 note；清单 status 过滤', () => {
    const g = goals.insert({ roleId: role.id, title: 'g3', terminal: '终态A' });
    expect(() => goals.patch(g.id, { terminal: '  ' })).toThrow();
    const changed = goals.patch(g.id, { terminal: ' 终态B ', budgetTokens: 5_000_000 });
    expect(changed?.terminal).toBe('终态B');
    expect(changed?.budgetTokens).toBe(5_000_000);
    const done = goals.updateStatus(g.id, 'achieved', '测试全绿命中');
    expect(done?.status).toBe('achieved');
    expect(done?.statusNote).toBe('测试全绿命中');
    expect(goals.list({ status: 'achieved' }).map((x) => x.id)).toContain(g.id);
    expect(GOAL_STATUSES).toContain('budget_out');
  });
});

describe('goal 端点 e2e（POST/GET/PATCH /rpg/goals + 级2 落账）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let roleId: number;
  let goalId: number;
  const tmpDirs: string[] = [];

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
    const rolesRoot = mkdtempSync(path.join(tmpdir(), 'weave-goals-roles-'));
    tmpDirs.push(rolesRoot);
    const hooksTmp = mkdtempSync(path.join(tmpdir(), 'weave-goals-hooks-'));
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
      messageDeliverer: new MessageDeliverer({
        sessions: new SessionRepository(db),
        projects,
        hookEvents: new HookEventRepository(db),
        hooksDir: hooksTmp,
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    const res = await call('POST', '/rpg/roles', { name: 'goalie', archetype: '执行' });
    roleId = ((await res.json()) as { id: number }).id;
  });

  afterAll(async () => {
    server.close();
    db.close();
    setDaemonSettingsDb(null);
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('① 立项终态闸：terminal 缺失 400；过闸 201', async () => {
    const noTerminal = await call('POST', '/rpg/goals', { roleId, title: '无终态目标' });
    expect(noTerminal.status).toBe(400);
    const badRole = await call('POST', '/rpg/goals', { roleId: 404, title: 'x', terminal: 'y' });
    expect(badRole.status).toBe(400);
    const ok = await call('POST', '/rpg/goals', {
      roleId,
      title: '让 weave 目标域可用',
      terminal: 'goal 端点全量测试通过',
      budgetTurns: 30,
    });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { goal: { id: number; status: string; terminal: string } };
    expect(body.goal.status).toBe('active');
    expect(body.goal.terminal).toBe('goal 端点全量测试通过');
    goalId = body.goal.id;
  });

  it('② GET 过滤；PATCH 只调预算落 budget-renew、改目标/状态落 goal-change（词表判据不散写）', async () => {
    const list = await call('GET', `/rpg/goals?roleId=${roleId}`);
    expect(list.status).toBe(200);
    const rows = (await list.json()) as { goals: Array<{ id: number }> };
    expect(rows.goals.map((g) => g.id)).toContain(goalId);
    expect((await (await call('GET', '/rpg/goals?roleId=404')).json()).goals).toEqual([]);

    const renew = await call('PATCH', `/rpg/goals/${goalId}`, { budgetTurns: 60 });
    expect(renew.status).toBe(200);
    const decisions = (await (await call('GET', '/rpg/routing/decisions')).json()) as {
      decisions: Array<{ action: string; result: string; source: string; basis: string }>;
    };
    const last = decisions.decisions[0]!;
    expect(last).toMatchObject({ action: 'budget-renew', result: 'approved', source: 'god' });
    expect(last.basis).toContain('value');

    const change = await call('PATCH', `/rpg/goals/${goalId}`, {
      title: '让 weave 目标域可用（修订）',
      status: 'achieved',
      statusNote: '终态命中',
    });
    expect(((await change.json()) as { goal: { status: string } }).goal.status).toBe('achieved');
    const after = (await (await call('GET', '/rpg/routing/decisions')).json()) as {
      decisions: Array<{ action: string }>;
    };
    expect(after.decisions[0]!.action).toBe('goal-change');
    // 终态闸在 PATCH 同样生效
    const badPatch = await call('PATCH', `/rpg/goals/${goalId}`, { terminal: '' });
    expect(badPatch.status).toBe(400);
    const badStatus = await call('PATCH', `/rpg/goals/${goalId}`, { status: 'weird' });
    expect(badStatus.status).toBe(400);
  });
});
