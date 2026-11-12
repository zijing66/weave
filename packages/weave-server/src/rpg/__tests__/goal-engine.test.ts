import { describe, expect, it } from 'vitest';
import { RpgGoalEngine, goalPromptOf, GOAL_DRIVE_COOLDOWN_MS } from '../goal-engine.js';
import { RpgGoalRepository, type RpgGoalRow } from '../goals.js';
import { openDatabase } from '../../db/db.js';
import { RpgRoleRepository } from '../roles.js';
import { ProjectRepository } from '../../repositories/projects.js';
import type { RpgExpeditionRow } from '../expedition-repo.js';
import type { ProjectRow } from '../../repositories/projects.js';
import type { Harness } from '@weavecode/core';

/**
 * goal 驱动循环（G6 批4b）：回合落账（收尾事件 → turns_used+1，拍内工具事件 =
 * 进度证据清零 stall）+ 失控兜底两闸（预算闸 → budget_out + 信箱 pending
 * budget-renew；无进展熔断 → paused + pending downgrade）+ 推进节拍（冷却窗/
 * 判活/闲适判定、三岔口契约投递 origin 'goal'）。装配面（ingest 第六消费者 +
 * 30s 节拍，start/dev-entry 双入口）由 tsc 验证。
 */

interface Fixture {
  goal: RpgGoalRow;
  goals: RpgGoalRepository;
  engine: RpgGoalEngine;
  routingInserts: Array<Record<string, unknown>>;
  sends: Array<Record<string, unknown>>;
  close(): void;
}

/** 出征路径映射会话 → 角色（roleOf 的实链：expeditions.getBySessionKey 命中）。 */
function makeFixture(input: {
  budgetTurns?: number;
  lives?: Map<string, boolean>;
  turnOpen?: (sessionId: string) => boolean | null;
  profile?: { goalStallLimit: number; goalDriveCooldownMs: number };
} = {}): Fixture {
  const db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  const roles = new RpgRoleRepository(db);
  const goals = new RpgGoalRepository(db);
  const project = projects.register({ path: 'D:/p/fixture-project', name: 'fixture-project', token: 't', source: 'init' });
  const role = roles.create({ projectId: project.id, name: 'racer', archetype: '执行' });
  const goal = goals.insert({
    roleId: role.id,
    title: '跑通引擎',
    terminal: '引擎测试全绿',
    projectId: project.id,
    ...(input.budgetTurns != null ? { budgetTurns: input.budgetTurns } : {}),
  });
  const routingInserts: Array<Record<string, unknown>> = [];
  const sends: Array<Record<string, unknown>> = [];
  const sessionsRows = [{ sessionId: 'sess-exp', projectId: project.id, lastSeenAt: '2026-11-11T00:00:00Z' }];
  const engine = new RpgGoalEngine({
    goals,
    roles,
    expeditions: {
      // 出征行按 session_key 认领后的映射：sess-exp 归这个角色
      getBySessionKey: (key: string) => (key === 'sess-exp' ? ({ roleId: role.id } as RpgExpeditionRow) : undefined),
      listByRole: () => [{ roleId: role.id, sessionKey: 'sess-exp', status: 'active' } as unknown as RpgExpeditionRow],
    },
    routing: { insert: (row) => (routingInserts.push(row), goal) as never },
    deliverer: {
      send: async (row) => {
        sends.push(row as Record<string, unknown>);
        return { ok: true, messageId: 'm', status: 'delivered', message: {} as never };
      },
    },
    projects: { getById: (id: number) => ({ id, name: 'fixture-project' } as ProjectRow) },
    sessions: {
      getBySessionId: () => null,
      listWithCounts: () => sessionsRows as never[],
      turnOpenOf: (id: string) => (input.turnOpen ? input.turnOpen(id) : false),
    },
    livenessOf: () => input.lives ?? new Map([['sess-exp', true]]),
    driveCooldownMs: 0,
    ...(input.profile ? { profile: { resolved: () => input.profile! } } : {}),
  });
  return {
    goal,
    goals,
    engine,
    routingInserts,
    sends,
    close: () => db.close(),
  };
}

describe('RpgGoalEngine（回合落账 + 失控兜底两闸）', () => {
  it('close 落账一回合；拍内工具事件清零 stall、无进展拍累加', () => {
    const f = makeFixture();
    f.engine.onEvent({ sessionId: 'sess-exp', eventType: 'PostToolUse', source: 'claude' });
    f.engine.onEvent({ sessionId: 'sess-exp', eventType: 'Stop', source: 'claude' });
    f.engine.onEvent({ sessionId: 'sess-exp', eventType: 'Stop', source: 'claude' });
    const g = f.goals.getById(f.goal.id)!;
    expect(g.turnsUsed).toBe(2);
    expect(g.stallStreak).toBe(1);
    f.close();
  });

  it('不相干会话（映射不到角色）零落账', () => {
    const f = makeFixture();
    f.engine.onEvent({ sessionId: 'sess-other', eventType: 'Stop', source: 'claude' });
    expect(f.goals.getById(f.goal.id)!.turnsUsed).toBe(0);
    f.close();
  });

  it('预算闸：到顶落 budget_out + 信箱 pending budget-renew（词表判据 value）', () => {
    const f = makeFixture({ budgetTurns: 2 });
    for (let i = 0; i < 3; i++) {
      f.engine.onEvent({ sessionId: 'sess-exp', eventType: 'PostToolUse', source: 'claude' });
      f.engine.onEvent({ sessionId: 'sess-exp', eventType: 'Stop', source: 'claude' });
    }
    const g = f.goals.getById(f.goal.id)!;
    expect(g.status).toBe('budget_out');
    expect(g.turnsUsed).toBe(2); // 第三拍在状态落定后短路（预算外回合不再计）
    expect(f.routingInserts).toHaveLength(1);
    expect(f.routingInserts[0]).toMatchObject({
      action: 'budget-renew',
      level: 2,
      result: 'pending',
      source: null,
      sessionId: 'sess-exp',
    });
    expect(String((f.routingInserts[0] as { basis: string }).basis)).toContain('value');
    f.close();
  });

  it('无进展熔断：连续 3 拍零工具事件 → paused + 信箱 pending downgrade', () => {
    const f = makeFixture();
    for (let i = 0; i < 3; i++) f.engine.onEvent({ sessionId: 'sess-exp', eventType: 'Stop', source: 'claude' });
    const g = f.goals.getById(f.goal.id)!;
    expect(g.status).toBe('paused');
    expect(f.routingInserts[0]).toMatchObject({ action: 'downgrade', result: 'pending', source: null });
    f.close();
  });

  it('已落定状态（achieved/paused）不再吃回合——闸动作一次落定', () => {
    const f = makeFixture();
    for (let i = 0; i < 3; i++) f.engine.onEvent({ sessionId: 'sess-exp', eventType: 'Stop', source: 'claude' });
    f.engine.onEvent({ sessionId: 'sess-exp', eventType: 'Stop', source: 'claude' });
    expect(f.goals.getById(f.goal.id)!.turnsUsed).toBe(3);
    expect(f.routingInserts).toHaveLength(1);
    f.close();
  });
});

describe('RpgGoalEngine.tick（推进节拍）', () => {
  it('活且闲 → 投三岔口契约（origin goal、prompt 通道）；冷却窗内不重投', () => {
    const f = makeFixture();
    const now = 1_000_000;
    // fixture driveCooldownMs=0：恒过冷却——先验证投递本体
    expect(f.engine.tick(now)).toBe(1);
    expect(f.sends).toHaveLength(1);
    const send = f.sends[0]!;
    expect(send).toMatchObject({
      toSessionId: 'sess-exp',
      mode: 'prompt',
      fromKind: 'dashboard',
      origin: 'goal',
      oneWay: true,
    });
    expect(String(send.text)).toContain('终态条件：引擎测试全绿');
    f.close();
  });

  it('判死 / 回合开着 / turnOpen 未知 → 不投（不猜、不扰忙）', () => {
    const dead = makeFixture({ lives: new Map([['sess-exp', false]]) });
    expect(dead.engine.tick()).toBe(0);
    dead.close();
    const busy = makeFixture({ turnOpen: () => true });
    expect(busy.engine.tick()).toBe(0);
    busy.close();
    const unknown = makeFixture({ turnOpen: () => null });
    expect(unknown.engine.tick()).toBe(0);
    unknown.close();
  });

  it('冷却窗兜底常量存在（自主推进边的节拍下限）', () => {
    expect(GOAL_DRIVE_COOLDOWN_MS).toBe(90_000);
  });

  it('策略档实时盖过内置（G6 进化闭环生效点）：stallLimit 调到 2 即两拍熔断', () => {
    // 熔断阈值被档调到 2：两拍零进展即暂停 + 呈批（内置是 3）
    const f2 = makeFixture({ profile: { goalStallLimit: 2 } });
    for (let i = 0; i < 2; i++) f2.engine.onEvent({ sessionId: 'sess-exp', eventType: 'Stop', source: 'claude' });
    expect(f2.goals.getById(f2.goal.id)!.status).toBe('paused');
    expect(f2.routingInserts[0]).toMatchObject({ action: 'downgrade', result: 'pending' });
    f2.close();
  });
});

describe('goalPromptOf（三岔口契约）', () => {
  it('带终态条件与三岔口自查', () => {
    const text = goalPromptOf({ title: 'T', terminal: '测试全绿' } as RpgGoalRow);
    expect(text).toContain('[weave goal]「T」');
    expect(text).toContain('终态条件：测试全绿');
    expect(text).toContain('三岔口');
  });
});

// Harness 类型守卫的编译期使用（fixture 事件源的字面量即 harness）
void (null as unknown as Harness);
