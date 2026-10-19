import type { DatabaseSync } from 'node:sqlite';

/** pending = 已打进会话、等回答；answered = 认领到回答；timeout = 超窗没等到。 */
export type SideQuestionStatus = 'pending' | 'answered' | 'timeout';

export interface SideQuestionRow {
  id: number;
  sessionId: string;
  projectId: number | null;
  question: string;
  answer: string | null;
  /** 认领到的那条采集事件（SubagentStop）；事件清掉后只留 answer 原文。 */
  answerEventId: number | null;
  status: SideQuestionStatus;
  askedAt: string;
  answeredAt: string | null;
}

/**
 * 旁路会话域（claude = `/btw`）：宿主侧问不留任何痕迹——问题只有 weave 自己
 * 发出去时才知道，回答只能从采集事件认领。故这是**记录系统**而不是递送管道：
 * 消息域「不落库」的规矩在这里不适用，不记就永远没有。
 */
export class SideQuestionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: { sessionId: string; projectId: number | null; question: string }): SideQuestionRow {
    const result = this.db
      .prepare(
        `INSERT INTO side_questions (session_id, project_id, question, status, asked_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(input.sessionId, input.projectId, input.question, new Date().toISOString());
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): SideQuestionRow | undefined {
    const row = this.db.prepare('SELECT * FROM side_questions WHERE id = ?').get(id);
    return row ? toRow(row) : undefined;
  }

  /**
   * 认领一条回答：该会话**最早一条**仍未落定、且提问时刻不早于 `since` 的行。
   * 条件更新（`status = 'pending'`）天然幂等，并发只赢一次；返回 null = 没有
   * 待认领的行（人工在宿主面板里发起的侧问、或回答来得太晚）。
   */
  claim(sessionId: string, answer: string, eventId: number, since: string): SideQuestionRow | null {
    const target = this.db
      .prepare(
        `SELECT id FROM side_questions
         WHERE session_id = ? AND status = 'pending' AND asked_at >= ?
         ORDER BY id LIMIT 1`,
      )
      .get(sessionId, since) as { id: number } | undefined;
    if (!target) return null;
    const changes = Number(
      this.db
        .prepare(
          `UPDATE side_questions SET answer = ?, answer_event_id = ?, status = 'answered', answered_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(answer, eventId, new Date().toISOString(), target.id).changes,
    );
    return changes === 1 ? (this.getById(target.id) ?? null) : null;
  }

  /**
   * 待答超窗落定（时间窗过了宿主不会再作答：面板可能被 Esc 关掉、主回合可能
   * 已经收尾）。惰性执行——在列表读取前跑一次，不另起定时器。
   */
  expirePending(before: string): number {
    return Number(
      this.db
        .prepare(
          `UPDATE side_questions SET status = 'timeout'
           WHERE status = 'pending' AND asked_at < ?`,
        )
        .run(before).changes,
    );
  }

  /** 游标向前翻页（`beforeId` 缺省 = 最新一页），倒序。 */
  list(sessionId: string, opts: { beforeId?: number; limit: number }): SideQuestionRow[] {
    const { beforeId, limit } = opts;
    const rows = beforeId
      ? this.db
          .prepare('SELECT * FROM side_questions WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
          .all(sessionId, beforeId, limit)
      : this.db
          .prepare('SELECT * FROM side_questions WHERE session_id = ? ORDER BY id DESC LIMIT ?')
          .all(sessionId, limit);
    return rows.map(toRow);
  }

  /** 删会话级联（与 events / 队列行同口径，不计数）。 */
  deleteBySession(sessionId: string): number {
    return Number(this.db.prepare('DELETE FROM side_questions WHERE session_id = ?').run(sessionId).changes);
  }
}

function toRow(row: Record<string, unknown>): SideQuestionRow {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    projectId: row.project_id == null ? null : Number(row.project_id),
    question: String(row.question),
    answer: row.answer == null ? null : String(row.answer),
    answerEventId: row.answer_event_id == null ? null : Number(row.answer_event_id),
    status: String(row.status) as SideQuestionStatus,
    askedAt: String(row.asked_at),
    answeredAt: row.answered_at == null ? null : String(row.answered_at),
  };
}
