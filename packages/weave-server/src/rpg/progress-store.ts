/**
 * RPG-3 派生面（成长榜 / 角色进度）：素材收拢（既有库表只读）→ progress.ts 纯函数
 * → 解锁事实落 RPG 域快照（rpg_achievements / rpg_xp，幂等 upsert）。派生是读侧
 * 行为；落库语义 = 行动态记录（哪枚成就、依据什么计数、何时首次解锁），不新增
 * 业务裁决。
 *
 * 素材口径占位（RPG 稿明言调参后置）：
 * - 任务难度：orchestrations 不持久化 playbook difficulty（模板元数据随文件走）——
 *   按编排名含「boss/主线/日常/迭代」给粗档（boss 8 / 主线 6 / 迭代 4 / 日常 2），
 *   其余缺省 5。
 * - 批阅战报 / 迭代完成：按 done run 的编排名关键词近似（review|批阅 / 迭代）。
 * - 决策参与：PermissionRequest + AskUserQuestion 事件计数。
 * - 活跃化身：近 30 分钟有事件足迹的去重会话数。
 * - 协作 XP：留位（11.1#3），恒 0。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  ACHIEVEMENT_DEFS,
  achievementsOf,
  effectiveTurnCount,
  firstCultivationCount,
  hexBonusOf,
  hexagonFinalOf,
  modelTierOf,
  realmOf,
  sessionFactsMaterial,
  winStreakOf,
  xpBreakdownOf,
  xpToNextLevel,
  xpTotalOf,
  RPG_PROGRESS_TUNING,
  type AchievementKey,
  type XpBreakdown,
} from './progress.js';
import type { RpgRoleRow, RpgGrowthRepository, Hexagon } from './roles.js';
import { archetypeBaseline } from './roles.js';

// ---- 快照仓储 ----

export interface RpgAchievementRow {
  role: number;
  key: AchievementKey;
  stats: string | null;
  at: string;
}

export class RpgAchievementRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 幂等落定：只记首次解锁（已有即不动——成就不回吐）。 */
  unlock(input: { roleId: number; key: AchievementKey; stats?: string }): RpgAchievementRow {
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO rpg_achievements (role, key, stats, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(role, key) DO NOTHING`,
      )
      .run(input.roleId, input.key, input.stats ?? null, at);
    return { role: input.roleId, key: input.key, stats: input.stats ?? null, at };
  }

  listByRole(roleId: number): RpgAchievementRow[] {
    return (
      this.db
        .prepare('SELECT * FROM rpg_achievements WHERE role = ? ORDER BY at')
        .all(roleId) as Array<Record<string, unknown>>
    ).map((r) => ({
      role: Number(r.role),
      key: String(r.key) as AchievementKey,
      stats: r.stats == null ? null : String(r.stats),
      at: String(r.at),
    }));
  }
}

export interface RpgXpRow {
  role: number;
  total: number;
  breakdown: XpBreakdown;
  at: string;
}

export class RpgXpRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 每次派生重算落一行快照（历史曲线；主键 (role, at) 幂等同拍）。 */
  snapshot(roleId: number, breakdown: XpBreakdown, total: number): RpgXpRow {
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO rpg_xp (role, total, breakdown, at) VALUES (?, ?, ?, ?)`,
      )
      .run(roleId, total, JSON.stringify(breakdown), at);
    return { role: roleId, total, breakdown, at };
  }

  latest(roleId: number): RpgXpRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM rpg_xp WHERE role = ? ORDER BY at DESC LIMIT 1')
      .get(roleId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    try {
      const breakdown = JSON.parse(String(r.breakdown)) as XpBreakdown;
      return { role: Number(r.role), total: Number(r.total), breakdown, at: String(r.at) };
    } catch {
      return undefined;
    }
  }
}

// ---- 素材收拢 ----

/** 库面最小形状（路由按 deps Pick 注入；测试给 sqlite 内存库真表）。 */
export interface ProgressDeps {
  db: DatabaseSync;
  growth: Pick<RpgGrowthRepository, 'listByRole'>;
  achievements?: RpgAchievementRepository;
  xp?: RpgXpRepository;
}

interface RunLite {
  id: number;
  projectId: number;
  orchestrationName: string;
  status: string;
}

interface EventLite {
  id: number;
  projectId: number;
  eventType: string;
  sessionId: string | null;
  payload: string;
  createdAt: string;
}

function rowsOf<T>(db: DatabaseSync, sql: string, ...params: (string | number)[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** 任务难度粗档（占位：编排名关键词；playbook difficulty 未持久化，见文件头）。 */
function difficultyOfName(name: string | null | undefined): number {
  const n = (name ?? '').toLowerCase();
  if (n.includes('boss')) return 8;
  if (n.includes('主线') || n.includes('main')) return 6;
  if (n.includes('迭代') || n.includes('iter')) return 4;
  if (n.includes('日常') || n.includes('daily')) return 2;
  return RPG_PROGRESS_TUNING.defaultDifficulty;
}

/** 活跃化身窗（近 N 分钟有事件足迹的去重会话 = 活跃化身数，占位口径）。 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

/** 满内力判据走的模型/上下文素材：项目事件 → 每会话「最近照会模型 + 是否收尾过」。 */
function sessionFactsOf(events: readonly EventLite[]): Array<{ model: string | null; contextTokens: number | null; closed: boolean }> {
  const closeTypes = new Set(['Stop', 'StopFailure', 'TurnAborted']);
  const bySession = new Map<string, { model: string | null; closed: boolean }>();
  for (const e of events) {
    if (!e.sessionId) continue;
    const entry = bySession.get(e.sessionId) ?? { model: null, closed: false };
    if (closeTypes.has(e.eventType)) entry.closed = true;
    const raw = payloadRaw(e.payload);
    // 模型照会：PostModelSwitch.to_model / SessionStart.model / 收尾事件 raw.model（占位口径）
    const model =
      typeof raw?.model === 'string' ? raw.model : (typeof raw?.to_model === 'string' ? raw.to_model : null);
    if (model) entry.model = model;
    bySession.set(e.sessionId, entry);
  }
  return [...bySession.values()].map((f) => ({ ...f, contextTokens: null }));
}

function payloadRaw(payload: string): Record<string, unknown> | null {
  try {
    const raw = (JSON.parse(payload) as { raw?: unknown }).raw;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 平均开轮→收尾间隔（秒；同会话按 id 序配对，占位口径）。 */
function avgTurnSecondsOf(events: readonly EventLite[]): number | null {
  const openTypes = new Set(['UserPromptSubmit']);
  const closeTypes = new Set(['Stop', 'StopFailure', 'TurnAborted']);
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const gaps: number[] = [];
  let openAt: number | null = null;
  for (const e of ordered) {
    if (openTypes.has(e.eventType)) openAt = Date.parse(e.createdAt);
    else if (closeTypes.has(e.eventType) && openAt != null) {
      const t = Date.parse(e.createdAt);
      if (Number.isFinite(openAt) && Number.isFinite(t) && t >= openAt) gaps.push((t - openAt) / 1000);
      openAt = null;
    }
  }
  if (gaps.length === 0) return null;
  return gaps.reduce((a, b) => a + b, 0) / gaps.length;
}

/** 改动量近似：Edit/Write/MultiEdit/NotebookEdit 调用的 toolInput 字节数（capFields 裁后，占位）。 */
function changeLinesOf(events: readonly EventLite[]): number {
  let bytes = 0;
  for (const e of events) {
    const name = payloadTop(e.payload, 'toolName');
    if (name !== 'Edit' && name !== 'Write' && name !== 'MultiEdit' && name !== 'NotebookEdit') continue;
    const input = payloadTop(e.payload, 'toolInput');
    bytes += input == null ? 0 : JSON.stringify(input).length;
  }
  return bytes;
}

function payloadTop(payload: string, key: string): unknown {
  try {
    return (JSON.parse(payload) as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** 决策参与：PermissionRequest + AskUserQuestion 事件计数（占位口径）。 */
function decisionsOf(events: readonly EventLite[]): number {
  let n = 0;
  for (const e of events) {
    if (e.eventType === 'PermissionRequest') n++;
    else if (e.eventType === 'PostToolUse' && payloadTop(e.payload, 'toolName') === 'AskUserQuestion') n++;
  }
  return n;
}

/** 工具调用轮数（PostToolUse 计数）。 */
function toolTurnsOf(events: readonly EventLite[]): number {
  let n = 0;
  for (const e of events) if (e.eventType === 'PostToolUse') n++;
  return n;
}

/** 成就素材三布尔展开（weaponSeen/opus/sonnet/haiku 由 modelsDone 归档派生）。 */
function weaponFlagsSpread(modelsDone: ReadonlyArray<string | null>): {
  weaponSeen: boolean;
  opusDone: boolean;
  sonnetDone: boolean;
  haikuDone: boolean;
} {
  const tiers = new Set(modelsDone.map(modelTierOf).filter((t): t is NonNullable<typeof t> => t != null));
  return {
    weaponSeen: tiers.size > 0,
    opusDone: tiers.has('opus'),
    sonnetDone: tiers.has('sonnet'),
    haikuDone: tiers.has('haiku'),
  };
}

/** 已全部归档/离场：有会话且每条会话的最近事件都是收尾族（含 SessionEnd）。 */
function allArchivedOf(events: readonly EventLite[]): boolean {
  const bySession = new Map<string, EventLite>();
  for (const e of events) {
    if (!e.sessionId) continue;
    const prev = bySession.get(e.sessionId);
    if (!prev || e.id > prev.id) bySession.set(e.sessionId, e);
  }
  if (bySession.size === 0) return false;
  const terminal = new Set(['Stop', 'StopFailure', 'TurnAborted', 'SessionEnd']);
  for (const last of bySession.values()) if (!terminal.has(last.eventType)) return false;
  return true;
}

// ---- 派生主面 ----

export interface RoleProgress {
  xp: { total: number; breakdown: XpBreakdown; level: number; nextAt: number; remaining: number; realm: string };
  achievements: Array<{ key: AchievementKey; describe: string; at: string | null; stats: string | null }>;
  hexagon: { base: Record<string, number>; bonus: Record<string, number>; dims: Record<string, number>; reason: string };
}

/** 单角色进度派生：素材收拢 → 纯函数 → 快照落定（成就只记首次、XP 落曲线行）。 */
export function deriveRoleProgress(deps: ProgressDeps, role: RpgRoleRow): RoleProgress {
  const db = deps.db;
  const projectId = role.projectId;

  const runRows = rowsOf<RunLite>(
    db,
    'SELECT id, project_id AS projectId, orchestration_name AS orchestrationName, status FROM orchestration_runs WHERE project_id = ? ORDER BY id',
    projectId,
  );
  const eventRows = rowsOf<EventLite>(
    db,
    'SELECT id, project_id AS projectId, event_type AS eventType, session_id AS sessionId, payload, created_at AS createdAt FROM hook_events WHERE project_id = ? ORDER BY id',
    projectId,
  );
  const growthRows = deps.growth.listByRole(role.id, 10_000);

  // XP（runs 不分难度难持久化 → 名字粗档映射，见文件头）
  const breakdown = xpBreakdownOf({
    runs: runRows.map((r) => ({ projectId: r.projectId, status: r.status, difficulty: difficultyOfName(r.orchestrationName) })),
    events: eventRows,
    growth: growthRows,
  });
  const total = xpTotalOf(breakdown);
  const { level, nextAt, remaining } = xpToNextLevel(total);

  // 成就素材
  const doneRuns = runRows.filter((r) => r.status === 'done');
  const facts = sessionFactsOf(eventRows);
  const weapon = sessionFactsMaterial(facts);
  const nowMs = Date.now();
  const activeSessions = new Set(
    eventRows.filter((e) => nowMs - Date.parse(e.createdAt) <= ACTIVE_WINDOW_MS && e.sessionId).map((e) => e.sessionId!),
  );
  const reviews = doneRuns.filter((r) => /review|批阅/i.test(r.orchestrationName)).length;
  const iterationsDone = doneRuns.filter((r) => /迭代|iter/i.test(r.orchestrationName)).length;

  const material = {
    questsDone: doneRuns.length,
    winStreak: winStreakOf(runRows),
    turns: effectiveTurnCount(eventRows),
    cultivations: firstCultivationCount(growthRows),
    activeAvatars: activeSessions.size,
    reviews,
    iterationsDone,
    allArchived: allArchivedOf(eventRows),
    fullManaCast: weapon.fullManaCast,
    ...weaponFlagsSpread(weapon.modelsDone),
  };
  const unlockedNow = new Set(achievementsOf(material));

  // 六维素材
  const closeTypes = new Set(['Stop', 'StopFailure', 'TurnAborted']);
  const closeRows = eventRows.filter((e) => closeTypes.has(e.eventType));
  const closeOk = closeRows.filter((e) => e.eventType === 'Stop').length;
  const bonus = hexBonusOf({
    turns: material.turns,
    closeOk,
    closeTotal: closeRows.length,
    avgTurnSeconds: avgTurnSecondsOf(eventRows),
    changeLines: changeLinesOf(eventRows),
    decisions: decisionsOf(eventRows),
    toolTurns: toolTurnsOf(eventRows),
  });
  const base: Record<string, number> = role.hexagon ?? archetypeBaseline(role.archetype);
  const dims = hexagonFinalOf(base, bonus);

  // 落定（幂等）：成就只记首次解锁；XP 落一行曲线快照
  const ach = deps.achievements ?? new RpgAchievementRepository(db);
  const xpr = deps.xp ?? new RpgXpRepository(db);
  const existing = new Set(ach.listByRole(role.id).map((a) => a.key));
  const statsSummary = `quests=${material.questsDone} turns=${material.turns} cultivations=${material.cultivations} active=${material.activeAvatars}`;
  for (const key of ACHIEVEMENT_DEFS.map((d) => d.key)) {
    if (unlockedNow.has(key) && !existing.has(key)) ach.unlock({ roleId: role.id, key, stats: statsSummary });
  }
  xpr.snapshot(role.id, breakdown, total);

  const stored = new Map(ach.listByRole(role.id).map((a) => [a.key, a]));
  return {
    xp: { total, breakdown, level, nextAt, remaining, realm: realmOf(level) },
    achievements: ACHIEVEMENT_DEFS.map((d) => {
      const row = stored.get(d.key);
      return { key: d.key, describe: d.describe, at: row?.at ?? null, stats: row?.stats ?? null };
    }),
    hexagon: {
      base,
      bonus,
      dims,
      reason: `实战修正：回合成功率→运气、响应→敏捷、改动量→力量、决策→智慧、工具轮占比→内力、回合数→速度（占位权重，RPG-4 调参）`,
    },
  };
}

/** 成长榜一行（榜单只暴露榜单字段，不携带成就明细）。 */
export interface GrowthBoardRow {
  roleId: number;
  name: string;
  archetype: string | null;
  total: number;
  level: number;
  realm: string;
  achievements: number;
  dims: Record<string, number> | null;
}

/** 全角色成长榜（按 XP 降序；零素材角色也入榜——level 0 如实呈现）。 */
export function growthBoardOf(deps: ProgressDeps, roles: readonly RpgRoleRow[]): GrowthBoardRow[] {
  const out: GrowthBoardRow[] = [];
  for (const role of roles) {
    const p = deriveRoleProgress(deps, role);
    out.push({
      roleId: role.id,
      name: role.name,
      archetype: role.archetype,
      total: p.xp.total,
      level: p.xp.level,
      realm: p.xp.realm,
      achievements: p.achievements.filter((a) => a.at != null).length,
      dims: p.hexagon.dims as Hexagon,
    });
  }
  return out.sort((a, b) => b.total - a.total || a.roleId - b.roleId);
}
