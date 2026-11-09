import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/db.js';
import {
  RPG_PROGRESS_TUNING,
  ACHIEVEMENT_DEFS,
  achievementsOf,
  effectiveTurnCount,
  firstCultivationCount,
  hexBonusOf,
  hexagonFinalOf,
  levelOf,
  modelTierOf,
  questXpOf,
  realmOf,
  winStreakOf,
  xpBreakdownOf,
  xpToNextLevel,
  weaponFlagsOf,
  type AchievementMaterial,
} from '../progress.js';
import {
  deriveRoleProgress,
  growthBoardOf,
  RpgAchievementRepository,
  RpgXpRepository,
} from '../progress-store.js';
import { RpgGrowthRepository, RpgRoleRepository } from '../roles.js';
import { ProjectRepository } from '../../repositories/projects.js';

const seedProject = (db: ReturnType<typeof openDatabase>, projectId: number): void => {
  new ProjectRepository(db).register({ path: `/tmp/rpg-prog-${projectId}`, name: `p${projectId}`, token: `t${projectId}`, source: 'init' });
};

const ev = (eventType: string, sessionId = 's1', raw: Record<string, unknown> = {}): {
  eventType: string;
  sessionId: string | null;
  payload: string;
  projectId: number;
} => ({ eventType, sessionId, payload: JSON.stringify({ ...raw, raw }), projectId: 1 });

describe('XP 公式（阈值 100×level²）', () => {
  it('levelOf：0 XP = 0 级；阈值跨档', () => {
    expect(levelOf(0)).toBe(0);
    expect(levelOf(99)).toBe(0);
    expect(levelOf(100)).toBe(1);
    expect(levelOf(399)).toBe(1);
    expect(levelOf(400)).toBe(2);
    expect(levelOf(900)).toBe(3);
    expect(levelOf(10_000)).toBe(10); // 100×10²=10000
  });

  it('xpToNextLevel：下一档与差额', () => {
    expect(xpToNextLevel(0)).toEqual({ level: 0, nextAt: 100, remaining: 100 });
    expect(xpToNextLevel(100)).toEqual({ level: 1, nextAt: 400, remaining: 300 });
  });

  it('realmOf：境界名表按区间右闭', () => {
    expect(realmOf(1)).toBe('初入山门');
    expect(realmOf(2)).toBe('初入山门');
    expect(realmOf(3)).toBe('淬体');
    expect(realmOf(8)).toBe('筑基');
    expect(realmOf(31)).toBe('登峰');
    expect(realmOf(999)).toBe('登峰');
  });

  it('questXpOf：只认 done，难度乘算、缺省下限 1', () => {
    const runs = [
      { projectId: 1, status: 'done', difficulty: 3 },
      { projectId: 1, status: 'failed', difficulty: 9 },
      { projectId: 1, status: 'running', difficulty: 5 },
      { projectId: 1, status: 'done', difficulty: 0 },
    ];
    expect(questXpOf(runs)).toBe(RPG_PROGRESS_TUNING.xpPerQuest * 3 + RPG_PROGRESS_TUNING.xpPerQuest * 1);
  });

  it('effectiveTurnCount：收尾族计数、无 sessionId 不计、open 不计', () => {
    const events = [
      ev('UserPromptSubmit'),
      ev('Stop'),
      ev('Stop'),
      ev('StopFailure', 's2'),
      ev('TurnAborted', 's2'),
      ev('PostToolUse'),
      ev('SessionStart'),
    ];
    expect(effectiveTurnCount(events)).toBe(4);
  });

  it('firstCultivationCount：按 skill 去重', () => {
    const growth = [
      { verb: 'cultivate', target: 'a' },
      { verb: 'cultivate', target: 'a' },
      { verb: 'cultivate', target: 'b' },
      { verb: 'expedition', target: 'x' },
    ];
    expect(firstCultivationCount(growth)).toBe(2);
  });

  it('xpBreakdownOf：三项汇总 + 协作留位恒 0', () => {
    const b = xpBreakdownOf({
      runs: [{ projectId: 1, status: 'done', difficulty: 2 }],
      events: [ev('Stop'), ev('Stop')],
      growth: [{ verb: 'cultivate', target: 'a' }],
    });
    expect(b.quest).toBe(200);
    expect(b.turns).toBe(4);
    expect(b.cultivation).toBe(10);
    expect(b.collaboration).toBe(0);
  });
});

describe('成就判定（13 条词表）', () => {
  const base: AchievementMaterial = {
    questsDone: 0,
    winStreak: 0,
    turns: 0,
    cultivations: 0,
    activeAvatars: 0,
    fullManaCast: false,
    weaponSeen: false,
    opusDone: false,
    sonnetDone: false,
    haikuDone: false,
    reviews: 0,
    allArchived: false,
    iterationsDone: 0,
  };

  it('词表 13 条齐全、键唯一', () => {
    expect(ACHIEVEMENT_DEFS).toHaveLength(13);
    expect(new Set(ACHIEVEMENT_DEFS.map((d) => d.key)).size).toBe(13);
  });

  it('触达边界：计数刚好达标即解锁', () => {
    expect(achievementsOf({ ...base, questsDone: 1 })).toContain('firstKill');
    expect(achievementsOf({ ...base, turns: 100 })).toContain('hundredTurns');
    expect(achievementsOf({ ...base, turns: 99 })).not.toContain('hundredTurns');
    expect(achievementsOf({ ...base, winStreak: 5 })).toContain('winStreak');
    expect(achievementsOf({ ...base, winStreak: 4 })).not.toContain('winStreak');
    expect(achievementsOf({ ...base, activeAvatars: 7 })).toContain('sevenArmy');
    expect(achievementsOf({ ...base, reviews: 10 })).toContain('reviewMaster');
    expect(achievementsOf({ ...base, iterationsDone: 10 })).toContain('iterationCraft');
  });

  it('零素材 = 零成就', () => {
    expect(achievementsOf(base)).toEqual([]);
  });

  it('winStreakOf：failed 清零、cancelled/interrupted 不断链', () => {
    expect(winStreakOf([
      { id: 1, status: 'done' },
      { id: 2, status: 'cancelled' },
      { id: 3, status: 'done' },
      { id: 4, status: 'failed' },
      { id: 5, status: 'done' },
    ])).toBe(1);
    expect(winStreakOf([{ id: 1, status: 'done' }, { id: 2, status: 'done' }])).toBe(2);
  });

  it('weaponFlagsOf：品阶档归档（网关前缀容忍）', () => {
    expect(modelTierOf('claude-opus-4-6')).toBe('opus');
    expect(modelTierOf('gw/sonnet-x')).toBe('sonnet');
    expect(modelTierOf('Haiku.4')).toBe('haiku');
    expect(modelTierOf('mystery-model')).toBeNull();
    const flags = weaponFlagsOf(['claude-opus-4-6', 'gw/sonnet-x']);
    expect(flags.weaponSeen).toBe(true);
    expect(flags.opusDone).toBe(true);
    expect(flags.sonnetDone).toBe(true);
    expect(flags.haikuDone).toBe(false);
  });
});

describe('六维实战修正', () => {
  it('hexBonusOf：零素材 = 全 0 修正', () => {
    const b = hexBonusOf({ turns: 0, closeOk: 0, closeTotal: 0, avgTurnSeconds: null, changeLines: 0, decisions: 0, toolTurns: 0 });
    expect(Object.values(b).every((v) => v === 0)).toBe(true);
  });

  it('回合成功率→运气、吞吐→速度', () => {
    const b = hexBonusOf({ turns: 10, closeOk: 9, closeTotal: 10, avgTurnSeconds: null, changeLines: 0, decisions: 0, toolTurns: 0 });
    expect(b.运气).toBeCloseTo(0.9 * RPG_PROGRESS_TUNING.hexWeights.运气, 2);
    expect(b.速度).toBeCloseTo(10 * RPG_PROGRESS_TUNING.hexWeights.速度, 2);
  });

  it('响应时长→敏捷：10 分钟以上不加分', () => {
    const fast = hexBonusOf({ turns: 0, closeOk: 0, closeTotal: 0, avgTurnSeconds: 30, changeLines: 0, decisions: 0, toolTurns: 0 });
    const slow = hexBonusOf({ turns: 0, closeOk: 0, closeTotal: 0, avgTurnSeconds: 600, changeLines: 0, decisions: 0, toolTurns: 0 });
    expect(fast.敏捷).toBeGreaterThan(0);
    expect(slow.敏捷).toBe(0);
  });

  it('hexagonFinalOf：基线+修正封顶 hexCap', () => {
    const out = hexagonFinalOf({ 力量: 5, 智慧: 2 }, { 力量: 100, 智慧: 0.4 });
    expect(out.力量).toBe(RPG_PROGRESS_TUNING.hexCap);
    expect(out.智慧).toBe(2.4);
  });
});

describe('派生面（内存库真表）', () => {
  it('deriveRoleProgress：素材入 → XP/成就/六维修正出，落库幂等', () => {
    const db = openDatabase(':memory:');
    seedProject(db, 1);
    const roles = new RpgRoleRepository(db);
    const growth = new RpgGrowthRepository(db);
    const role = roles.create({ projectId: 1, name: '执行者', archetype: '执行' });

    // 素材：一条 done run + 两个收尾事件 + 一次修炼 + 一条模型照会（sonnet）
    db.prepare(
      `INSERT INTO orchestration_runs (orchestration_id, orchestration_name, project_id, trigger, status, deliveries, state, error, created_at, finished_at, updated_at)
       VALUES (1, '迭代打磨', 1, 'manual', 'done', 0, '{}', NULL, ?, ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    db.prepare(
      `INSERT INTO hook_events (project_id, source, event_type, session_id, payload, created_at) VALUES
        (1, 'claude', 'UserPromptSubmit', 's1', ?, ?),
        (1, 'claude', 'PostToolUse', 's1', ?, ?),
        (1, 'claude', 'Stop', 's1', ?, ?)`,
    ).run(
      JSON.stringify({ raw: {} }), new Date().toISOString(),
      JSON.stringify({ toolName: 'Write', toolInput: { content: 'x'.repeat(500) }, raw: {} }), new Date().toISOString(),
      JSON.stringify({ raw: { model: 'claude-sonnet-4-5' } }), new Date().toISOString(),
    );
    growth.insert({ roleId: role.id, verb: 'cultivate', target: 'sword-basic' });

    const deps = { db, growth, achievements: new RpgAchievementRepository(db), xp: new RpgXpRepository(db) };
    const p1 = deriveRoleProgress(deps, role);
    expect(p1.xp.level).toBe(2); // 412 XP 过 L2 阈（400）
    expect(p1.xp.total).toBe(
      RPG_PROGRESS_TUNING.xpPerQuest * 4 /* 迭代粗档 */ + 2 /* 一回合 */ + 10 /* 首修 */,
    );
    const keys = p1.achievements.filter((a) => a.at != null).map((a) => a.key);
    expect(keys).toContain('firstKill');
    expect(keys).toContain('firstCultivation');
    expect(keys).toContain('fineForge'); // sonnet 完成过回合
    expect(keys).not.toContain('hundredTurns');
    // 修正落了盘：运气/速度/内力/力量 > 0
    expect(p1.hexagon.dims.速度).toBeGreaterThan(5);
    // 幂等：重派不重复记成就、XP 快照追加
    const before = db.prepare('SELECT COUNT(*) c FROM rpg_achievements').get() as { c: number };
    deriveRoleProgress(deps, role);
    const after = db.prepare('SELECT COUNT(*) c FROM rpg_achievements').get() as { c: number };
    expect(after.c).toBe(before.c);
    expect((db.prepare('SELECT COUNT(*) c FROM rpg_xp').get() as { c: number }).c).toBe(2);
  });

  it('growthBoardOf：按 XP 降序、零素材角色 level 0 入榜', () => {
    const db = openDatabase(':memory:');
    seedProject(db, 1);
    seedProject(db, 2);
    const roles = new RpgRoleRepository(db);
    const a = roles.create({ projectId: 1, name: '甲', archetype: '执行' });
    const b = roles.create({ projectId: 2, name: '乙', archetype: '适配' });
    const deps = { db, growth: new RpgGrowthRepository(db) };
    const board = growthBoardOf(deps, [a, b]);
    expect(board).toHaveLength(2);
    for (const row of board) expect(row.level).toBe(0);
  });
});
