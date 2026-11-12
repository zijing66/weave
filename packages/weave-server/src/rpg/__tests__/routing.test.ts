import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { MessageDeliverer } from '../../hooks/message-deliverer.js';
import { purgeSession } from '../../hooks/session-purge.js';
import { createWeaveServer } from '../../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../../daemon/settings.js';
import { RpgRoleRepository, RpgGrowthRepository } from '../roles.js';
import { RPG_ROUTED_ACTIONS, RpgRoutingDecisionRepository, routeRpgAction } from '../routing.js';
import type { ProjectOpener } from '../../daemon/opener.js';

/**
 * 决策分级路由（G6 批1，G线设计 §六）：路由词表唯一权威 + 纯函数四级瀑布 +
 * 决策账（rpg_routing_decisions：pending→approved/rejected 状态机、翻案位、
 * 会话级联）+ 信箱端点 e2e（晋升落账是第一份真实数据源）。
 */

describe('路由词表与纯函数', () => {
  it('级2 八条 + 级1 三枚全在词表；级2 条条判据三选一（irreversible/boundary/value）', () => {
    const entries = Object.entries(RPG_ROUTED_ACTIONS);
    expect(entries.filter(([, v]) => v.level === 2)).toHaveLength(8);
    expect(entries.filter(([, v]) => v.level === 1)).toHaveLength(3);
    for (const [, v] of entries) {
      expect([1, 2]).toContain(v.level);
      expect(v.basis.length).toBeGreaterThan(0);
      if (v.level === 2) {
        // 级2 判据必须含三选一（不可逆/跨边界/价值敏感）
        const codes = v.basis.split('|');
        expect(codes.some((c) => c === 'irreversible' || c === 'boundary' || c === 'value')).toBe(true);
      }
    }
  });

  it('routeRpgAction：词表查询 / 未知动作缺省级0 / tripped 级3 罩一切', () => {
    expect(routeRpgAction('crop-promote')).toEqual({ level: 2, basis: 'irreversible|value' });
    expect(routeRpgAction('patrol')).toEqual({ level: 1, basis: 'reversible' });
    // 不在词表 = 零智能直行（级0：机械重放/品阶评定等确定性规则不进词表）
    expect(routeRpgAction('merge-replay')).toEqual({ level: 0, basis: 'rule' });
    // 机制熔断优先：级3 不问任何人（罩级2 同样成立）
    for (const action of ['crop-promote', 'unknown-thing']) {
      expect(routeRpgAction(action, { tripped: true }).level).toBe(3);
    }
  });
});

describe('决策账（rpg_routing_decisions）', () => {
  it('schema 幂等建出（rpg_routing_decisions）', () => {
    const db = openDatabase(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(tables).toContain('rpg_routing_decisions');
    expect(() => db.exec('SELECT 1 FROM rpg_routing_decisions')).not.toThrow();
    db.close();
  });

  it('insert/list/listPending：id 倒序；pending 只挑未决', () => {
    const db = openDatabase(':memory:');
    const repo = new RpgRoutingDecisionRepository(db);
    const p = new ProjectRepository(db).register({ path: '/tmp/rpg-route-a', name: 'a', token: 't', source: 'init' });
    repo.insert({ projectId: p.id, sessionId: null, action: 'crop-promote', level: 2, basis: 'irreversible|value', input: '{"cropId":1}', result: 'approved', source: 'god', detail: 'tier 2' });
    repo.insert({ projectId: null, sessionId: 'sess-1', action: 'goal-change', level: 2, basis: 'irreversible|value', input: null, result: 'pending', source: null, detail: '协调者预告' });
    expect(repo.list().map((r) => r.action)).toEqual(['goal-change', 'crop-promote']);
    expect(repo.listPending().map((r) => r.action)).toEqual(['goal-change']);
    expect(repo.list({ projectId: p.id }).map((r) => r.action)).toEqual(['crop-promote']);
    db.close();
  });

  it('decide 状态机：pending → approved/rejected；重复裁决与未知 id 都拒改', () => {
    const db = openDatabase(':memory:');
    const repo = new RpgRoutingDecisionRepository(db);
    const row = repo.insert({ projectId: null, sessionId: null, action: 'budget-renew', level: 2, basis: 'value', input: null, result: 'pending', source: null, detail: null });
    const ok = repo.decide(row.id, true)!;
    expect(ok.result).toBe('approved');
    expect(ok.source).toBe('god');
    // 裁决是一次性事实：已决行与不存在的 id 都返回 null
    expect(repo.decide(row.id, false)).toBeNull();
    expect(repo.decide(9999, true)).toBeNull();
    const row2 = repo.insert({ projectId: null, sessionId: null, action: 'downgrade', level: 2, basis: 'irreversible|value', input: null, result: 'pending', source: null, detail: null });
    expect(repo.decide(row2.id, false)!.result).toBe('rejected');
    db.close();
  });

  it('overturn 翻案位：翻一次成功、幂等重翻 false；result 不改写（历史事实保留）', () => {
    const db = openDatabase(':memory:');
    const repo = new RpgRoutingDecisionRepository(db);
    const row = repo.insert({ projectId: null, sessionId: null, action: 'dispatch', level: 1, basis: 'reversible', input: null, result: 'allowed', source: 'fork', detail: 'P(yes)=0.8' });
    expect(repo.overturn(row.id)).toBe(true);
    const after = repo.get(row.id)!;
    expect(after.overturned).toBe(1);
    expect(after.result).toBe('allowed'); // 翻案只翻位不改结果
    expect(repo.overturn(row.id)).toBe(false);
    db.close();
  });

  it('deleteBySession 只清命中会话的行（信箱不留僵尸待批）', () => {
    const db = openDatabase(':memory:');
    const repo = new RpgRoutingDecisionRepository(db);
    repo.insert({ projectId: null, sessionId: 'sess-x', action: 'goal-change', level: 2, basis: 'irreversible|value', input: null, result: 'pending', source: null, detail: null });
    repo.insert({ projectId: null, sessionId: null, action: 'crop-promote', level: 2, basis: 'irreversible|value', input: null, result: 'approved', source: 'god', detail: null });
    expect(repo.deleteBySession('sess-x')).toBe(1);
    expect(repo.list().map((r) => r.action)).toEqual(['crop-promote']); // 无会话语境的行留在账上
    db.close();
  });

  it('stats：按 result 计数 + 翻案合计（复盘扫描的数据源）', () => {
    const db = openDatabase(':memory:');
    const repo = new RpgRoutingDecisionRepository(db);
    const a = repo.insert({ projectId: null, sessionId: null, action: 'patrol', level: 1, basis: 'reversible', input: null, result: 'allowed', source: 'fork', detail: null });
    repo.insert({ projectId: null, sessionId: null, action: 'patrol', level: 1, basis: 'reversible', input: null, result: 'blocked', source: 'fork', detail: null });
    repo.overturn(a.id);
    repo.insert({ projectId: null, sessionId: null, action: 'crop-promote', level: 2, basis: 'irreversible|value', input: null, result: 'approved', source: 'god', detail: null });
    const s = repo.stats();
    expect(s).toMatchObject({ total: 3, allowed: 1, blocked: 1, approved: 1, overturned: 1, pending: 0 });
    db.close();
  });
});

describe('purgeSession 级联（G6 决策账随会话清）', () => {
  it('挂 routingDecisions 则 deleteBySession 被调；未挂不炸（可选 pick）', () => {
    const db = openDatabase(':memory:');
    const repo = new RpgRoutingDecisionRepository(db);
    repo.insert({ projectId: null, sessionId: 'sess-p', action: 'nudge', level: 1, basis: 'reversible', input: null, result: 'allowed', source: 'fork', detail: null });
    const calls: string[] = [];
    purgeSession(
      {
        sessions: new SessionRepository(db),
        events: new HookEventRepository(db),
        routingDecisions: { deleteBySession: (id: string) => { calls.push(id); return repo.deleteBySession(id); } },
      },
      'sess-p',
    );
    expect(calls).toEqual(['sess-p']);
    expect(repo.list()).toHaveLength(0);
    // 未挂（RPG 子系统关闭）路径不炸
    expect(() =>
      purgeSession({ sessions: new SessionRepository(db), events: new HookEventRepository(db) }, 'other'),
    ).not.toThrow();
    db.close();
  });
});

describe('信箱端点 e2e（GET /rpg/routing/decisions + POST decide + 晋升落账）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let roleId: number;
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
    const rolesRoot = mkdtempSync(path.join(tmpdir(), 'weave-routing-roles-'));
    tmpDirs.push(rolesRoot);
    const builtinRoot = mkdtempSync(path.join(tmpdir(), 'weave-routing-builtin-'));
    tmpDirs.push(builtinRoot);
    const hooksTmp = mkdtempSync(path.join(tmpdir(), 'weave-routing-hooks-'));
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
    const res = await call('POST', '/rpg/roles', { name: 'router', archetype: '执行' });
    roleId = ((await res.json()) as { id: number }).id;
  });

  afterAll(async () => {
    server.close();
    db.close();
    setDaemonSettingsDb(null);
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('① 空账如实回零（不摆空壳数据源）', async () => {
    const res = await call('GET', '/rpg/routing/decisions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decisions: unknown[]; pending: number; stats: { total: number } };
    expect(body.decisions).toEqual([]);
    expect(body.pending).toBe(0);
    expect(body.stats.total).toBe(0);
  });

  it('② 晋升逐字段落账（级2 · 上帝当场批 · 词表判据不散写）', async () => {
    // 长出一株灵品作物（真链路：下种 → 写盘 → 验收 → 晋升 tier2 = 内建仓库副本）
    const plant = (await (
      await call('POST', `/rpg/roles/${roleId}/crops`, { kind: 'farming', name: 'routing-crop' })
    ).json()) as { cropId: number; fieldPath: string };
    writeFileSync(path.join(plant.fieldPath, 'SKILL.md'), '# routing-crop\n\n正文。\n', 'utf8');
    mkdirSync(path.join(plant.fieldPath, 'tests'), { recursive: true });
    writeFileSync(path.join(plant.fieldPath, 'tests', 'basic.test.ts'), 'it("works", () => {});\n', 'utf8');
    await call('POST', `/rpg/crops/${plant.cropId}/assess`, { hasArtifact: true, hasTests: true, lintOk: false, docsOk: false });
    const promote = await call('POST', `/rpg/crops/${plant.cropId}/promote`, { tier: 2 });
    expect(promote.status).toBe(200);
    const body = (await (await call('GET', '/rpg/routing/decisions')).json()) as {
      decisions: Array<{ action: string; level: number; result: string; source: string | null; basis: string }>;
    };
    const row = body.decisions.find((d) => d.action === 'crop-promote');
    expect(row).toMatchObject({ action: 'crop-promote', level: 2, result: 'approved', source: 'god', basis: 'irreversible|value' });
  });

  it('③ 上帝裁决端点：pending → approved；重复裁决 409；坏 body 400', async () => {
    // 直接在库上植一行 pending（协调者预告形——G6 批2 的生产者；端点行为同链路）
    const repo = new RpgRoutingDecisionRepository(db);
    const row = repo.insert({
      projectId: null,
      sessionId: null,
      action: 'goal-change',
      level: routeRpgAction('goal-change').level,
      basis: routeRpgAction('goal-change').basis,
      input: JSON.stringify({ goal: '清理依赖' }),
      result: 'pending',
      source: null,
      detail: '分身预告：修炼目标要换成依赖清理',
    });
    const decide = await call('POST', `/rpg/routing/decisions/${row.id}/decide`, { approve: true });
    expect(decide.status).toBe(200);
    const body = (await decide.json()) as { decision: { result: string; source: string } };
    expect(body.decision).toMatchObject({ result: 'approved', source: 'god' });
    // 已决行再裁 = 409（裁决是一次性事实）
    expect((await call('POST', `/rpg/routing/decisions/${row.id}/decide`, { approve: false })).status).toBe(409);
    expect((await call('POST', '/rpg/routing/decisions/9999/decide', { approve: true })).status).toBe(409);
    // 坏 body = 400
    expect((await call('POST', `/rpg/routing/decisions/${row.id}/decide`, { approve: 'yes' })).status).toBe(400);
  });

  it('④ projectId 过滤：只看该项目的轨迹', async () => {
    const repo = new RpgRoutingDecisionRepository(db);
    const other = new ProjectRepository(db).register({ path: '/tmp/rpg-route-b', name: 'b', token: 't', source: 'init' });
    repo.insert({ projectId: other.id, sessionId: null, action: 'nudge', level: 1, basis: 'reversible', input: null, result: 'allowed', source: 'fork', detail: null });
    const body = (await (await call('GET', `/rpg/routing/decisions?projectId=${other.id}`)).json()) as {
      decisions: Array<{ action: string }>;
    };
    expect(body.decisions.map((d) => d.action)).toContain('nudge');
  });
});
