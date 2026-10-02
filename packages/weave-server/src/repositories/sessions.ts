import type { DatabaseSync } from 'node:sqlite';

export interface SessionRow {
  sessionId: string;
  projectId: number | null;
  /** 已生效的自定义标题（hook sessionTitle / dashboard 改名落地后）。 */
  title: string | null;
  /** dashboard 改名待生效：下次 SessionStart(resume)/UserPromptSubmit 时经 hook 下发。 */
  pendingTitle: string | null;
  lastSeenAt: string;
  createdAt: string;
}

/**
 * sessions 表：daemon 自存的会话标题（不写回 Claude Code 内部文件）。
 * 双向 rename：读 = payload session_title diff；写 = pending_title 经 hook sessionTitle 输出生效。
 */
export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 事件到达时 upsert（刷新 last_seen_at，project_id 首次非空时补上）。 */
  touch(sessionId: string, projectId?: number | null): SessionRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, project_id, last_seen_at, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           project_id = COALESCE(sessions.project_id, excluded.project_id)`,
      )
      .run(sessionId, projectId ?? null, now, now);
    return this.getBySessionId(sessionId)!;
  }

  getBySessionId(sessionId: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
    return row ? toSession(row) : undefined;
  }

  list(projectId?: number): SessionRow[] {
    const rows =
      projectId === undefined
        ? this.db
            .prepare('SELECT * FROM sessions ORDER BY last_seen_at DESC LIMIT 200')
            .all()
        : this.db
            .prepare(
              'SELECT * FROM sessions WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT 200',
            )
            .all(projectId);
    return rows.map(toSession);
  }

  /** dashboard 改名：挂 pending（生效延迟一轮/一次 resume）。 */
  setPendingTitle(sessionId: string, title: string): SessionRow | undefined {
    this.db
      .prepare('UPDATE sessions SET pending_title = ? WHERE session_id = ?')
      .run(title, sessionId);
    return this.getBySessionId(sessionId);
  }

  /**
   * hook 上报的 session_title diff：
   * - 有待生效 pending 时以上报值确认 pending 已落地（外部生效了同名？）或直接采纳 pending 优先——
   *   这里策略：pending 存在时忽略外部值（pending 更晚创建），外部值仅在无 pending 时采纳。
   * - 返回是否发生了标题变化（供 bus 发 session.renamed）。
   */
  applyReportedTitle(sessionId: string, reportedTitle: string | null): boolean {
    const row = this.getBySessionId(sessionId);
    if (!row) return false;
    if (row.pendingTitle != null) {
      // pending 已被 hook 下发并生效后，reported 会带新标题——此时清 pending 并采纳。
      if (reportedTitle === row.pendingTitle) {
        this.db
          .prepare('UPDATE sessions SET title = ?, pending_title = NULL WHERE session_id = ?')
          .run(reportedTitle, sessionId);
        return row.title !== reportedTitle;
      }
      return false;
    }
    if (reportedTitle != null && reportedTitle !== row.title) {
      this.db
        .prepare('UPDATE sessions SET title = ? WHERE session_id = ?')
        .run(reportedTitle, sessionId);
      return true;
    }
    return false;
  }

  remove(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  }
}

function toSession(row: Record<string, unknown>): SessionRow {
  return {
    sessionId: String(row.session_id),
    projectId: row.project_id == null ? null : Number(row.project_id),
    title: row.title == null ? null : String(row.title),
    pendingTitle: row.pending_title == null ? null : String(row.pending_title),
    lastSeenAt: String(row.last_seen_at),
    createdAt: String(row.created_at),
  };
}
