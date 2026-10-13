import type { DatabaseSync } from 'node:sqlite';

/** 投递模式：inject = 非抢占注入（忙排）；headless = 强制回合（闲投）；auto = 按忙闲裁决。 */
export type MessageMode = 'inject' | 'headless' | 'auto';

/** inject 置 injected（outbox 已写入，随下一拍送达）；headless 走 running → 终态。 */
export type MessageStatus =
  | 'queued'
  | 'injected'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout';

/** 发起方：dashboard（web）/ session（会话间）/ cli（终端命令）。 */
export type MessageFromKind = 'dashboard' | 'session' | 'cli';

export interface SessionMessageInput {
  fromKind: MessageFromKind;
  fromSessionId?: string | null;
  toSessionId: string;
  text: string;
  mode: MessageMode;
  status: MessageStatus;
}

export interface SessionMessageRow {
  id: number;
  fromKind: MessageFromKind;
  fromSessionId: string | null;
  toSessionId: string;
  text: string;
  mode: MessageMode;
  status: MessageStatus;
  output: string | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  finishedAt: string | null;
}

export interface UpdateMessageStatusInput {
  status: MessageStatus;
  output?: string | null;
  error?: string | null;
  delivered?: boolean;
  finished?: boolean;
}

/** session_messages 点对点消息域（append + 状态流转），与指令池分表分域。 */
export class SessionMessageRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: SessionMessageInput): SessionMessageRow {
    const result = this.db
      .prepare(
        `INSERT INTO session_messages
           (from_kind, from_session_id, to_session_id, text, mode, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.fromKind,
        input.fromSessionId ?? null,
        input.toSessionId,
        input.text,
        input.mode,
        input.status,
        new Date().toISOString(),
      );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): SessionMessageRow | undefined {
    const row = this.db.prepare('SELECT * FROM session_messages WHERE id = ?').get(id);
    return row ? toMessage(row) : undefined;
  }

  updateStatus(id: number, input: UpdateMessageStatusInput): SessionMessageRow | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE session_messages
         SET status = ?, output = COALESCE(?, output), error = COALESCE(?, error),
             delivered_at = CASE WHEN ? = 1 THEN ? ELSE delivered_at END,
             finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.output ?? null,
        input.error ?? null,
        input.delivered ? 1 : 0,
        now,
        input.finished ? 1 : 0,
        now,
        id,
      );
    return this.getById(id);
  }

  /** 会话线程（双向：收到的 + 发出的），升序、限最新 limit 条。 */
  listBySession(sessionId: string, limit = 100): SessionMessageRow[] {
    const capped = Math.min(Math.max(limit, 1), 300);
    const rows = this.db
      .prepare(
        `SELECT * FROM session_messages
         WHERE to_session_id = ? OR from_session_id = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, sessionId, capped);
    return rows.map(toMessage).reverse();
  }

  /** 删会话连带清消息（双向都指向已消失会话的孤行不留）。 */
  deleteBySession(sessionId: string): number {
    return Number(
      this.db
        .prepare('DELETE FROM session_messages WHERE to_session_id = ? OR from_session_id = ?')
        .run(sessionId, sessionId).changes,
    );
  }

  /** 归档项目清空其会话的消息（收/发两端任一落在该项目即算）。 */
  deleteByProject(projectId: number): number {
    return Number(
      this.db
        .prepare(
          `DELETE FROM session_messages
           WHERE to_session_id IN (SELECT session_id FROM sessions WHERE project_id = ?)
              OR from_session_id IN (SELECT session_id FROM sessions WHERE project_id = ?)`,
        )
        .run(projectId, projectId).changes,
    );
  }
}

function toMessage(row: Record<string, unknown>): SessionMessageRow {
  return {
    id: Number(row.id),
    fromKind: String(row.from_kind) as MessageFromKind,
    fromSessionId: row.from_session_id == null ? null : String(row.from_session_id),
    toSessionId: String(row.to_session_id),
    text: String(row.text),
    mode: String(row.mode) as MessageMode,
    status: String(row.status) as MessageStatus,
    output: row.output == null ? null : String(row.output),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    deliveredAt: row.delivered_at == null ? null : String(row.delivered_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
  };
}
