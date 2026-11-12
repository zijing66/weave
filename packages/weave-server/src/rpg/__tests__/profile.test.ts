import { describe, it, expect } from 'vitest';
import { RpgProfileRepository, DEFAULT_ROUTING_PROFILE } from '../profile.js';
import { reviewSignalsOf, proposalGatedOf } from '../review.js';
import { openDatabase } from '../../db/db.js';
import { RpgRoutingDecisionRepository, type RpgRoutingDecisionRow } from '../routing.js';
import type { RpgGoalRow } from '../goals.js';

/**
 * 进化闭环（G6 批5）：策略档（append-only 版本链 + is_current 唯一标记 + sanitize
 * 词表闸）+ 复盘信号纯函数（downgrade-misfire 出草稿、overturn/budget 如实报不
 * 硬凑）+ 频率闸。端点 e2e（review/profile/rollback + 信箱批准续跑落档）在
 * 文件尾。
 */

describe('RpgProfileRepository（策略档）', () => {
  it('无版本行 = 空档（引擎全走缺省）；resolved 合缺省', () => {
    const db = openDatabase(':memory:');
    const repo = new RpgProfileRepository(db);
    expect(repo.current()).toEqual({});
    expect(repo.resolved()).toEqual(DEFAULT_ROUTING_PROFILE);
    db.close();
  });

  it('commit append-only + is_current 唯一交班；rollbackTo 换标记不移除历史', () => {
    const db = openDatabase(':memory:');
    const repo = new RpgProfileRepository(db);
    const v1 = repo.commit({ goalStallLimit: 5 }, { note: '熔断降敏' });
    expect(v1.isCurrent).toBe(true);
    expect(repo.current()).toEqual({ goalStallLimit: 5 });
    const v2 = repo.commit({ goalStallLimit: 7 }, { note: '再调' });
    expect(repo.getById(v1.id)!.isCurrent).toBe(false);
    expect(repo.current()).toEqual({ goalStallLimit: 7 });
    const back = repo.rollbackTo(v1.id)!;
    expect(back.isCurrent).toBe(true);
    expect(repo.current()).toEqual({ goalStallLimit: 5 });
    // 历史版本留档（rollback 不删）
    expect(repo.listVersions().map((v) => v.id)).toContain(v2.id);
    // 回滚到当前版 = no-op 原样返回
    expect(repo.rollbackTo(v1.id)!.isCurrent).toBe(true);
    db.close();
  });

  it('sanitize 词表闸：界外值静默丢弃（参数词表封闭，级2 清单永不入 params）', () => {
    const db = openDatabase(':memory:');
    const repo = new RpgProfileRepository(db);
    repo.commit({
      goalStallLimit: 99,
      goalDriveCooldownMs: 5, // 界外（<1s）
      ...( { maliciousKey: 'x' } as object ),
    } as never);
    expect(repo.current()).toEqual({});
    db.close();
  });
});

describe('reviewSignalsOf（复盘信号纯函数）', () => {
  const decision = (over: Partial<RpgRoutingDecisionRow> = {}): RpgRoutingDecisionRow => ({
    id: 1,
    projectId: null,
    sessionId: null,
    action: 'downgrade',
    level: 2,
    basis: 'irreversible|value',
    input: null,
    result: 'pending',
    source: null,
    detail: null,
    overturned: 0,
    at: '2026-11-11T00:00:00Z',
    ...over,
  });
  const goal = (over: Partial<RpgGoalRow> = {}): RpgGoalRow => ({
    id: 1,
    houseId: null,
    roleId: 1,
    projectId: null,
    title: 't',
    terminal: 'x',
    budgetTurns: null,
    budgetTokens: null,
    turnsUsed: 0,
    stallStreak: 0,
    status: 'active',
    statusNote: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  });
  const current = { goalStallLimit: 3, goalDriveCooldownMs: 90_000 };

  it('降级呈批被否过半（≥2）→ downgrade-misfire 信号 + stallLimit+2 草稿', () => {
    const r = reviewSignalsOf({
      decisions: [
        decision({ action: 'downgrade', result: 'rejected' }),
        decision({ action: 'downgrade', result: 'rejected' }),
        decision({ action: 'downgrade', result: 'approved' }),
      ],
      goals: [],
      current,
    });
    expect(r.signals.map((s) => s.key)).toContain('downgrade-misfire');
    expect(r.proposal).toEqual({ params: { goalStallLimit: 5 }, reason: expect.any(String) });
  });

  it('被否不足半（1/3）不出草稿；封顶 9 不越界', () => {
    const one = reviewSignalsOf({
      decisions: [decision({ result: 'rejected' }), decision({ result: 'approved' }), decision({ result: 'approved' })],
      goals: [],
      current,
    });
    expect(one.proposal).toBeNull();
    const capped = reviewSignalsOf({
      decisions: [decision({ result: 'rejected' }), decision({ result: 'rejected' })],
      goals: [],
      current: { goalStallLimit: 9, goalDriveCooldownMs: 90_000 },
    });
    expect(capped.signals.some((s) => s.key === 'downgrade-misfire')).toBe(true);
    expect(capped.proposal).toBeNull(); // 已在顶，无峰可调——如实不出草稿
  });

  it('翻案率 ≥20% 且 ≥5 例 → 信号如实（不硬凑参数）；预算紧只报不提', () => {
    const r = reviewSignalsOf({
      decisions: [
        decision({ action: 'patrol', result: 'allowed', overturned: 1 }),
        decision({ action: 'patrol', result: 'blocked' }),
        decision({ action: 'patrol', result: 'allowed' }),
        decision({ action: 'patrol', result: 'allowed' }),
        decision({ action: 'patrol', result: 'allowed' }),
      ],
      goals: [goal({ status: 'budget_out' }), goal({ status: 'budget_out' }), goal({ status: 'budget_out' })],
      current,
    });
    expect(r.signals.map((s) => s.key)).toContain('overturn-rate');
    expect(r.signals.map((s) => s.key)).toContain('budget-tight');
    expect(r.proposal).toBeNull();
  });

  it('proposalGatedOf：在堂 pending 或 24h 内已决提案 → 闸住；过期放行', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    const base = { action: 'cross-house-write', input: '{"routingProfile":{"goalStallLimit":5}}' };
    expect(proposalGatedOf({ decisions: [{ ...base, result: 'pending', at: '2026-11-11T11:00:00Z' }], now })).toBe(true);
    expect(proposalGatedOf({ decisions: [{ ...base, result: 'approved', at: '2026-11-11T11:00:00Z' }], now })).toBe(true);
    expect(proposalGatedOf({ decisions: [{ ...base, result: 'approved', at: '2026-11-10T00:00:00Z' }], now })).toBe(false);
    expect(proposalGatedOf({ decisions: [{ ...base, result: 'rejected', at: '2026-11-09T00:00:00Z' }], now })).toBe(false);
    // input 不含 routingProfile 的跨房写不占进化闸
    expect(proposalGatedOf({ decisions: [{ action: 'cross-house-write', input: '{"x":1}', result: 'pending', at: '2026-11-11T11:00:00Z' }], now })).toBe(false);
  });
});

describe('进化闭环端点 e2e（review 生成提案 → 信箱批准续跑落档 → rollback）', () => {
  it('全链（真 server，路径级）', async () => {
    const { makeEvolutionServer } = await import('./helpers/evolution-server.js');
    const { server, port, db, cleanup } = await makeEvolutionServer();
    try {
      const call = (m: string, u: string, b?: unknown) =>
        fetch(`http://127.0.0.1:${port}${u}`, {
          method: m,
          headers: { 'content-type': 'application/json' },
          ...(b === undefined ? {} : { body: JSON.stringify(b) }),
        });
      // ① 空 review：无信号如实回
      const empty = await (await call('GET', '/rpg/routing/review')).json();
      expect(empty.signals).toEqual([]);
      expect(empty.proposal).toBeNull();
      // ② 植两拒一准的 downgrade 账 → POST review 出 pending 提案
      const routing = new RpgRoutingDecisionRepository(db);
      routing.insert({ projectId: null, sessionId: null, action: 'downgrade', level: 2, basis: 'irreversible|value', input: null, result: 'rejected', source: null, detail: null });
      routing.insert({ projectId: null, sessionId: null, action: 'downgrade', level: 2, basis: 'irreversible|value', input: null, result: 'rejected', source: null, detail: null });
      routing.insert({ projectId: null, sessionId: null, action: 'downgrade', level: 2, basis: 'irreversible|value', input: null, result: 'approved', source: null, detail: null });
      const proposed = await (await call('POST', '/rpg/routing/review')).json();
      expect(proposed.proposal.action).toBe('cross-house-write');
      expect(proposed.proposal.result).toBe('pending');
      expect(JSON.parse(proposed.proposal.input).routingProfile).toEqual({ goalStallLimit: 5 });
      // ③ 频率闸：再 POST = gated
      const again = await (await call('POST', '/rpg/routing/review')).json();
      expect(again.proposal).toBeNull();
      expect(String(again.reason)).toContain('gated');
      // ④ 信箱批准（decide）→ 批读 input 续跑落档
      const applied = await (
        await call('POST', `/rpg/routing/decisions/${proposed.proposal.id}/decide`, { approve: true })
      ).json();
      expect(applied.decision.result).toBe('approved');
      expect(applied.applied).toBe(true);
      const profile = await (await call('GET', '/rpg/routing/profile')).json();
      expect(profile.resolved.goalStallLimit).toBe(5);
      expect(profile.versions).toHaveLength(1);
      // ⑤ 上帝直改 + 回滚（rollback 也落账）
      const direct = await (
        await call('POST', '/rpg/routing/profile', { params: { goalStallLimit: 7 }, note: '手动调高' })
      ).json();
      expect(direct.current.goalStallLimit).toBe(7);
      const rolled = await (
        await call('POST', '/rpg/routing/profile/rollback', { id: profile.versions[0].id })
      ).json();
      expect(rolled.current.goalStallLimit).toBe(5);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      cleanup();
    }
  }, 30_000);
});
