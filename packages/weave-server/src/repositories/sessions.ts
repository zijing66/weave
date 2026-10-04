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
  /** 该会话的 hook 事件数（listWithCounts 查询填充；其他查询为 undefined）。 */
  eventCount?: number;
  /** 会话归属 harness = 最新一条 hook 事件的 source（listWithCounts 查询填充）。 */
  harness?: 'claude' | 'codex' | null;
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
    // 创建时间固定排序（不随活跃跳动）。
    const rows =
      projectId === undefined
        ? this.db
            .prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 200')
            .all()
        : this.db
            .prepare(
              'SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 200',
            )
            .all(projectId);
    return rows.map(toSession);
  }

  /**
   * 会话列表 + 事件计数（任务视图左栏用）：LEFT JOIN 一次查出避免 N+1。
   * 计数不过滤项目（会话可能有跨项目事件），与事件链的 sessionId-only 语义一致。
   */
  listWithCounts(projectId?: number): SessionRow[] {
    // harness = 最新事件的 source（计算字段，sessions 表零 schema 变更）。
    const base =
      'SELECT s.*, COUNT(e.id) AS event_count, ' +
      '(SELECT e2.source FROM hook_events e2 WHERE e2.session_id = s.session_id ORDER BY e2.id DESC LIMIT 1) AS harness ' +
      'FROM sessions s LEFT JOIN hook_events e ON e.session_id = s.session_id';
    const rows =
      projectId === undefined
        ? this.db
            .prepare(
              `${base} GROUP BY s.session_id ORDER BY s.created_at DESC LIMIT 200`,
            )
            .all()
        : this.db
            .prepare(
              `${base} WHERE s.project_id = ? GROUP BY s.session_id ORDER BY s.created_at DESC LIMIT 200`,
            )
            .all(projectId);
    return rows.map((row) => {
      const raw = (row as { harness?: unknown }).harness;
      return {
        ...toSession(row),
        eventCount: Number((row as { event_count: number }).event_count ?? 0),
        harness: raw === 'claude' || raw === 'codex' ? raw : null,
      };
    });
  }

  /**
   * dashboard 改名：挂 pending（生效延迟一轮/一次 resume）。
   * 幂等短路：title 与当前生效名相同 → 不进待生效态（已有 pending 视为撤销，一并清掉）；
   * 与当前 pending 相同 → 维持 pending 原样返回。只有名称实际变化才写 pending。
   */
  setPendingTitle(sessionId: string, title: string): SessionRow | undefined {
    const row = this.getBySessionId(sessionId);
    if (!row) return undefined;
    if (row.title === title) {
      if (row.pendingTitle != null) {
        this.db.prepare('UPDATE sessions SET pending_title = NULL WHERE session_id = ?').run(sessionId);
      }
      return this.getBySessionId(sessionId);
    }
    this.db
      .prepare('UPDATE sessions SET pending_title = ? WHERE session_id = ?')
      .run(title, sessionId);
    return this.getBySessionId(sessionId);
  }

  /**
   * hook 上报的 session_title diff（兜底自纠通道）：
   * - 确认主通道 = 交付落定（confirmPendingTitle）：sessionTitle 随 hook 响应下发即视为生效。
   * - reported diff 分支保留作兜底——会话未真正应用时，下一次上报的旧标题经 diff 通道把
   *   title 改回（自纠）；pending 存在时忽略外部值（pending 更晚创建）。
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

  /** 交付确认：sessionTitle 已随本次 hook 响应下发——pending 落定为已生效标题。 */
  confirmPendingTitle(sessionId: string, title: string): boolean {
    const res = this.db
      .prepare(
        'UPDATE sessions SET title = ?, pending_title = NULL WHERE session_id = ? AND pending_title = ?',
      )
      .run(title, sessionId, title);
    return res.changes > 0;
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
