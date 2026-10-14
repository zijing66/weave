import type { DatabaseSync } from 'node:sqlite';
import type { MessageMode } from './session-messages';

/** 序列步（steps JSON 的一格）。messageId 为步触发后回填的消息行 id。 */
export interface SequenceStep {
  to: string;
  text: string;
  mode: MessageMode;
  /** null = 本步尚未触发（或触发前落库）；重启恢复时区分等待通道用。 */
  messageId?: number;
}

export type SequenceStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface SessionSequenceRow {
  id: number;
  name: string;
  steps: SequenceStep[];
  status: SequenceStatus;
  /** 正在等待完成的步下标；全落 = steps.length。 */
  cursor: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** session_sequences 跨会话序列域（session-orchestration 批 3）：状态全在行，引擎无内存权威态。 */
export class SessionSequenceRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: { name: string; steps: SequenceStep[] }): SessionSequenceRow {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO session_sequences (name, steps, status, cursor, created_at, updated_at)
         VALUES (?, ?, 'running', 0, ?, ?)`,
      )
      .run(input.name, JSON.stringify(input.steps), now, now);
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): SessionSequenceRow | undefined {
    const row = this.db.prepare('SELECT * FROM session_sequences WHERE id = ?').get(id);
    return row ? toSequence(row) : undefined;
  }

  /** 最近的序列（画布历史 + 列表），新在前。 */
  list(limit = 50): SessionSequenceRow[] {
    return this.db
      .prepare('SELECT * FROM session_sequences ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map(toSequence);
  }

  /** 引擎扫描面：全部进行中的序列。 */
  listRunning(): SessionSequenceRow[] {
    return this.db
      .prepare(`SELECT * FROM session_sequences WHERE status = 'running' ORDER BY id`)
      .all()
      .map(toSequence);
  }

  /**
   * CAS 推进：cursor from→to 且仍 running。false = 已被并发推进或落定，
   * 调用方必须放弃后续副作用（防同批多事件重复触发下一拍）。
   */
  advanceCursor(id: number, from: number, to: number): boolean {
    return (
      Number(
        this.db
          .prepare(
            `UPDATE session_sequences SET cursor = ?, updated_at = ?
             WHERE id = ? AND status = 'running' AND cursor = ?`,
          )
          .run(to, new Date().toISOString(), id, from).changes,
      ) === 1
    );
  }

  /** 终态落定（CAS running → status）；false = 已有并发终态。 */
  finish(id: number, status: 'done' | 'failed' | 'cancelled', error: string | null = null): boolean {
    return (
      Number(
        this.db
          .prepare(
            `UPDATE session_sequences SET status = ?, error = ?, updated_at = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(status, error, new Date().toISOString(), id).changes,
      ) === 1
    );
  }

  /** 步触发后回填 messageId（步数组读改写后整体落库，单线程无竞态）。 */
  setStepMessage(id: number, stepIndex: number, messageId: number): void {
    const row = this.getById(id);
    if (!row || row.steps[stepIndex] == null) return;
    row.steps[stepIndex].messageId = messageId;
    this.db
      .prepare('UPDATE session_sequences SET steps = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(row.steps), new Date().toISOString(), id);
  }

  /** 删会话/归档连带清：任一步目标落在给定会话集内的行不留。 */
  deleteMentioning(sessionIds: ReadonlySet<string>): number {
    if (sessionIds.size === 0) return 0;
    const doomed = this.list(1000).filter((row) =>
      row.steps.some((step) => sessionIds.has(step.to)),
    );
    if (doomed.length === 0) return 0;
    const del = this.db.prepare('DELETE FROM session_sequences WHERE id = ?');
    return doomed.reduce((n, row) => n + Number(del.run(row.id).changes), 0);
  }

  /** 归档项目连带清（须在项目会话行删除前调用——靠 sessions 表圈目标集）。 */
  deleteByProject(projectId: number): number {
    const ids = new Set(
      this.db
        .prepare('SELECT session_id FROM sessions WHERE project_id = ?')
        .all(projectId)
        .map((row) => String((row as { session_id: string }).session_id)),
    );
    return this.deleteMentioning(ids);
  }
}

function toSequence(row: Record<string, unknown>): SessionSequenceRow {
  let steps: SequenceStep[] = [];
  try {
    steps = JSON.parse(String(row.steps)) as SequenceStep[];
  } catch {
    steps = [];
  }
  return {
    id: Number(row.id),
    name: String(row.name),
    steps: Array.isArray(steps) ? steps : [],
    status: String(row.status) as SessionSequenceRow['status'],
    cursor: Number(row.cursor),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
