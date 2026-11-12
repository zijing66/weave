import type { DatabaseSync } from 'node:sqlite';

/**
 * goal 域仓储（G6 批4a，G线设计 §四）：rpg_goals 表的唯一读写面。goal = 角色朝
 * 目标怎么活，长期驻留直到达成/预算尽/撤销；本批只落事实源（表 + 终态闸 + CRUD），
 * 驱动循环（三岔口/自主推进边）与预算消耗统计是后续执行层。
 *
 * 终态闸（§二 修订⑤）= 无明确可终止条件的 goal 不立项：`terminal` 非空才准进
 * 表——闸在 insert 前置（`assertGoalTerminal`）+ 路由入口（POST 体校验）双设。
 */

export const GOAL_STATUSES = ['active', 'paused', 'achieved', 'abandoned', 'budget_out'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface RpgGoalRow {
  id: number;
  houseId: number | null;
  roleId: number;
  projectId: number | null;
  title: string;
  terminal: string;
  budgetTurns: number | null;
  budgetTokens: number | null;
  turnsUsed: number;
  stallStreak: number;
  status: GoalStatus;
  statusNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 终态闸：可终止条件必须非空可读（trim 后仍有字）。 */
export function assertGoalTerminal(terminal: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof terminal !== 'string' || terminal.trim().length === 0) {
    return { ok: false, error: 'goal requires an explicit terminal condition (可终止条件不明确不立项)' };
  }
  return { ok: true };
}

function toRow(row: Record<string, unknown>): RpgGoalRow {
  const status = GOAL_STATUSES.includes(row.status as GoalStatus) ? (row.status as GoalStatus) : 'active';
  return {
    id: Number(row.id),
    houseId: row.house_id == null ? null : Number(row.house_id),
    roleId: Number(row.role_id),
    projectId: row.project_id == null ? null : Number(row.project_id),
    title: String(row.title),
    terminal: String(row.terminal),
    budgetTurns: row.budget_turns == null ? null : Number(row.budget_turns),
    budgetTokens: row.budget_tokens == null ? null : Number(row.budget_tokens),
    turnsUsed: Number(row.turns_used ?? 0),
    stallStreak: Number(row.stall_streak ?? 0),
    status,
    statusNote: row.status_note == null ? null : String(row.status_note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class RpgGoalRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: {
    roleId: number;
    title: string;
    terminal: string;
    houseId?: number | null;
    projectId?: number | null;
    budgetTurns?: number | null;
    budgetTokens?: number | null;
  }): RpgGoalRow {
    const gate = assertGoalTerminal(input.terminal);
    if (!gate.ok) throw new Error(gate.error);
    const at = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO rpg_goals (house_id, role_id, project_id, title, terminal, budget_turns, budget_tokens, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        input.houseId ?? null,
        input.roleId,
        input.projectId ?? null,
        input.title,
        input.terminal.trim(),
        input.budgetTurns ?? null,
        input.budgetTokens ?? null,
        at,
        at,
      );
    return this.getById(Number(res.lastInsertRowid))!;
  }

  getById(id: number): RpgGoalRow | undefined {
    const row = this.db.prepare('SELECT * FROM rpg_goals WHERE id = ?').get(id);
    return row ? toRow(row as Record<string, unknown>) : undefined;
  }

  list(filter: { houseId?: number; roleId?: number; projectId?: number; status?: GoalStatus } = {}, limit = 200): RpgGoalRow[] {
    const conds: string[] = [];
    const params: (number | string)[] = [];
    if (filter.houseId != null) {
      conds.push('house_id = ?');
      params.push(filter.houseId);
    }
    if (filter.roleId != null) {
      conds.push('role_id = ?');
      params.push(filter.roleId);
    }
    if (filter.projectId != null) {
      conds.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.status != null) {
      conds.push('status = ?');
      params.push(filter.status);
    }
    const sql = `SELECT * FROM rpg_goals${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, limit) as Array<Record<string, unknown>>).map(toRow);
  }

  /** 状态落定（达成/撤销/预算尽/暂停），note 记终态如何命中/谁裁的。 */
  updateStatus(id: number, status: GoalStatus, note?: string): RpgGoalRow | undefined {
    const goal = this.getById(id);
    if (!goal) return undefined;
    this.db
      .prepare('UPDATE rpg_goals SET status = ?, status_note = ?, updated_at = ? WHERE id = ?')
      .run(status, note ?? goal.statusNote, new Date().toISOString(), id);
    return this.getById(id);
  }

  /**
   * 回合落账（批4b 驱动循环）：turns_used +1；`progressed`（拍内发生过工具事件）
   * 重置 stall_streak，否则 +1。返回落账后的行（预算闸/无进展熔断的判据由此判）。
   */
  noteTurn(id: number, progressed: boolean): RpgGoalRow | undefined {
    const goal = this.getById(id);
    if (!goal) return undefined;
    this.db
      .prepare('UPDATE rpg_goals SET turns_used = ?, stall_streak = ?, updated_at = ? WHERE id = ?')
      .run(
        goal.turnsUsed + 1,
        progressed ? 0 : goal.stallStreak + 1,
        new Date().toISOString(),
        id,
      );
    return this.getById(id);
  }

  /** 目标变更（终态闸恒过——变更后的 terminal 同样必须明确）。 */
  patch(
    id: number,
    patch: { title?: string; terminal?: string; budgetTurns?: number | null; budgetTokens?: number | null },
  ): RpgGoalRow | undefined {
    const goal = this.getById(id);
    if (!goal) return undefined;
    if (patch.terminal !== undefined) {
      const gate = assertGoalTerminal(patch.terminal);
      if (!gate.ok) throw new Error(gate.error);
    }
    this.db
      .prepare(
        'UPDATE rpg_goals SET title = ?, terminal = ?, budget_turns = ?, budget_tokens = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        patch.title ?? goal.title,
        patch.terminal !== undefined ? patch.terminal.trim() : goal.terminal,
        patch.budgetTurns !== undefined ? patch.budgetTurns : goal.budgetTurns,
        patch.budgetTokens !== undefined ? patch.budgetTokens : goal.budgetTokens,
        new Date().toISOString(),
        id,
      );
    return this.getById(id);
  }
}
