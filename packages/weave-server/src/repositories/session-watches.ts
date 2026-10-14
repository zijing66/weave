import type { DatabaseSync } from 'node:sqlite';

export interface SessionWatchRow {
  id: number;
  /** null = dashboard 订阅（fire 走 SSE/toast）；会话 id = 通知注入该会话。 */
  watcherSessionId: string | null;
  targetSessionId: string;
  /** 注入 watcher 会话的文本；null = fire 时按目标会话渲染缺省文案。 */
  notify: string | null;
  /** one-shot 落定时刻；null = pending。 */
  firedAt: string | null;
  createdAt: string;
}

/** session_watches 空闲订阅域（session-orchestration 批 2）：one-shot，fire 即失效。 */
export class SessionWatchRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: {
    watcherSessionId: string | null;
    targetSessionId: string;
    notify: string | null;
  }): SessionWatchRow {
    const result = this.db
      .prepare(
        `INSERT INTO session_watches (watcher_session_id, target_session_id, notify, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.watcherSessionId, input.targetSessionId, input.notify, new Date().toISOString());
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): SessionWatchRow | undefined {
    const row = this.db.prepare('SELECT * FROM session_watches WHERE id = ?').get(id);
    return row ? toWatch(row) : undefined;
  }

  /** 目标会话的待触发订阅（onIngest 命中 idleSignals 后逐条 fire）。 */
  listPendingByTarget(targetSessionId: string): SessionWatchRow[] {
    return this.db
      .prepare('SELECT * FROM session_watches WHERE target_session_id = ? AND fired_at IS NULL')
      .all(targetSessionId)
      .map(toWatch);
  }

  /** 全部待触发订阅（terminated 补射扫描面）。 */
  listPending(): SessionWatchRow[] {
    return this.db
      .prepare('SELECT * FROM session_watches WHERE fired_at IS NULL ORDER BY id')
      .all()
      .map(toWatch);
  }

  /**
   * one-shot 落定（CAS：fired_at 已落的行不再翻）——返回 false 即并发方已 fire，
   * 调用方必须放弃副作用（防同批 Stop/SessionEnd 双事件双投递）。
   */
  markFired(id: number): boolean {
    return (
      Number(
        this.db
          .prepare('UPDATE session_watches SET fired_at = ? WHERE id = ? AND fired_at IS NULL')
          .run(new Date().toISOString(), id).changes,
      ) === 1
    );
  }

  deleteById(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM session_watches WHERE id = ?').run(id).changes) === 1;
  }

  /** 删会话连带清：目标或订阅方任一指向已消失会话的行不留。 */
  deleteBySession(sessionId: string): number {
    return Number(
      this.db
        .prepare(
          'DELETE FROM session_watches WHERE target_session_id = ? OR watcher_session_id = ?',
        )
        .run(sessionId, sessionId).changes,
    );
  }

  /** 归档项目清空其会话的订阅（两端任一落在该项目即算）。 */
  deleteByProject(projectId: number): number {
    return Number(
      this.db
        .prepare(
          `DELETE FROM session_watches
           WHERE target_session_id IN (SELECT session_id FROM sessions WHERE project_id = ?)
              OR watcher_session_id IN (SELECT session_id FROM sessions WHERE project_id = ?)`,
        )
        .run(projectId, projectId).changes,
    );
  }
}

function toWatch(row: Record<string, unknown>): SessionWatchRow {
  return {
    id: Number(row.id),
    watcherSessionId: row.watcher_session_id == null ? null : String(row.watcher_session_id),
    targetSessionId: String(row.target_session_id),
    notify: row.notify == null ? null : String(row.notify),
    firedAt: row.fired_at == null ? null : String(row.fired_at),
    createdAt: String(row.created_at),
  };
}
