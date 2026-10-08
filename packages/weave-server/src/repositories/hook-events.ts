import type { DatabaseSync } from 'node:sqlite';
import type { Harness } from '@weave/core';
import { readDaemonSettingsSync, DEFAULT_EVENT_RETENTION_DAYS } from '../daemon/settings.js';

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
  /** 上次被动清理的 UTC 天序号（进程内标记；-1=本进程尚未清理过）。 */
  private lastPruneDay = -1;

  constructor(private readonly db: DatabaseSync) {}

  /**
   * 重置被动清理的天标记：全局设置保存保留期后调用——下一条事件写入
   * 立即按新配置清理（否则要等次日跨天才重扫）。
   */
  resetPrune(): void {
    this.lastPruneDay = -1;
  }

  /** Append-only insert. Returns the new row id. */
  insert(input: HookEventInput): number {
    this.pruneExpired();
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

  /**
   * 被动清理（无定时任务）：每个 UTC 天只在本进程的首条写入时执行一次
   * DELETE——「下一次写入新一天日志时清理过期日志」。保留期读全局设置
   * （daemon settings.json → events.retentionDays，默认 90 天）。
   * created_at 为 ISO 字符串，字典序即时间序，直接比较即可；DELETE 留下
   * 的空页由后续写入复用（不做 VACUUM，避免写路径上的大段停顿）。
   */
  private pruneExpired(): void {
    const day = Math.floor(Date.now() / 86_400_000);
    if (day === this.lastPruneDay) return;
    this.lastPruneDay = day;
    const retentionDays =
      readDaemonSettingsSync().events?.retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS;
    const cutoff = new Date((day - retentionDays) * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM hook_events WHERE created_at < ?').run(cutoff);
  }

  listByProject(projectId: number, limit = 100): HookEventRow[] {
    return this.db
      .prepare(
        'SELECT * FROM hook_events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(projectId, limit)
      .map((row) => toHookEvent(row));
  }

  /**
   * 按会话查事件（最新窗口，返回升序——任务视图事件链保序）。
   * id 单调=插入序，消解 created_at 并列；取最新窗口后 reverse 成升序，
   * 返回序与原 ORDER BY created_at ASC 一致，调用方零适配。
   * `beforeId` 游标翻页：只取比游标更早的事件（组头「加载更早」向前翻 prompt）。
   */
  /** 删会话时连带清事件（append-only 表只有「删会话」与「保留期」两条删除路径）。 */
  deleteBySession(sessionId: string): number {
    return Number(
      this.db.prepare('DELETE FROM hook_events WHERE session_id = ?').run(sessionId).changes,
    );
  }

  listBySession(sessionId: string, limit = 300, beforeId?: number): HookEventRow[] {
    const rows =
      beforeId == null
        ? this.db
            .prepare('SELECT * FROM hook_events WHERE session_id = ? ORDER BY id DESC LIMIT ?')
            .all(sessionId, limit)
        : this.db
            .prepare(
              'SELECT * FROM hook_events WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
            )
            .all(sessionId, beforeId, limit);
    return rows.map((row) => toHookEvent(row)).reverse();
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
