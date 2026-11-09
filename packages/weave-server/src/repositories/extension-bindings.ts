import type { DatabaseSync } from 'node:sqlite';

/**
 * 会话扩展点（L1 绑定域）：两表——`extension_bindings`（常驻接线：哪个作用域的
 * 哪个扩展点 → 什么决策 → 扇出到哪些端点）与 `extension_executions`（一拍一行的
 * 执行日志）。DDL 与设计稿（docs/roadmap/会话扩展点与编排重设计.md 第二章）一致。
 *
 * 执行日志激进修剪：每绑定 200 条 + 7 天（照 orchestration_runs 的 prune 形态：
 * 窗口函数按 binding_id 分组 + 时间截点，随写入被动清理）。幂等去重靠 partial
 * 唯一索引（只盖 stage='delivered' 行）：执行日志含 when-blocked 等非投递 stage，
 * 全行唯一索引会让回放期的同事件 blocked 行插不进去。
 */

/** 执行日志保留口径（自动清理的唯一常量出处）。 */
export const EXTENSION_EXECUTION_RETENTION_DAYS = 7;
export const EXTENSION_EXECUTION_KEEP_PER_BINDING = 200;

/** v1 端点两类（plugin 批 4 放开）；外部 webhook 扇入缓做。 */
export type ExtensionEndpointKind = 'session' | 'webhook';
/** v1 四个扩展点（tool-failed / session-end 引擎缓做，CRUD 先收形状）。 */
export type ExtensionPoint = 'turn-end' | 'idle' | 'tool-failed' | 'session-end';

/** 扁平端点列表的一项：放行后并行扇出、无屏障。 */
export type ExtensionEndpoint =
  | { kind: 'session'; target: string; text: string; oneWay?: boolean }
  | { kind: 'webhook'; url: string; secret?: string };

export interface ExtensionBindingRow {
  id: number;
  name: string;
  projectId: number;
  /** null = 项目级（对该项目全部会话生效）；非空 = 会话级（只绑这一个会话）。 */
  sessionId: string | null;
  point: ExtensionPoint;
  /** 关键词预筛（任一子串命中才继续；matchWhen 语义，不花 token）。 */
  when: string | null;
  /** 放行条件（决策内核判断）。 */
  condition: string | null;
  /** 提炼指令（决策并总结，产出随 {summary} 进端点载荷）。 */
  summarize: string | null;
  endpoints: ExtensionEndpoint[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ExtensionStage =
  | 'when-blocked'
  | 'condition-blocked'
  | 'delivered'
  | 'failed'
  | 'skipped:busy'
  | 'skipped:stale'
  | 'skipped:capped'
  | 'skipped:duplicate';

export interface ExtensionExecutionRow {
  id: number;
  bindingId: number;
  sessionId: string | null;
  eventId: number | null;
  trigger: string;
  stage: ExtensionStage;
  endpointKind: string | null;
  endpointTarget: string | null;
  ok: boolean | null;
  error: string | null;
  source: string | null;
  detail: string | null;
  at: string;
}

export interface ExtensionExecutionInput {
  bindingId: number;
  sessionId: string | null;
  eventId: number | null;
  trigger?: string;
  stage: ExtensionStage;
  endpointKind?: string | null;
  endpointTarget?: string | null;
  ok?: boolean | null;
  error?: string | null;
  source?: string | null;
  detail?: string | null;
  at?: string;
}

function parseEndpoints(raw: unknown): ExtensionEndpoint[] {
  let list: unknown;
  try {
    list = JSON.parse(String(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: ExtensionEndpoint[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (o.kind === 'session' && typeof o.target === 'string' && o.target) {
      out.push({
        kind: 'session',
        target: o.target,
        text: typeof o.text === 'string' ? o.text : '',
        ...(o.oneWay === true ? { oneWay: true } : {}),
      });
    } else if (o.kind === 'webhook' && typeof o.url === 'string' && o.url) {
      out.push({
        kind: 'webhook',
        url: o.url,
        ...(typeof o.secret === 'string' && o.secret ? { secret: o.secret } : {}),
      });
    }
  }
  return out;
}

function toBinding(row: Record<string, unknown>): ExtensionBindingRow {
  return {
    id: Number(row.id),
    name: String(row.name),
    projectId: Number(row.project_id),
    sessionId: row.session_id == null ? null : String(row.session_id),
    point: String(row.point) as ExtensionPoint,
    when: row.when_text == null ? null : String(row.when_text),
    condition: row.condition_text == null ? null : String(row.condition_text),
    summarize: row.summarize == null ? null : String(row.summarize),
    endpoints: parseEndpoints(row.endpoints),
    enabled: Number(row.enabled ?? 1) !== 0,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toExecution(row: Record<string, unknown>): ExtensionExecutionRow {
  return {
    id: Number(row.id),
    bindingId: Number(row.binding_id),
    sessionId: row.session_id == null ? null : String(row.session_id),
    eventId: row.event_id == null ? null : Number(row.event_id),
    trigger: String(row.trigger ?? 'event'),
    stage: String(row.stage) as ExtensionStage,
    endpointKind: row.endpoint_kind == null ? null : String(row.endpoint_kind),
    endpointTarget: row.endpoint_target == null ? null : String(row.endpoint_target),
    ok: row.ok == null ? null : Number(row.ok) !== 0,
    error: row.error == null ? null : String(row.error),
    source: row.source == null ? null : String(row.source),
    detail: row.detail == null ? null : String(row.detail),
    at: String(row.at),
  };
}

/** 绑定域：CRUD 直落库（引擎侧另持内存索引，变更后由调用方 reload）。 */
export class ExtensionBindingRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: {
    name: string;
    projectId: number;
    sessionId?: string | null;
    point: ExtensionPoint;
    when?: string | null;
    condition?: string | null;
    summarize?: string | null;
    endpoints: ExtensionEndpoint[];
    enabled?: boolean;
  }): ExtensionBindingRow {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO extension_bindings
           (name, project_id, session_id, point, when_text, condition_text, summarize, endpoints, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.projectId,
        input.sessionId ?? null,
        input.point,
        input.when ?? null,
        input.condition ?? null,
        input.summarize ?? null,
        JSON.stringify(input.endpoints),
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): ExtensionBindingRow | undefined {
    const row = this.db.prepare('SELECT * FROM extension_bindings WHERE id = ?').get(id);
    return row ? toBinding(row) : undefined;
  }

  list(): ExtensionBindingRow[] {
    return this.db.prepare('SELECT * FROM extension_bindings ORDER BY id').all().map(toBinding);
  }

  listByProject(projectId: number): ExtensionBindingRow[] {
    return this.db
      .prepare('SELECT * FROM extension_bindings WHERE project_id = ? ORDER BY id')
      .all(projectId)
      .map(toBinding);
  }

  update(
    id: number,
    patch: Partial<{
      name: string;
      sessionId: string | null;
      point: ExtensionPoint;
      when: string | null;
      condition: string | null;
      summarize: string | null;
      endpoints: ExtensionEndpoint[];
      enabled: boolean;
    }>,
  ): ExtensionBindingRow | undefined {
    const row = this.getById(id);
    if (!row) return undefined;
    this.db
      .prepare(
        `UPDATE extension_bindings
            SET name = ?, session_id = ?, point = ?, when_text = ?, condition_text = ?, summarize = ?, endpoints = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.name ?? row.name,
        patch.sessionId === undefined ? row.sessionId : patch.sessionId,
        patch.point ?? row.point,
        patch.when === undefined ? row.when : patch.when,
        patch.condition === undefined ? row.condition : patch.condition,
        patch.summarize === undefined ? row.summarize : patch.summarize,
        JSON.stringify(patch.endpoints ?? row.endpoints),
        (patch.enabled ?? row.enabled) ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    return this.getById(id);
  }

  deleteById(id: number): boolean {
    return (
      Number(this.db.prepare('DELETE FROM extension_bindings WHERE id = ?').run(id).changes) === 1
    );
  }

  /** 删会话连带清该会话的会话级绑定（项目级绑定不动——它属于项目不属会话）。 */
  deleteSessionScoped(sessionId: string): number {
    return Number(
      this.db.prepare('DELETE FROM extension_bindings WHERE session_id = ?').run(sessionId).changes,
    );
  }

  /** 项目注销级联：该项目全部绑定（含会话级）。 */
  deleteByProject(projectId: number): number {
    return Number(
      this.db.prepare('DELETE FROM extension_bindings WHERE project_id = ?').run(projectId).changes,
    );
  }
}

/** 执行日志域：一拍一行（按端点展开则一拍多行）+ 修剪 + 幂等查重。 */
export class ExtensionExecutionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: ExtensionExecutionInput): ExtensionExecutionRow {
    const result = this.db
      .prepare(
        `INSERT INTO extension_executions
           (binding_id, session_id, event_id, trigger, stage, endpoint_kind, endpoint_target, ok, error, source, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.bindingId,
        input.sessionId ?? null,
        input.eventId ?? null,
        input.trigger ?? 'event',
        input.stage,
        input.endpointKind ?? null,
        input.endpointTarget ?? null,
        input.ok === undefined || input.ok === null ? null : input.ok ? 1 : 0,
        input.error ?? null,
        input.source ?? null,
        input.detail ?? null,
        input.at ?? new Date().toISOString(),
      );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): ExtensionExecutionRow | undefined {
    const row = this.db.prepare('SELECT * FROM extension_executions WHERE id = ?').get(id);
    return row ? toExecution(row) : undefined;
  }

  query(q: {
    bindingId?: number;
    sessionId?: string;
    before?: number;
    limit?: number;
  }): { rows: ExtensionExecutionRow[]; nextBefore: number | null } {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.bindingId != null) {
      where.push('binding_id = ?');
      args.push(q.bindingId);
    }
    if (q.sessionId) {
      where.push('session_id = ?');
      args.push(q.sessionId);
    }
    if (q.before != null) {
      where.push('id < ?');
      args.push(q.before);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM extension_executions ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit + 1)
      .map(toExecution);
    const page = rows.slice(0, limit);
    return { rows: page, nextBefore: rows.length > limit ? page[page.length - 1]!.id : null };
  }

  /**
   * 幂等去重（回放 = at-least-once 的兜底）：该 (绑定, 事件, 端点) 已有 delivered
   * 行 = 端点已发过（daemon 在「端点已发、日志未落」窗口崩溃后的回放不重复扇出）。
   * partial 索引盖着这条查询，O(1) 定位。
   */
  hasDelivered(bindingId: number, eventId: number, kind: string, target: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM extension_executions
            WHERE binding_id = ? AND event_id = ? AND endpoint_kind = ? AND endpoint_target = ? AND stage = 'delivered'
            LIMIT 1`,
        )
        .get(bindingId, eventId, kind, target) !== undefined
    );
  }

  /** 删会话连带清该会话的执行行（会话的历史随会话走）。 */
  deleteBySession(sessionId: string): number {
    return Number(
      this.db.prepare('DELETE FROM extension_executions WHERE session_id = ?').run(sessionId).changes,
    );
  }

  /** 项目注销级联（绑定行删除后这些行再无归属意义，一并清）。 */
  deleteByProject(projectId: number): number {
    return Number(
      this.db
        .prepare(
          `DELETE FROM extension_executions WHERE binding_id IN
             (SELECT id FROM extension_bindings WHERE project_id = ?)`,
        )
        .run(projectId).changes,
    );
  }

  /** 自动清理：冷行超期或超出每绑定上限即删（照 orchestration_runs 的 prune 形态）。 */
  prune(now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - EXTENSION_EXECUTION_RETENTION_DAYS * 86_400_000).toISOString();
    const expired = Number(
      this.db.prepare('DELETE FROM extension_executions WHERE at < ?').run(cutoff).changes,
    );
    const overflow = Number(
      this.db
        .prepare(
          `DELETE FROM extension_executions
            WHERE id IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY binding_id ORDER BY id DESC) AS rn
                  FROM extension_executions
              ) WHERE rn > ?
            )`,
        )
        .run(EXTENSION_EXECUTION_KEEP_PER_BINDING).changes,
    );
    return expired + overflow;
  }
}
