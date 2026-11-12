import { describe, it, expect, afterAll } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { RpgGoalRepository } from '../goals.js';
import { RpgRoutingDecisionRepository } from '../routing.js';
import { MergeLadderRepository } from '../merge-ladder.js';
import { RpgExpeditionRepository } from '../expedition-repo.js';
import { ProjectRepository } from '../../repositories/projects.js';

/**
 * 任务卡详情端点（G6 批7，GET /rpg/goals/:id/detail）：goal 本行 + 出征行 +
 * 决策轨迹（input.goalId 命中过滤——别的 goal 的行不串）+ 合并梯（expedition
 * 归属过滤）。e2e 走 makeEvolutionServer，行经仓储直植（不绕端点造假账）。
 */

let cleanupDb: Array<{ db: DatabaseSync }> = [];
afterAll(() => {
  for (const x of cleanupDb) x.db.close();
  cleanupDb = [];
});

describe('任务卡详情端点 e2e（三 tab 数据面）', () => {
  it('detail 一次拉齐：goal + 出征 + 决策过滤 + 合并梯过滤；404 如实', async () => {
    const { makeEvolutionServer } = await import('./helpers/evolution-server.js');
    const { server, port, db, cleanup } = await makeEvolutionServer();
    cleanupDb.push({ db });
    try {
      const goals = new RpgGoalRepository(db);
      const routing = new RpgRoutingDecisionRepository(db);
      const expeditions = new RpgExpeditionRepository(db);
      const ladder = new MergeLadderRepository(db);
      const now = new Date().toISOString();

      const projects = new ProjectRepository(db);
      const projectId = projects.register({ path: '/tmp/g6b7-proj', name: 'g6b7-proj', token: 'x', source: 'init' }).id;
      const role = db
        .prepare('INSERT INTO rpg_roles (project_id, name, created_at) VALUES (?, ?, ?)')
        .run(projectId, 'g6b7-role', now);
      const roleId = Number(role.lastInsertRowid);
      const goalA = goals.insert({ roleId, title: 'A', terminal: 'tests green', projectId });
      const goalB = goals.insert({ roleId, title: 'B', terminal: 'lint green', projectId });

      // 决策：A 两条（一条带 goalId 命中）、B 一条、还有一条 input 不是 JSON（不炸）
      routing.insert({ projectId: null, sessionId: null, action: 'budget-renew', level: 2, basis: 'value', input: JSON.stringify({ goalId: goalA.id }), result: 'pending', source: null, detail: 'A 预算尽' });
      routing.insert({ projectId: null, sessionId: null, action: 'downgrade', level: 2, basis: 'value', input: JSON.stringify({ goalId: goalA.id }), result: 'approved', source: null, detail: 'A 降级' });
      routing.insert({ projectId: null, sessionId: null, action: 'budget-renew', level: 2, basis: 'value', input: JSON.stringify({ goalId: goalB.id }), result: 'approved', source: null, detail: 'B 预算' });
      routing.insert({ projectId: null, sessionId: null, action: 'patrol', level: 1, basis: 'reversible', input: 'not json', result: 'allowed', source: null, detail: null });

      expeditions.insert({ roleId, projectId, sessionKey: null, branch: 'weave/session-a', anchorBranch: 'main', anchorSha: 'aaaa1111' });
      expeditions.insert({ roleId, projectId, sessionKey: null, branch: 'weave/session-b', anchorBranch: 'main', anchorSha: 'bbbb2222' });
      // 合并梯：一行归本角色的出征、一行归别的角色的出征（同项目）——过滤只认前者
      const project2 = projects.register({ path: '/tmp/g6b7-proj2', name: 'g6b7-proj2', token: 'x', source: 'init' });
      const role2 = db
        .prepare('INSERT INTO rpg_roles (project_id, name, created_at) VALUES (?, ?, ?)')
        .run(project2.id, 'g6b7-role2', now);
      const expOfA = expeditions.insert({ roleId, projectId, sessionKey: null, branch: 'weave/session-a2', anchorBranch: 'main', anchorSha: 'cccc3333' });
      const expOfRole2 = expeditions.insert({ roleId: Number(role2.lastInsertRowid), projectId, sessionKey: null, branch: 'weave/session-x', anchorBranch: 'main', anchorSha: 'dddd4444' });
      ladder.insert({ expedition: expOfA.id, projectId, fromBranch: 'weave/session-a2', intoBranch: 'main', layer: 'rerere', outcome: 'ok', signature: 'sig-a', reason: 'rerere 复用' });
      ladder.insert({ expedition: expOfRole2.id, projectId, fromBranch: 'weave/session-x', intoBranch: 'main', layer: 'mechanical', outcome: 'ok', signature: 'sig-x', reason: null });

      const call = (m: string, u: string) => fetch(`http://127.0.0.1:${port}${u}`, { method: m });
      const detail = (await (await call('GET', `/rpg/goals/${goalA.id}/detail`)).json()) as {
        goal: { title: string };
        expeditions: Array<{ branch: string }>;
        decisions: Array<{ detail: string | null; input: string | null }>;
        ladder: Array<{ layer: string; expedition: number | null }>;
      };
      expect(detail.goal.title).toBe('A');
      expect(detail.decisions).toHaveLength(2);
      expect(detail.decisions.every((d) => JSON.parse(d.input ?? '{}').goalId === goalA.id)).toBe(true);
      // 合并梯只认该角色出征的行
      expect(detail.ladder).toHaveLength(1);
      expect(detail.ladder[0]!.expedition).toBe(expOfA.id);
      // expeditions = 角色的全部出征（不按 goal 过滤——goal 层挂角色层）
      expect(detail.expeditions.length).toBeGreaterThanOrEqual(3);

      const miss = await call('GET', '/rpg/goals/99999/detail');
      expect(miss.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanup();
    }
  }, 30_000);
});
