import type { DatabaseSync } from 'node:sqlite';
import {
  HARNESS_COMPACTION,
  HARNESS_LIFECYCLE,
  HARNESS_TOOL_EVENTS,
  isHarness,
  type Harness,
} from '@weavecode/core';
import { readDaemonSettingsSync, DEFAULT_SESSION_IDLE_DAYS } from '../daemon/settings.js';

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
  harness?: Harness | null;
  /** 回合开合的服务端基线：最后一条 UserPromptSubmit 晚于最后一条回合收尾事件
   *  （Stop/StopFailure/SessionEnd，以及非压缩的 SessionStart——终端挂掉后 resume
   *  起来不会有 Stop；listWithCounts 查询填充）——前端帧态丢失/重挂载时的权威兜底。 */
  turnOpen?: boolean;
  /** 最新一条 hook 事件类型（listWithCounts 查询填充）——web 状态总线判「关闭」
   *  （SessionEnd）不必再为每个会话拉事件。 */
  lastEventType?: string | null;
  /** 这个会话真跑过（有过 UserPromptSubmit 或收尾事件；listWithCounts 查询填充）。
   *  「有没有转录」的判据要用它：没跑过的会话本来就还没写过转录，没内容不是丢失。 */
  hasRun?: boolean;
  /** 自动移除时刻（= lastSeenAt + 该档保留窗；listWithCounts 派生，两档——没等到
   *  用户 prompt 的新会话快过期，收到过 prompt 的走设置页「无操作会话 n 天后自动
   *  移除」那条线；会话行剩余存活倒计时即读它）。 */
  autoDeleteAt?: string | null;
  /** 还没等到用户 prompt（listWithCounts 派生）——编排的会话选择器按它排除短
   *  有效期会话，与 autoDeleteAt 的档位同一判据。 */
  promptless?: boolean;
}

/** 没等到用户 prompt 的新会话快过期窗（ms）= 1 小时：新建会话要看得见，但无 prompt
 *  的会话不配占 90 天窗口。 */
export const PROMPTLESS_GRACE_MS = 60 * 60_000;

/** 无操作保留窗（ms）= settings `sessions.idleDays`（缺省/坏值回落默认）。 */
function sessionIdleRetentionMs(): number {
  return (
    (readDaemonSettingsSync().sessions?.idleDays ?? DEFAULT_SESSION_IDLE_DAYS) * 86_400_000
  );
}

/**
 * 「回合收尾」的 SQL 判据（`alias` = hook_events 的别名）：各 harness 的 close
 * （Stop/StopFailure）∪ 会话起落标记（SessionStart/SessionEnd）。**起落标记算收尾**
 * 是因为终端异常退出时宿主不会补发 Stop，会话 resume 起来只留一笔 SessionStart——
 * 不认它，turnOpen 就永远挂着，列表一直显「运行中」。**压缩收尾的那笔 SessionStart
 * 是回合中途发生的**（HARNESS_COMPACTION），必须排除。事件名一律取表，不散写。
 */
function turnCloseSql(alias: string): string {
  const types = new Set<string>();
  for (const l of Object.values(HARNESS_LIFECYCLE)) {
    for (const t of l.close) types.add(t);
    for (const t of l.sessionMarkers) types.add(t);
    if (l.sessionExit) types.add(l.sessionExit);
  }
  const list = [...types].map((t) => `'${t}'`).join(',');
  const compactEnd = Object.values(HARNESS_COMPACTION)
    .filter((c) => c.end && c.endSource)
    .map(
      (c) =>
        `(${alias}.event_type = '${c.end}' AND COALESCE(json_extract(${alias}.payload, '$.raw.source'), '') = '${c.endSource}')`,
    )
    .join(' OR ');
  return `${alias}.event_type IN (${list})${compactEnd ? ` AND NOT (${compactEnd})` : ''}`;
}

/**
 * 「回合内工具事件」的 SQL 判据（HARNESS_TOOL_EVENTS 并集）：最后收尾之后仍有
 * 工具事件 = 排队回合实际还开着（claude 出队开跑的新回合不再发第二条 UPS，
 * 见 HARNESS_TOOL_EVENTS 注）。事件名一律取表，不散写。
 */
function turnToolSql(alias: string): string {
  const types = new Set<string>();
  for (const list of Object.values(HARNESS_TOOL_EVENTS)) {
    for (const t of list) types.add(t);
  }
  const list = [...types].map((t) => `'${t}'`).join(',');
  return `${alias}.event_type IN (${list})`;
}

/**
 * sessions 表：daemon 自存的会话标题（不写回 Claude Code 内部文件）。
 * 双向 rename：读 = payload session_title diff；写 = pending_title 经 hook sessionTitle 输出生效。
 */
export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 事件到达时 upsert（刷新 last_seen_at，project_id 首次非空时补上）。
   * `at` = 事件真实时刻（拉取式采集回填历史时带上）；`last_seen_at` 只增不减——
   * 回填的旧事件晚到，不能把一个活跃会话的时间往回拨。
   */
  touch(sessionId: string, projectId?: number | null, at?: string | null): SessionRow {
    const now = at ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, project_id, last_seen_at, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_seen_at = MAX(sessions.last_seen_at, excluded.last_seen_at),
           project_id = COALESCE(sessions.project_id, excluded.project_id)`,
      )
      .run(sessionId, projectId ?? null, now, now);
    return this.getBySessionId(sessionId)!;
  }

  getBySessionId(sessionId: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
    return row ? toSession(row) : undefined;
  }

  /** 仪表盘用：会话总数不受列表 200 上限影响。 */
  countAll(): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
    );
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
   * 全局搜索的会话名路：已生效标题 LIKE（`pending_title` 还没经 hook 下发，
   * 不搜）。表只有几十行，LIKE 全扫毫秒级；最近活跃在前。
   */
  searchByTitle(q: string, limit: number): SessionRow[] {
    const needle = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare(
        "SELECT * FROM sessions WHERE title LIKE ? ESCAPE '\\' ORDER BY last_seen_at DESC LIMIT ?",
      )
      .all(needle, limit);
    return rows.map(toSession);
  }

  /**
   * 会话列表 + 事件计数（任务视图左栏用）：LEFT JOIN 一次查出避免 N+1。
   * 计数不过滤项目（会话可能有跨项目事件），与事件链的 sessionId-only 语义一致。
   *
   * `sessionIds` = 只算这几行（增量补丁用）：事件只会改动它自己那条会话的
   * 「最新事件 / 回合开合」判据，没必要为了一条事件把 200 行全部重算一遍。
   */
  listWithCounts(projectId?: number, sessionIds?: readonly string[]): SessionRow[] {
    // harness = 最新事件的 source（计算字段，sessions 表零 schema 变更）。
    const base =
      'SELECT s.*, COUNT(e.id) AS event_count, ' +
      '(SELECT e2.source FROM hook_events e2 WHERE e2.session_id = s.session_id ORDER BY e2.id DESC LIMIT 1) AS harness, ' +
      '(SELECT e5.event_type FROM hook_events e5 WHERE e5.session_id = s.session_id ORDER BY e5.id DESC LIMIT 1) AS last_event_type, ' +
      '(SELECT MAX(e3.id) FROM hook_events e3 WHERE e3.session_id = s.session_id AND e3.event_type = \'UserPromptSubmit\') AS last_ups, ' +
      `(SELECT MAX(e6.id) FROM hook_events e6 WHERE e6.session_id = s.session_id AND ${turnCloseSql('e6')}) AS last_close, ` +
      `(SELECT MAX(e7.id) FROM hook_events e7 WHERE e7.session_id = s.session_id AND ${turnToolSql('e7')}) AS last_tool, ` +
      '(SELECT MAX(e4.id) FROM hook_events e4 WHERE e4.session_id = s.session_id AND e4.event_type IN (\'Stop\', \'StopFailure\', \'SessionEnd\')) AS last_stop ' +
      'FROM sessions s LEFT JOIN hook_events e ON e.session_id = s.session_id';
    const where: string[] = [];
    const params: Array<number | string> = [];
    if (projectId !== undefined) {
      where.push('s.project_id = ?');
      params.push(projectId);
    }
    if (sessionIds && sessionIds.length > 0) {
      where.push(`s.session_id IN (${sessionIds.map(() => '?').join(',')})`);
      params.push(...sessionIds);
    }
    const rows = this.db
      .prepare(
        `${base}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} GROUP BY s.session_id ORDER BY s.created_at DESC LIMIT 200`,
      )
      .all(...params);
    return rows.map((row) => {
      const raw = (row as { harness?: unknown }).harness;
      const lastUps = (row as { last_ups?: number | null }).last_ups;
      const lastClose = (row as { last_close?: number | null }).last_close;
      const lastTool = (row as { last_tool?: number | null }).last_tool;
      const lastStop = (row as { last_stop?: number | null }).last_stop;
      const lastEventType = (row as { last_event_type?: string | null }).last_event_type;
      return {
        ...toSession(row),
        eventCount: Number((row as { event_count: number }).event_count ?? 0),
        harness: isHarness(raw) ? raw : null,
        // 收尾判据含起落标记（见 turnCloseSql）；hasRun 仍只认真跑过的那几种事件
        // ——只来过一笔 SessionStart 的空会话不该被当成「转录丢了」。
        // 排队回合补充臂：最后收尾之后仍有工具事件 = 回合实际还开着
        // （claude 出队开跑的新回合不再发第二条 UPS，见 HARNESS_TOOL_EVENTS 注）。
        turnOpen:
          (lastUps != null && (lastClose == null || Number(lastUps) > Number(lastClose))) ||
          (lastTool != null && (lastClose == null || Number(lastTool) > Number(lastClose))),
        lastEventType: lastEventType ?? null,
        hasRun: lastUps != null || lastStop != null,
        // 自动移除时刻（唯一判据/期限实现）两档：没等到用户 prompt（无 ups）的
        // 新会话 1 小时快过期；收到过 prompt 的走 settings `sessions.idleDays`。
        // 期限随行下发，web 渲染剩余存活倒计时；SessionSweeper 过期即清。
        autoDeleteAt: new Date(
          Date.parse(String(row.last_seen_at)) +
            (lastUps == null ? PROMPTLESS_GRACE_MS : sessionIdleRetentionMs()),
        ).toISOString(),
        promptless: lastUps == null,
      };
    });
  }

  /**
   * 单会话 turnOpen（消息域 auto 裁决的忙/闲基准）：语义与 listWithCounts 的
   * 计算字段完全一致（最后一条 UserPromptSubmit 晚于最后一条回合收尾事件，
   * 判据同 turnCloseSql；排队回合补充臂同 turnToolSql）。会话不存在 → null；
   * 存在但零事件 → false（同列表口径：无 ups 即不判开）。
   */
  turnOpenOf(sessionId: string): boolean | null {
    const row = this.db
      .prepare(
        'SELECT ' +
        '(SELECT MAX(e3.id) FROM hook_events e3 WHERE e3.session_id = ? AND e3.event_type = \'UserPromptSubmit\') AS last_ups, ' +
        `(SELECT MAX(e6.id) FROM hook_events e6 WHERE e6.session_id = ? AND ${turnCloseSql('e6')}) AS last_close, ` +
        `(SELECT MAX(e7.id) FROM hook_events e7 WHERE e7.session_id = ? AND ${turnToolSql('e7')}) AS last_tool`,
      )
      .get(sessionId, sessionId, sessionId) as
      | { last_ups?: number | null; last_close?: number | null; last_tool?: number | null }
      | undefined;
    if (!this.getBySessionId(sessionId)) return null;
    const lastUps = row?.last_ups ?? null;
    const lastClose = row?.last_close ?? null;
    const lastTool = row?.last_tool ?? null;
    return (
      (lastUps != null && (lastClose == null || Number(lastUps) > Number(lastClose))) ||
      (lastTool != null && (lastClose == null || Number(lastTool) > Number(lastClose)))
    );
  }

  /**
   * 单会话「真跑过吗」（有过 UPS 或收尾事件），与 listWithCounts 的 `hasRun` 同一
   * 判据。打开终端前判转录是否**丢过**要用它：刚建、还没发第一条 prompt 的会话
   * 本来就还没有转录文件，那不算丢失。
   */
  hasRunOf(sessionId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM hook_events e WHERE e.session_id = ? AND e.event_type IN ('UserPromptSubmit','Stop','StopFailure','SessionEnd')) AS hit",
      )
      .get(sessionId) as { hit?: number } | undefined;
    return Number(row?.hit ?? 0) > 0;
  }

  /**
   * 最后一条**主回合**事件的真实时刻（排除 SubagentStop——后台子代理收尾与主回合
   * 无关，可在主回合停下后很久才异步到达）：「已中断」的盖过基准用它而不是
   * lastSeenAt，否则中断后被 SubagentStop 盖回「生成中」（256de1f1 实测）。
   * 事件名取生命周期表；无事件 / 会话不存在 → null。
   */
  lastMainEventAtOf(sessionId: string): string | null {
    const excluded = [...new Set(Object.values(HARNESS_LIFECYCLE).map((l) => l.subagentStop))]
      .map((t) => `'${t}'`)
      .join(',');
    const row = this.db
      .prepare(
        `SELECT created_at FROM hook_events
         WHERE session_id = ? AND event_type NOT IN (${excluded})
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as { created_at?: unknown } | undefined;
    return row ? String(row.created_at) : null;
  }

  /**
   * 单会话判活输入（`daemon/claude-liveness.ts` 的 `pidAliveOf` 消费形状）——
   * harness / lastEventType / eventCount 都是 listWithCounts 的计算字段，单行版与
   * 列表版同源同判据（同 turnOpenOf 的先例）。会话不存在 → null。
   */
  livenessRowOf(sessionId: string): {
    sessionId: string;
    harness: Harness | null;
    lastSeenAt: string;
    lastEventType: string | null;
    eventCount: number;
  } | null {
    const row = this.db
      .prepare(
        'SELECT s.session_id, s.last_seen_at, COUNT(e.id) AS event_count, ' +
          "(SELECT e2.source FROM hook_events e2 WHERE e2.session_id = s.session_id ORDER BY e2.id DESC LIMIT 1) AS harness, " +
          "(SELECT e5.event_type FROM hook_events e5 WHERE e5.session_id = s.session_id ORDER BY e5.id DESC LIMIT 1) AS last_event_type " +
          'FROM sessions s LEFT JOIN hook_events e ON e.session_id = s.session_id ' +
          'WHERE s.session_id = ? GROUP BY s.session_id',
      )
      .get(sessionId) as
      | {
          session_id?: unknown;
          last_seen_at?: unknown;
          event_count?: unknown;
          harness?: unknown;
          last_event_type?: unknown;
        }
      | undefined;
    if (!row) return null;
    const harness = row.harness;
    return {
      sessionId: String(row.session_id),
      harness: isHarness(harness) ? harness : null,
      lastSeenAt: String(row.last_seen_at),
      lastEventType: row.last_event_type == null ? null : String(row.last_event_type),
      eventCount: Number(row.event_count ?? 0),
    };
  }

  /**
   * dashboard 改名：display 名（title）立即落，pending_title 负责把新名同步给
   * Claude 侧（下次 SessionStart(resume)/UserPromptSubmit 经 hook 下发）——dashboard
   * 不再替闲置会话代持旧名，徽标只表示「Claude 侧还没同步」。
   * 幂等短路：title 与当前生效名相同 → 不进待生效态（已有 pending 视为撤销，一并清掉）；
   * 与当前 pending 相同 → 维持 pending 原样返回。只有名称实际变化才写 pending。
   */
  setPendingTitle(sessionId: string, title: string): SessionRow | undefined {
    const row = this.getBySessionId(sessionId);
    if (!row) return undefined;
    // 与当前 pending 相同 → 幂等维持（须先于同名判断：title 已随写入同步为新值）。
    if (row.pendingTitle === title) return row;
    // 传入当前生效名（无 pending）→ 真同名 no-op；有 pending → 改回生效名 = 撤销。
    if (row.title === title) {
      if (row.pendingTitle != null) {
        this.db.prepare('UPDATE sessions SET pending_title = NULL WHERE session_id = ?').run(sessionId);
      }
      return this.getBySessionId(sessionId);
    }
    this.db
      .prepare('UPDATE sessions SET title = ?, pending_title = ? WHERE session_id = ?')
      .run(title, title, sessionId);
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

  /**
   * 宿主 RPC 改名落定（titles 面写通道成功后调用）：title 直接落 + 清任何
   * pending——该通道无 hook 回执，pending 机制不适用（挂了永不 confirm）。
   */
  setTitle(sessionId: string, title: string): SessionRow | undefined {
    this.db
      .prepare('UPDATE sessions SET title = ?, pending_title = NULL WHERE session_id = ?')
      .run(title, sessionId);
    return this.getBySessionId(sessionId);
  }

  remove(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  }

  /** 归档项目时清空其全部会话行（事件/派发先清，见归档路由）。 */
  removeByProject(projectId: number): number {
    return Number(
      this.db.prepare('DELETE FROM sessions WHERE project_id = ?').run(projectId).changes,
    );
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
