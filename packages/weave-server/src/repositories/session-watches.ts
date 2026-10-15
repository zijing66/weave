import type { DatabaseSync } from 'node:sqlite';

/**
 * 会话订阅的触发类型（命中其一即 fire）：
 *   idle          = 目标空闲（harness 的 idleSignals 全集，批 2 语义）
 *   turnEnd       = 一轮对话结束（HARNESS_LIFECYCLE[<harness>].close，claude = Stop）
 *   messageFailed = 该会话有消息投递失败/超时（管道 message.finished 帧）
 * 一条订阅可含多种（订阅时选）；老行/未指定 = 缺省 idle。
 */
export type WatchOn = 'idle' | 'turnEnd' | 'messageFailed';
export const WATCH_ON_VALUES: readonly WatchOn[] = ['idle', 'turnEnd', 'messageFailed'];
export const DEFAULT_WATCH_ON: readonly WatchOn[] = ['idle'];

export interface SessionWatchRow {
  id: number;
  /** null = dashboard 订阅（fire 走 SSE/toast）；会话 id = 通知注入该会话。 */
  watcherSessionId: string | null;
  targetSessionId: string;
  /** 触发类型集（至少一项）。 */
  onEvents: WatchOn[];
  /** 剩余提醒次数（**所有已选类型共用**）；null = 持久化（不自动失效）。 */
  remaining: number | null;
  /** 注入 watcher 会话的文本；null = fire 时按目标会话渲染缺省文案。 */
  notify: string | null;
  /** 落定时刻（次数耗尽或 one-shot 命中）；null = 仍然有效。 */
  firedAt: string | null;
  createdAt: string;
}

/** session_watches 会话订阅域（session-orchestration 批 2 + 提醒类型）：one-shot，fire 即失效。 */
export class SessionWatchRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: {
    watcherSessionId: string | null;
    targetSessionId: string;
    notify: string | null;
    onEvents?: readonly WatchOn[];
    /** 提醒次数；null/缺省 = 1（一次，批 2 语义）；显式 null 传「持久化」用 remaining。 */
    times?: number | null;
  }): SessionWatchRow {
    const result = this.db
      .prepare(
        `INSERT INTO session_watches (watcher_session_id, target_session_id, notify, on_events, remaining, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.watcherSessionId,
        input.targetSessionId,
        input.notify,
        JSON.stringify(input.onEvents?.length ? input.onEvents : DEFAULT_WATCH_ON),
        input.times === undefined ? 1 : input.times,
        new Date().toISOString(),
      );
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
   * 命中一次（**单条原子 UPDATE**，跨连接也安全——inbox 消费线程持有第二个连接）：
   * 计数订阅 `remaining = remaining - 1`，减到 0 当即落定；持久化订阅（remaining
   * IS NULL）不消耗，只校验仍然有效。返回 null = 已失效（并发方吃掉最后一次 /
   * 次数耗尽）——调用方必须放弃副作用（防同批 Stop/SessionEnd 双事件双投递）。
   */
  consumeHit(id: number): SessionWatchRow | null {
    const decremented = Number(
      this.db
        .prepare(
          `UPDATE session_watches SET remaining = remaining - 1
           WHERE id = ? AND fired_at IS NULL AND remaining > 0`,
        )
        .run(id).changes,
    );
    if (decremented === 1) {
      // 减到 0 = 次数用尽：同刻落定（条件更新天然幂等，并发只赢一次）
      this.db
        .prepare('UPDATE session_watches SET fired_at = ? WHERE id = ? AND remaining = 0 AND fired_at IS NULL')
        .run(new Date().toISOString(), id);
      return this.getById(id) ?? null;
    }
    // 未走计数路径：持久化订阅（remaining IS NULL，`NULL > 0` 不成立）仍算命中
    const row = this.getById(id);
    return row && row.remaining === null && row.firedAt === null ? row : null;
  }

  /** 改写待触发订阅的类型集/剩余次数（dashboard 订阅修改即 upsert 的落点）；
   *  已落定（fired）行不可改，返回 undefined。 */
  updateById(
    id: number,
    patch: { onEvents?: WatchOn[]; remaining: number | null },
  ): SessionWatchRow | undefined {
    const current = this.getById(id);
    if (!current || current.firedAt !== null) return undefined;
    this.db
      .prepare(
        'UPDATE session_watches SET on_events = ?, remaining = ? WHERE id = ? AND fired_at IS NULL',
      )
      .run(
        JSON.stringify(patch.onEvents ?? current.onEvents),
        patch.remaining,
        id,
      );
    return this.getById(id);
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
    onEvents: parseOn(row.on_events),
    remaining: row.remaining == null ? null : Number(row.remaining),
    notify: row.notify == null ? null : String(row.notify),
    firedAt: row.fired_at == null ? null : String(row.fired_at),
    createdAt: String(row.created_at),
  };
}

/** 触发类型集解析：坏值/空/老行（列未写）= 缺省 idle。 */
export function parseOn(raw: unknown): WatchOn[] {
  if (typeof raw !== 'string' || !raw) return [...DEFAULT_WATCH_ON];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_WATCH_ON];
    const kinds = parsed.filter((v): v is WatchOn => WATCH_ON_VALUES.includes(v as WatchOn));
    return kinds.length ? kinds : [...DEFAULT_WATCH_ON];
  } catch {
    return [...DEFAULT_WATCH_ON];
  }
}
