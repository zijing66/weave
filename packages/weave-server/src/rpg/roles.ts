import { randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * RPG 角色域（RPG 稿 §5.3.1 + §5.3.6）：角色 = 独立 project（角色仓库），本表
 * 只存「游戏自己的事实」（七型 / 六维基线 / 人设快照）——观察态（会话状态、模型、
 * 事件统计）一律从既有表派生，不在这里冗余。
 *
 * **角色属性是文件层的**（裁决 7）：skill / MCP = 项目目录里的 agent 自己读的
 * 文件（`.claude/skills`、`.mcp.json`），协议无关——本模块不读 ACP / 终端细节。
 */

/** 六维封闭词表（RPG 稿 §5.3.2，v1 定名）。 */
export const HEXAGON_DIMS = ['力量', '智慧', '敏捷', '速度', '内力', '运气'] as const;
export type HexagonDim = (typeof HEXAGON_DIMS)[number];
export type Hexagon = Record<HexagonDim, number>;

/** 七型 → 六维初始分布（简版占位，RPG 稿 §5.3.2；每型 18 点，RPG-3 调参）。 */
export const ARCHETYPE_BASELINES: Record<string, Hexagon> = {
  能量: { 力量: 5, 智慧: 2, 敏捷: 3, 速度: 3, 内力: 3, 运气: 2 },
  思考: { 力量: 2, 智慧: 5, 敏捷: 2, 速度: 3, 内力: 4, 运气: 2 },
  创造: { 力量: 2, 智慧: 4, 敏捷: 3, 速度: 3, 内力: 3, 运气: 3 },
  连接: { 力量: 2, 智慧: 3, 敏捷: 4, 速度: 3, 内力: 2, 运气: 4 },
  审核: { 力量: 3, 智慧: 4, 敏捷: 3, 速度: 2, 内力: 3, 运气: 3 },
  执行: { 力量: 4, 智慧: 2, 敏捷: 3, 速度: 5, 内力: 3, 运气: 1 },
  适配: { 力量: 3, 智慧: 3, 敏捷: 3, 速度: 3, 内力: 3, 运气: 3 },
};

export interface RpgRoleRow {
  id: number;
  projectId: number;
  name: string;
  archetype: string | null;
  persona: string | null;
  /** JSON 解析后的六维基线；坏 JSON = null（读侧如实回缺省）。 */
  hexagon: Hexagon | null;
  /** male | female；NULL = 旧角色（迁移前建的），读侧如实回 null、不随机洗脸。 */
  gender: 'male' | 'female' | null;
  /** 外貌种子 0..2147483647；NULL = 旧角色。 */
  appearanceSeed: number | null;
  createdAt: string;
}

export function archetypeBaseline(archetype: string | null | undefined): Hexagon {
  const base: Hexagon =
    (archetype != null ? ARCHETYPE_BASELINES[archetype] : undefined) ?? ARCHETYPE_BASELINES['适配']!;
  return { ...base };
}

/** 性别封闭词表；创建侧非法值由路由 400，仓储层只认这两枚。 */
export const ROLE_GENDERS = ['male', 'female'] as const;
export type RoleGender = (typeof ROLE_GENDERS)[number];

/** 外貌种子上限（含）：0..2147483647，创建 UI 预览与读侧回放同一枚种子。 */
export const APPEARANCE_SEED_MAX = 2147483647;

export function randomAppearanceSeed(): number {
  return randomInt(0, APPEARANCE_SEED_MAX + 1);
}

// ---- 六维派生（读侧纯函数，RPG 稿 §5.3.2：素材全派生、无本地运行时）----

/** 六维分值 = 模板基线 + Σ 修炼加成。v1 占位：每修炼 +1 主维、封顶 5（RPG-3 调参）。 */
export const SKILL_BONUS_CAP = 5;

/** 主维 = 基线里最高的那一维（并列取词表序靠前的，保持确定性）。 */
export function mainDimOf(hex: Hexagon): HexagonDim {
  let best: HexagonDim = HEXAGON_DIMS[0];
  for (const dim of HEXAGON_DIMS) if (hex[dim] > hex[best]) best = dim;
  return best;
}

export function hexagonWithSkills(baseline: Hexagon, cultivated: number): Hexagon {
  const out = { ...baseline };
  if (cultivated > 0) {
    const main = mainDimOf(baseline);
    out[main] = Math.min(SKILL_BONUS_CAP, cultivated) + out[main];
  }
  return out;
}

/**
 * 技巧维度评分（修炼的产出，RPG 稿 §5.2）：初始分 = 角色模板基线派生——
 * 主维越高初始技巧分越高；实战表现派生修正后置 RPG-3。确定性纯函数，无随机。
 */
export function skillScoreOf(archetype: string | null | undefined): { score: number; basis: string } {
  const base = archetypeBaseline(archetype);
  const main = mainDimOf(base);
  const score = Math.min(100, 55 + base[main] * 5);
  return {
    score,
    basis: `七型「${archetype ?? '自定义'}」主维「${main}」基线 ${base[main]} → 修炼初始分（实战派生修正后置 RPG-3）`,
  };
}

export class RpgRoleRepository {
  /** 库连接回指（同域仓储共用一条连接的装配缝）。 */
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(input: {
    projectId: number;
    name: string;
    archetype?: string | null;
    persona?: string | null;
    hexagon?: Hexagon | null;
    /** 缺省随机（node crypto randomInt）；upsert 未显式给时保留已有值。 */
    gender?: RoleGender | null;
    /** 整数 0..2147483647；缺省随机。upsert 未显式给时保留已有值。 */
    appearanceSeed?: number | null;
  }): RpgRoleRow {
    const hex = input.hexagon ?? archetypeBaseline(input.archetype);
    const existing = this.getByProjectId(input.projectId);
    // upsert 未显式给新参数 = 保留已有外貌（已有角色不随机洗脸）；新行才随机。
    const gender =
      input.gender !== undefined ? input.gender : (existing?.gender ?? (randomInt(0, 2) === 0 ? 'male' : 'female'));
    const seed =
      input.appearanceSeed !== undefined
        ? input.appearanceSeed
        : (existing?.appearanceSeed ?? randomAppearanceSeed());
    this.db
      .prepare(
        `INSERT INTO rpg_roles (project_id, name, archetype, persona, hexagon, gender, appearance_seed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           name = excluded.name, archetype = excluded.archetype,
           persona = excluded.persona, hexagon = excluded.hexagon,
           gender = excluded.gender, appearance_seed = excluded.appearance_seed`,
      )
      .run(
        input.projectId,
        input.name,
        input.archetype ?? null,
        input.persona ?? null,
        JSON.stringify(hex),
        gender,
        seed,
        new Date().toISOString(),
      );
    return this.getByProjectId(input.projectId)!;
  }

  getById(id: number): RpgRoleRow | undefined {
    const row = this.db.prepare('SELECT * FROM rpg_roles WHERE id = ?').get(id);
    return row ? toRole(row) : undefined;
  }

  getByProjectId(projectId: number): RpgRoleRow | undefined {
    const row = this.db.prepare('SELECT * FROM rpg_roles WHERE project_id = ?').get(projectId);
    return row ? toRole(row) : undefined;
  }

  list(): RpgRoleRow[] {
    return (this.db.prepare('SELECT * FROM rpg_roles ORDER BY id').all() as Array<Record<string, unknown>>).map(toRole);
  }

  deleteByProjectId(projectId: number): boolean {
    return (
      this.db.prepare('DELETE FROM rpg_roles WHERE project_id = ?').run(projectId).changes > 0
    );
  }
}

function toRole(row: Record<string, unknown>): RpgRoleRow {
  let hexagon: Hexagon | null = null;
  try {
    const parsed: unknown = JSON.parse(String(row.hexagon));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const filled = {} as Record<HexagonDim, number>;
      let complete = true;
      for (const dim of HEXAGON_DIMS) {
        const v = obj[dim];
        if (typeof v === 'number') filled[dim] = v;
        else complete = false;
      }
      hexagon = complete ? (filled as Hexagon) : null;
    }
  } catch {
    /* 坏 JSON = null */
  }
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    name: String(row.name),
    archetype: row.archetype == null ? null : String(row.archetype),
    persona: row.persona == null ? null : String(row.persona),
    hexagon,
    gender: row.gender === 'male' || row.gender === 'female' ? row.gender : null,
    appearanceSeed: row.appearance_seed == null ? null : Number(row.appearance_seed),
    createdAt: String(row.created_at),
  };
}

// ---- 技巧评分 + 六维快照（修炼产出；行动态只落游戏自己的事实）----

export interface RpgScoreRow {
  role: number;
  score: number;
  basis: string | null;
  at: string;
}

export class RpgScoreRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(input: { roleId: number; score: number; basis?: string }): RpgScoreRow {
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO rpg_scores (role, score, basis, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(role) DO UPDATE SET score = excluded.score, basis = excluded.basis, at = excluded.at`,
      )
      .run(input.roleId, input.score, input.basis ?? null, at);
    return { role: input.roleId, score: input.score, basis: input.basis ?? null, at };
  }

  get(roleId: number): RpgScoreRow | undefined {
    const r = this.db.prepare('SELECT * FROM rpg_scores WHERE role = ?').get(roleId) as
      | Record<string, unknown>
      | undefined;
    return r
      ? { role: Number(r.role), score: Number(r.score), basis: r.basis == null ? null : String(r.basis), at: String(r.at) }
      : undefined;
  }
}

export class RpgHexagramRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: { roleId: number; dims: Hexagon; reason?: string }): void {
    this.db
      .prepare('INSERT OR REPLACE INTO rpg_hexagram (role, dims, reason, at) VALUES (?, ?, ?, ?)')
      .run(input.roleId, JSON.stringify(input.dims), input.reason ?? null, new Date().toISOString());
  }

  latest(roleId: number): { dims: Hexagon; reason: string | null; at: string } | undefined {
    const r = this.db
      .prepare('SELECT * FROM rpg_hexagram WHERE role = ? ORDER BY at DESC LIMIT 1')
      .get(roleId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    try {
      const dims = JSON.parse(String(r.dims)) as Hexagon;
      return { dims, reason: r.reason == null ? null : String(r.reason), at: String(r.at) };
    } catch {
      return undefined;
    }
  }
}

// ---- 成长记录（行动态：动词门面写入）----

export class RpgGrowthRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: { roleId: number; verb: string; target: string; detail?: string }): void {
    this.db
      .prepare('INSERT INTO rpg_growth (role, verb, target, detail, at) VALUES (?, ?, ?, ?, ?)')
      .run(input.roleId, input.verb, input.target, input.detail ?? null, new Date().toISOString());
  }

  listByRole(roleId: number, limit = 200): Array<{
    id: number;
    roleId: number;
    verb: string;
    target: string;
    detail: string | null;
    at: string;
  }> {
    return (
      this.db
        .prepare('SELECT * FROM rpg_growth WHERE role = ? ORDER BY id DESC LIMIT ?')
        .all(roleId, limit) as Array<Record<string, unknown>>
    ).map((r) => ({
      id: Number(r.id),
      roleId: Number(r.role),
      verb: String(r.verb),
      target: String(r.target),
      detail: r.detail == null ? null : String(r.detail),
      at: String(r.at),
    }));
  }
}
