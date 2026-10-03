import type { DatabaseSync } from 'node:sqlite';
import type { Harness } from '@weave/core';

export interface HookEventInput {
  projectId: number;
  source: Harness;
  eventType: string;
  sessionId?: string;
  /** Serialized JSON payload captured from the agent hook. */
  payload: string;
}

export interface HookEventRow {
  id: number;
  projectId: number;
  source: string;
  eventType: string;
  sessionId: string | null;
  payload: string;
  createdAt: string;
}

export class HookEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Append-only insert. Returns the new row id. */
  insert(input: HookEventInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO hook_events (project_id, source, event_type, session_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.source,
        input.eventType,
        input.sessionId ?? null,
        input.payload,
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  listByProject(projectId: number, limit = 100): HookEventRow[] {
    return this.db
      .prepare(
        'SELECT * FROM hook_events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(projectId, limit)
      .map((row) => toHookEvent(row));
  }

  /** 按会话查事件（时间升序——任务视图事件链保序）。 */
  listBySession(sessionId: string, limit = 300): HookEventRow[] {
    return this.db
      .prepare('SELECT * FROM hook_events WHERE session_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(sessionId, limit)
      .map((row) => toHookEvent(row));
  }
}

function toHookEvent(row: Record<string, unknown>): HookEventRow {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    source: String(row.source),
    eventType: String(row.event_type),
    sessionId: row.session_id == null ? null : String(row.session_id),
    payload: String(row.payload),
    createdAt: String(row.created_at),
  };
}
