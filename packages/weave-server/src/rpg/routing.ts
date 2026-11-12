import type { DatabaseSync } from 'node:sqlite';

/**
 * 决策分级路由（G6，G线设计 §六）：任何角色/分身动作先问「归谁裁」——
 * 级0 零智能直行（规则/配置直接定：拓扑序、冷却、机械重放——不在词表 = 级0，
 * 不落账）；级1 有判断但可逆便宜（决策模型 → fork 回落，ConditionJudge 既有
 * 瀑布）；级2 不可逆/跨边界/价值敏感（呈上帝，八条清单封闭）；级3 机制熔断
 * （不问任何人，罩一切动作）。判据词表唯一权威在本文件，扩张 = 加词表行，
 * 调用方不自判（宁可查表也不散写 if-action）。
 */

/** 结果词表：级2 生命周期 pending→approved/rejected；级1 AI 放行/拦下；级3 熔断。 */
export type RpgRoutingResult = 'pending' | 'approved' | 'rejected' | 'allowed' | 'blocked' | 'tripped';

/** 谁裁的（ConditionDecision.source 同形 + god —— Mechanism 不算判断者，NULL）。 */
export type RpgRoutingSource = 'decision-model' | 'fork' | 'god';

/** 词表条目：动作 → 路由级与判据码（复盘可读的证据）。 */
export interface RpgRoutedAction {
  /** 1 = AI 自主判断（可逆便宜）；2 = 呈上帝（不可逆/跨边界/价值敏感）。 */
  level: 1 | 2;
  /** 路由判据码（irreversible | boundary | value | reversible），| 连接。 */
  basis: string;
}

/**
 * 裁决路由词表（G6 唯一权威）。级2 八条 = 用户必须确认的全部（2026-11-06 用户
 * 裁决定版）；级1 首批三枚 = 协调者日常判断（巡房/派活/催进度——分身 MPU 批2
 * 点亮）。级0 动作（机械重放/品阶评定/凡品自销/悬空并回等）是确定性规则，
 * 恒直行、不进词表。
 */
export const RPG_ROUTED_ACTIONS: Readonly<Record<string, RpgRoutedAction>> = {
  // ---- 级2 八条（呈上帝；执行权恒等用户）----
  'crop-promote': { level: 2, basis: 'irreversible|value' }, // 晋升三档（核心仓/内建仓库/全局）
  'goal-change': { level: 2, basis: 'irreversible|value' }, // 目标变更与 goal 撤销
  'budget-renew': { level: 2, basis: 'value' }, // 预算续期
  downgrade: { level: 2, basis: 'irreversible|value' }, // 降级裁决
  'cross-house-write': { level: 2, basis: 'boundary' }, // 跨 house 写与全局配置改动
  'role-freeze': { level: 2, basis: 'irreversible' }, // 删除或冻结角色及持久记忆
  'apex-review': { level: 2, basis: 'value' }, // 天品验收
  alliance: { level: 2, basis: 'boundary' }, // 跨机联盟动作
  // ---- 级1 三枚（协调者日常调度：可逆便宜，AI 自主）----
  patrol: { level: 1, basis: 'reversible' }, // 巡房督导（判离目标远近）
  dispatch: { level: 1, basis: 'reversible' }, // 派活（判任务该不该给某角色）
  nudge: { level: 1, basis: 'reversible' }, // 催进度（判是否需要提醒）
};

/** 路由级四级：0 = 零智能直行；3 = 机制熔断（罩一切）。 */
export type RpgRouteLevel = 0 | 1 | 2 | 3;

/** 路由纯函数：答「这个动作归谁裁」。tripped（熔断触发）优先罩顶——级3 不问任何人。 */
export function routeRpgAction(action: string, ctx?: { tripped?: boolean }): { level: RpgRouteLevel; basis: string } {
  if (ctx?.tripped) return { level: 3, basis: 'mechanism' };
  return RPG_ROUTED_ACTIONS[action] ?? { level: 0, basis: 'rule' };
}

export interface RpgRoutingDecisionRow {
  id: number;
  projectId: number | null;
  sessionId: string | null;
  action: string;
  level: number;
  basis: string;
  input: string | null;
  result: RpgRoutingResult;
  source: RpgRoutingSource | null;
  detail: string | null;
  overturned: number;
  at: string;
}

function toRow(raw: Record<string, unknown> | undefined): RpgRoutingDecisionRow | null {
  if (!raw) return null;
  return {
    id: Number(raw.id),
    projectId: raw.project_id == null ? null : Number(raw.project_id),
    sessionId: raw.session_id == null ? null : String(raw.session_id),
    action: String(raw.action),
    level: Number(raw.level),
    basis: String(raw.basis),
    input: raw.input == null ? null : String(raw.input),
    result: String(raw.result) as RpgRoutingResult,
    source: raw.source == null ? null : String(raw.source) as RpgRoutingSource,
    detail: raw.detail == null ? null : String(raw.detail),
    overturned: Number(raw.overturned ?? 0),
    at: String(raw.at),
  };
}

export class RpgRoutingDecisionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(row: Omit<RpgRoutingDecisionRow, 'id' | 'overturned' | 'at'>): RpgRoutingDecisionRow {
    this.db
      .prepare(
        `INSERT INTO rpg_routing_decisions
           (project_id, session_id, action, level, basis, input, result, source, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.projectId,
        row.sessionId,
        row.action,
        row.level,
        row.basis,
        row.input,
        row.result,
        row.source,
        row.detail,
        new Date().toISOString(),
      );
    return this.get(Number((this.db.prepare('SELECT last_insert_rowid() AS v').get() as { v: number | bigint }).v))!;
  }

  get(id: number): RpgRoutingDecisionRow | null {
    return toRow(this.db.prepare('SELECT * FROM rpg_routing_decisions WHERE id = ?').get(id) as Record<string, unknown> | undefined);
  }

  /** 决策轨迹（id 降序）；projectId 省略 = 全局（信箱视角）。 */
  list(filter?: { projectId?: number; limit?: number }): RpgRoutingDecisionRow[] {
    const where = filter?.projectId != null ? 'WHERE project_id = ?' : '';
    const args: number[] = filter?.projectId != null ? [filter.projectId] : [];
    return (
      this.db
        .prepare(`SELECT * FROM rpg_routing_decisions ${where} ORDER BY id DESC LIMIT ?`)
        .all(...args, filter?.limit ?? 100) as Array<Record<string, unknown>>
    ).map((r) => toRow(r)!);
  }

  listPending(projectId?: number): RpgRoutingDecisionRow[] {
    return this.list({ projectId, limit: 500 }).filter((r) => r.result === 'pending');
  }

  /** 上帝裁决：pending → approved/rejected。非 pending 恒拒改（裁决是一次性事实）。 */
  decide(id: number, approve: boolean): RpgRoutingDecisionRow | null {
    const row = this.get(id);
    if (!row || row.result !== 'pending') return null;
    this.db
      .prepare('UPDATE rpg_routing_decisions SET result = ?, source = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', 'god', id);
    return this.get(id);
  }

  /** 翻案位：上帝推翻已生效裁决（复盘翻案率信号；行不删、result 不改写）。 */
  overturn(id: number): boolean {
    const row = this.get(id);
    if (!row || row.overturned) return false;
    return this.db.prepare('UPDATE rpg_routing_decisions SET overturned = 1 WHERE id = ?').run(id).changes > 0;
  }

  /** 会话生命周期级联：session_id 命中的行随会话清（信箱不留僵尸待批）。 */
  deleteBySession(sessionId: string): number {
    return Number(this.db.prepare('DELETE FROM rpg_routing_decisions WHERE session_id = ?').run(sessionId).changes);
  }

  /** 复盘扫描面（进化闭环的数据源）：按 result 计数 + 翻案数。 */
  stats(projectId?: number): {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    allowed: number;
    blocked: number;
    tripped: number;
    overturned: number;
  } {
    const where = projectId != null ? 'WHERE project_id = ?' : '';
    const args: number[] = projectId != null ? [projectId] : [];
    const rows = this.db
      .prepare(`SELECT result, COUNT(*) AS n, SUM(overturned) AS o FROM rpg_routing_decisions ${where} GROUP BY result`)
      .all(...args) as Array<{ result: string; n: number; o: number | null }>;
    const out = { total: 0, pending: 0, approved: 0, rejected: 0, allowed: 0, blocked: 0, tripped: 0, overturned: 0 };
    for (const r of rows) {
      out.total += r.n;
      if (r.result in out) (out as unknown as Record<string, number>)[r.result] = r.n;
      out.overturned += r.o ?? 0;
    }
    return out;
  }
}
