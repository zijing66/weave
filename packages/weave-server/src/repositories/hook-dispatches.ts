import type { DatabaseSync } from 'node:sqlite';
import type { HookDispatchMode, HookDispatchStatus } from '@weavecode/core';

export interface HookDispatchInput {
  ruleId: string;
  eventId?: number | null;
  sessionId?: string | null;
  /** 待运行指令文本（指令池中的“物”）。 */
  prompt: string;
  status: HookDispatchStatus;
  mode: HookDispatchMode;
}

export interface HookDispatchRow {
  id: number;
  ruleId: string;
  eventId: number | null;
  sessionId: string | null;
  prompt: string;
  status: HookDispatchStatus;
  mode: HookDispatchMode;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface UpdateDispatchStatusInput {
  status: HookDispatchStatus;
  output?: string | null;
  error?: string | null;
  finished?: boolean;
}

/** hook_dispatches 运行态表（append + 状态流转），与 hook_events 同为只增策略。 */
export class HookDispatchRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: HookDispatchInput): HookDispatchRow {
    const result = this.db
      .prepare(
        `INSERT INTO hook_dispatches (rule_id, event_id, session_id, prompt, status, mode, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ruleId,
        input.eventId ?? null,
        input.sessionId ?? null,
        input.prompt,
        input.status,
        input.mode,
        new Date().toISOString(),
      );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): HookDispatchRow | undefined {
    const row = this.db.prepare('SELECT * FROM hook_dispatches WHERE id = ?').get(id);
    return row ? toDispatch(row) : undefined;
  }

  updateStatus(id: number, input: UpdateDispatchStatusInput): HookDispatchRow | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE hook_dispatches
         SET status = ?, output = COALESCE(?, output), error = COALESCE(?, error),
             finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.output ?? null,
        input.error ?? null,
        input.finished ? 1 : 0,
        now,
        id,
      );
    return this.getById(id);
  }

  list(
    filter: { ruleId?: string; status?: HookDispatchStatus; sessionId?: string; limit?: number } = {},
  ): HookDispatchRow[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.ruleId) {
      clauses.push('rule_id = ?');
      params.push(filter.ruleId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT * FROM hook_dispatches ${where} ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map(toDispatch);
  }

  /** 同一 rule × session 在窗口内的最近一条 auto 记录（防递归去重用）。 */
  /** 删会话时连带清指令池派发——否则留下指向已消失会话的孤行。 */
  deleteBySession(sessionId: string): number {
    return Number(
      this.db.prepare('DELETE FROM hook_dispatches WHERE session_id = ?').run(sessionId).changes,
    );
  }

  /**
   * 归档项目时清空其派发行：按项目会话与项目事件两条子查询圈定（必须先于
   * events/sessions 删除执行——子查询依赖那两张表的行还在）。
   */
  deleteByProject(projectId: number): number {
    return Number(
      this.db
        .prepare(
          `DELETE FROM hook_dispatches WHERE session_id IN (SELECT session_id FROM sessions WHERE project_id = ?)
             OR event_id IN (SELECT id FROM hook_events WHERE project_id = ?)`,
        )
        .run(projectId, projectId).changes,
    );
  }

  findRecentAuto(ruleId: string, sessionId: string, sinceIso: string): HookDispatchRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM hook_dispatches
         WHERE rule_id = ? AND session_id = ? AND mode = 'auto' AND started_at >= ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(ruleId, sessionId, sinceIso);
    return row ? toDispatch(row) : undefined;
  }
}

function toDispatch(row: Record<string, unknown>): HookDispatchRow {
  return {
    id: Number(row.id),
    ruleId: String(row.rule_id),
    eventId: row.event_id == null ? null : Number(row.event_id),
    sessionId: row.session_id == null ? null : String(row.session_id),
    prompt: String(row.prompt),
    status: String(row.status) as HookDispatchStatus,
    mode: String(row.mode) as HookDispatchMode,
    output: row.output == null ? null : String(row.output),
    error: row.error == null ? null : String(row.error),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
  };
}
