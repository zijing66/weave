import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import {
  RpgGrowthRepository,
  RpgHexagramRepository,
  RpgRoleRepository,
  RpgScoreRepository,
  archetypeBaseline,
  hexagonWithSkills,
  mainDimOf,
  skillScoreOf,
} from '../roles.js';
import { cultivate, currentHexagonOf, expedition, formTeam, transmit } from '../verbs.js';

/** 动词门面（修炼/组队/出征/传音）+ 六维派生纯函数。 */

describe('六维派生纯函数', () => {
  it('mainDimOf：主维 = 基线最高维，并列取词表序靠前', () => {
    expect(mainDimOf(archetypeBaseline('思考'))).toBe('智慧');
    expect(mainDimOf(archetypeBaseline('执行'))).toBe('速度');
    expect(mainDimOf(archetypeBaseline('适配'))).toBe('力量'); // 全 3 并列 → 词表第一
  });

  it('hexagonWithSkills：每次修炼主维 +1、封顶 5，零修炼 = 原基线', () => {
    const base = archetypeBaseline('思考');
    expect(hexagonWithSkills(base, 0)).toEqual(base);
    expect(hexagonWithSkills(base, 2).智慧).toBe(base.智慧 + 2);
    // 思考智慧=5 已达封顶：+5 封顶后不再涨
    expect(hexagonWithSkills(base, 99).智慧).toBe(10);
    // 其余维度不动
    const grown = hexagonWithSkills(base, 1);
    expect(grown.力量).toBe(base.力量);
    expect(grown.运气).toBe(base.运气);
  });

  it('currentHexagonOf：缺基线行回七型模板', () => {
    const hex = currentHexagonOf({ archetype: '执行', hexagon: null }, 1);
    expect(hex).toEqual(hexagonWithSkills(archetypeBaseline('执行'), 1));
  });

  it('skillScoreOf：确定性、主维越高分越高、封顶 100', () => {
    const a = skillScoreOf('思考');
    expect(a.score).toBe(55 + archetypeBaseline('思考').智慧 * 5);
    expect(a.score).toBeLessThanOrEqual(100);
    expect(skillScoreOf('适配').score).toBe(70);
    // 未知型回「适配」基线（basis 文案按「自定义」）
    expect(skillScoreOf(null).score).toBe(skillScoreOf('适配').score);
    expect(skillScoreOf('不存在的型').score).toBe(skillScoreOf('适配').score);
  });
});

describe('cultivate（修炼）', () => {
  const rolesRoot = mkdtempSync(path.join(tmpdir(), 'weave-rpg-verbs-'));
  const skillSrc = path.join(rolesRoot, 'skill-src', 'sword-basic');
  mkdirSync(skillSrc, { recursive: true });
  writeFileSync(path.join(skillSrc, 'SKILL.md'), '---\nname: sword-basic\n---\n# 剑法基础\n');

  it('修炼 = skill 装进角色仓库 + growth/score/hexagram 三落', async () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const roles = new RpgRoleRepository(db);
    const growth = new RpgGrowthRepository(db);
    const scores = new RpgScoreRepository(db);
    const hexagram = new RpgHexagramRepository(db);
    const r = await (
      await import('../provisioning.js')
    ).provisionRole({ projects, roles, rolesRoot }, { name: 'cultivator', archetype: '思考' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const roleId = roles.getByProjectId(r.role.projectId)!.id;

    const first = await cultivate(
      { projects, roles, growth, scores, hexagram },
      roleId,
      { skill: 'sword-basic', sourceDir: skillSrc },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // skill 落角色仓库（既有 installSkill 唯一写入口）
    expect(existsSync(path.join(r.role.path, '.claude', 'skills', 'sword-basic', 'SKILL.md'))).toBe(true);
    // 技巧分 = 首修落基线派生分
    expect(first.score).toBe(skillScoreOf('思考').score);
    expect(scores.get(roleId)?.score).toBe(first.score);
    // 六维 = 基线 + 1 门修炼
    expect(first.hexagon.智慧).toBe(archetypeBaseline('思考').智慧 + 1);
    // 成长记录
    expect(growth.listByRole(roleId)).toHaveLength(1);
    expect(hexagram.latest(roleId)?.dims.智慧).toBe(first.hexagon.智慧);

    // 二修：+2 分
    const second = await cultivate(
      { projects, roles, growth, scores, hexagram },
      roleId,
      { skill: 'sword-advanced', sourceDir: skillSrc },
    );
    if (second.ok) expect(second.score).toBe(first.score + 2);
    expect(growth.listByRole(roleId)).toHaveLength(2);
    db.close();
  });

  it('角色不存在 404；同名 skill 重复修炼 409、零游戏事实', async () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const roles = new RpgRoleRepository(db);
    const growth = new RpgGrowthRepository(db);
    const scores = new RpgScoreRepository(db);
    const hexagram = new RpgHexagramRepository(db);
    const missing = await cultivate({ projects, roles, growth, scores, hexagram }, 999, {
      skill: 'x',
      sourceDir: skillSrc,
    });
    expect(missing).toMatchObject({ ok: false, status: 404 });

    const r = await (
      await import('../provisioning.js')
    ).provisionRole({ projects, roles, rolesRoot }, { name: 'once-only' });
    if (r.ok) {
      const roleId = roles.getByProjectId(r.role.projectId)!.id;
      const first = await cultivate({ projects, roles, growth, scores, hexagram }, roleId, {
        skill: 'sword-basic',
        sourceDir: skillSrc,
      });
      expect(first.ok).toBe(true);
      const again = await cultivate({ projects, roles, growth, scores, hexagram }, roleId, {
        skill: 'sword-basic',
        sourceDir: skillSrc,
      });
      expect(again).toMatchObject({ ok: false, status: 409 });
      expect(growth.listByRole(roleId)).toHaveLength(1);
    }
    db.close();
  });
});

describe('formTeam（组队）', () => {
  it('teams/ 文件写：name/goal/roles 落盘，同队名重写幂等', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'weave-rpg-team-'));
    try {
      const first = await formTeam({ rolesRoot: root }, undefined, {
        name: 'gank-squad',
        goal: '攻下登录页',
        roles: [{ role: 'thinker' }, { role: 'executor', module: 'frontend' }],
        playbook: 'sprint-flow',
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const file = path.join(root, '..', 'coordinator', 'teams', 'gank-squad.yaml');
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('name: gank-squad');
      expect(text).toContain('playbook: sprint-flow');
      expect(text).toContain('- role: thinker');
      expect(text).toContain('module: frontend');
      // 幂等重写
      const second = await formTeam({ rolesRoot: root }, undefined, {
        name: 'gank-squad',
        roles: [{ role: 'auditor' }],
      });
      expect(second.ok).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain('- role: auditor');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('非法队名 / 空 roles 400', async () => {
    expect(await formTeam({}, undefined, { name: 'Bad!', roles: [{ role: 'a' }] })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await formTeam({ rolesRoot: '/tmp/x' }, undefined, { name: 'ok-name', roles: [] })).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe('expedition / transmit（纯转发动词）', () => {
  it('出征 = 引擎 start + 成长记录；编排缺失 404', async () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const roles = new RpgRoleRepository(db);
    const growth = new RpgGrowthRepository(db);
    const p = projects.register({ path: '/tmp/rpg-exp', name: 'e', token: 't', source: 'init' });
    const role = roles.create({ projectId: p.id, name: 'expediter', archetype: '执行' });
    const started: Array<{ id: number; text?: string }> = [];
    const deps = {
      orchestrations: {
        getById: (id: number) =>
          id === 7
            ? { id, name: 'sprint', projectId: p.id, startText: 'go', nodes: [], edges: [], enabled: true, cron: null, lastCronAt: null, createdAt: '', updatedAt: '' }
            : undefined,
      },
      engine: {
        start: async (id: number, _t: unknown, text?: string) => {
          started.push({ id, text });
          return { ok: true, runId: 'run-1' };
        },
      },
      growth,
      roles,
    };
    const ok = await expedition(deps, role.id, { orchId: 7, text: '出征' });
    expect(ok).toMatchObject({ ok: true, runId: 'run-1', orchName: 'sprint' });
    expect(started).toEqual([{ id: 7, text: '出征' }]);
    expect(growth.listByRole(role.id)[0]).toMatchObject({ verb: 'expedition', target: 'sprint' });

    expect(await expedition(deps, role.id, { orchId: 404 })).toMatchObject({ ok: false, status: 404 });
    expect(await expedition(deps, 9999, { orchId: 7 })).toMatchObject({ ok: false, status: 404 });
    db.close();
  });

  it('传音 = deliverer.send 转发 + 成长记录；失败不落', async () => {
    const db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const roles = new RpgRoleRepository(db);
    const growth = new RpgGrowthRepository(db);
    const p = projects.register({ path: '/tmp/rpg-msg', name: 'm', token: 't', source: 'init' });
    const role = roles.create({ projectId: p.id, name: 'messenger' });
    const sent: Array<{ to: string; text: string }> = [];
    const deps = {
      deliverer: {
        send: async (input: { toSessionId: string; text: string }) => {
          sent.push({ to: input.toSessionId, text: input.text });
          return input.text === 'bad'
            ? { ok: false as const, status: 409, error: 'busy' }
            : { ok: true as const, messageId: 'm-1', status: 'delivered' };
        },
      },
      growth,
      roles,
    };
    const ok = await transmit(deps, role.id, { toSessionId: 'sess-1', text: '你好' });
    expect(ok).toMatchObject({ ok: true, messageId: 'm-1', toSessionId: 'sess-1' });
    expect(sent).toEqual([{ to: 'sess-1', text: '你好' }]);
    expect(growth.listByRole(role.id)[0]).toMatchObject({ verb: 'transmit', target: 'sess-1' });

    expect(await transmit(deps, role.id, { toSessionId: 'sess-1', text: 'bad' })).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(growth.listByRole(role.id)).toHaveLength(1);
    db.close();
  });
});
