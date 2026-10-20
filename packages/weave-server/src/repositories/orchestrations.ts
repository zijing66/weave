import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** 编排日志保留口径（自动清理的唯一常量出处）：超期或超出每编排上限即删。 */
export const ORCH_RUN_RETENTION_DAYS = 7;
export const ORCH_RUN_KEEP_PER_ORCH = 100;

export interface OrchestrationEdge {
  id: string;
  from: string;
  to: string;
  /** 边上的消息正文（源会话完成一轮时投给目标）。 */
  text: string;
}

export interface OrchestrationRow {
  id: number;
  name: string;
  /** 起始会话所属项目（「项目编排」即按它过滤）。 */
  projectId: number;
  startSessionId: string;
  startText: string;
  nodes: string[];
  edges: OrchestrationEdge[];
  cron: string | null;
  lastCronAt: string | null;
  webhookToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OrchestrationTrigger = 'manual' | 'webhook' | 'cron';
export type OrchestrationRunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface RunPending {
  messageId: string;
  at: string;
}

export interface RunEvent {
  at: string;
  from: string;
  to: string;
  edgeId: string;
  ok: boolean;
  error?: string;
}

export interface OrchestrationRunState {
  /** 每会话未消化的投递（该会话下一次回合完成时消耗一条）。 */
  pending: Record<string, RunPending[]>;
  events: RunEvent[];
}

export interface OrchestrationRunRow {
  id: number;
  orchestrationId: number;
  orchestrationName: string;
  projectId: number;
  trigger: OrchestrationTrigger;
  status: OrchestrationRunStatus;
  deliveries: number;
  state: OrchestrationRunState;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

/** 列表/帧用的轻量形态：丢 events、pending 落成计数。 */
export type OrchestrationRunSummary = Omit<OrchestrationRunRow, 'state'> & {
  pendingCounts: Record<string, number>;
};

export function pendingCountsOf(state: OrchestrationRunState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [sessionId, list] of Object.entries(state.pending)) {
    if (list.length > 0) counts[sessionId] = list.length;
  }
  return counts;
}

export function toRunSummary(row: OrchestrationRunRow): OrchestrationRunSummary {
  const { state, ...rest } = row;
  return { ...rest, pendingCounts: pendingCountsOf(state) };
}

function newToken(): string {
  return randomBytes(18).toString('base64url');
}

function emptyState(): OrchestrationRunState {
  return { pending: {}, events: [] };
}

/** 编排定义域：节点/边/触发配置全在行（引擎只有 run 的内存态）。 */
export class OrchestrationRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: {
    name: string;
    projectId: number;
    startSessionId: string;
    startText: string;
    nodes: string[];
    edges: OrchestrationEdge[];
    cron?: string | null;
  }): OrchestrationRow {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO orchestrations
           (name, project_id, start_session_id, start_text, nodes, edges, cron, webhook_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.projectId,
        input.startSessionId,
        input.startText,
        JSON.stringify(input.nodes),
        JSON.stringify(input.edges),
        input.cron ?? null,
        newToken(),
        now,
        now,
      );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): OrchestrationRow | undefined {
    const row = this.db.prepare('SELECT * FROM orchestrations WHERE id = ?').get(id);
    return row ? toOrchestration(row) : undefined;
  }

  getByToken(token: string): OrchestrationRow | undefined {
    const row = this.db.prepare('SELECT * FROM orchestrations WHERE webhook_token = ?').get(token);
    return row ? toOrchestration(row) : undefined;
  }

  list(): OrchestrationRow[] {
    return this.db.prepare('SELECT * FROM orchestrations ORDER BY id').all().map(toOrchestration);
  }

  listByProject(projectId: number): OrchestrationRow[] {
    return this.db
      .prepare('SELECT * FROM orchestrations WHERE project_id = ? ORDER BY id')
      .all(projectId)
      .map(toOrchestration);
  }

  update(
    id: number,
    patch: {
      name?: string;
      projectId?: number;
      startSessionId?: string;
      startText?: string;
      nodes?: string[];
      edges?: OrchestrationEdge[];
      cron?: string | null;
    },
  ): OrchestrationRow | undefined {
    const row = this.getById(id);
    if (!row) return undefined;
    this.db
      .prepare(
        `UPDATE orchestrations
            SET name = ?, project_id = ?, start_session_id = ?, start_text = ?,
                nodes = ?, edges = ?, cron = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.name ?? row.name,
        patch.projectId ?? row.projectId,
        patch.startSessionId ?? row.startSessionId,
        patch.startText ?? row.startText,
        JSON.stringify(patch.nodes ?? row.nodes),
        JSON.stringify(patch.edges ?? row.edges),
        patch.cron === undefined ? row.cron : patch.cron,
        new Date().toISOString(),
        id,
      );
    return this.getById(id);
  }

  setCronFired(id: number, minute: string): void {
    this.db.prepare('UPDATE orchestrations SET last_cron_at = ? WHERE id = ?').run(minute, id);
  }

  rotateToken(id: number): string | null {
    const token = newToken();
    const changes = Number(
      this.db
        .prepare('UPDATE orchestrations SET webhook_token = ?, updated_at = ? WHERE id = ?')
        .run(token, new Date().toISOString(), id).changes,
    );
    return changes === 1 ? token : null;
  }

  /** 删定义（运行日志保留：日志表已去规范化编排名与项目 id）。 */
  deleteById(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM orchestrations WHERE id = ?').run(id).changes) === 1;
  }

  /** 删会话连带清定义（起始会话或任一节点命中）。 */
  deleteMentioningSession(sessionId: string): number {
    const doomed = this.list().filter(
      (row) => row.startSessionId === sessionId || row.nodes.includes(sessionId),
    );
    return this.deleteAll(doomed);
  }

  deleteByProject(projectId: number): number {
    return this.deleteAll(this.listByProject(projectId));
  }

  private deleteAll(rows: OrchestrationRow[]): number {
    const del = this.db.prepare('DELETE FROM orchestrations WHERE id = ?');
    return rows.reduce((n, row) => n + Number(del.run(row.id).changes), 0);
  }
}

/** 运行日志域：一次触发一行，跨编排/跨项目统一查询 + 保留期清理。 */
export class OrchestrationRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: {
    orchestrationId: number;
    orchestrationName: string;
    projectId: number;
    trigger: OrchestrationTrigger;
  }): OrchestrationRunRow {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO orchestration_runs
           (orchestration_id, orchestration_name, project_id, trigger, status, deliveries, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', 0, ?, ?, ?)`,
      )
      .run(
        input.orchestrationId,
        input.orchestrationName,
        input.projectId,
        input.trigger,
        JSON.stringify(emptyState()),
        now,
        now,
      );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): OrchestrationRunRow | undefined {
    const row = this.db.prepare('SELECT * FROM orchestration_runs WHERE id = ?').get(id);
    return row ? toRun(row) : undefined;
  }

  listRunning(): OrchestrationRunRow[] {
    return this.db
      .prepare(`SELECT * FROM orchestration_runs WHERE status = 'running' ORDER BY id`)
      .all()
      .map(toRun);
  }

  /** 日志视图：id 倒序、`before` 向前翻页（多取一条判有没有下一页）。 */
  query(q: {
    orchestrationId?: number;
    projectId?: number;
    status?: string;
    text?: string;
    before?: number;
    limit?: number;
  }): { runs: OrchestrationRunRow[]; nextBefore: number | null } {
    const limit = Math.min(Math.max(q.limit ?? 30, 1), 200);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.orchestrationId != null) {
      where.push('orchestration_id = ?');
      args.push(q.orchestrationId);
    }
    if (q.projectId != null) {
      where.push('project_id = ?');
      args.push(q.projectId);
    }
    if (q.status) {
      where.push('status = ?');
      args.push(q.status);
    }
    if (q.text) {
      where.push('orchestration_name LIKE ?');
      args.push(`%${q.text}%`);
    }
    if (q.before != null) {
      where.push('id < ?');
      args.push(q.before);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM orchestration_runs ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit + 1)
      .map(toRun);
    const page = rows.slice(0, limit);
    return { runs: page, nextBefore: rows.length > limit ? page[page.length - 1].id : null };
  }

  updateState(id: number, state: OrchestrationRunState, deliveries: number): boolean {
    return (
      Number(
        this.db
          .prepare(
            `UPDATE orchestration_runs SET state = ?, deliveries = ?, updated_at = ?
              WHERE id = ? AND status = 'running'`,
          )
          .run(JSON.stringify(state), deliveries, new Date().toISOString(), id).changes,
      ) === 1
    );
  }

  /** 终态落定（CAS running → status）；false = 已有并发终态。 */
  finish(
    id: number,
    status: Exclude<OrchestrationRunStatus, 'running'>,
    error: string | null = null,
    state?: OrchestrationRunState,
  ): boolean {
    const now = new Date().toISOString();
    return (
      Number(
        this.db
          .prepare(
            `UPDATE orchestration_runs
                SET status = ?, error = ?, state = COALESCE(?, state), finished_at = ?, updated_at = ?
              WHERE id = ? AND status = 'running'`,
          )
          .run(status, error, state ? JSON.stringify(state) : null, now, now, id).changes,
      ) === 1
    );
  }

  /** 自动清理：冷行超期或超出每编排上限即删（running 恒保留）。返回删除数。 */
  prune(now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - ORCH_RUN_RETENTION_DAYS * 86_400_000).toISOString();
    const expired = Number(
      this.db
        .prepare(`DELETE FROM orchestration_runs WHERE status <> 'running' AND created_at < ?`)
        .run(cutoff).changes,
    );
    const overflow = Number(
      this.db
        .prepare(
          `DELETE FROM orchestration_runs
            WHERE status <> 'running' AND id IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY orchestration_id ORDER BY id DESC) AS rn
                  FROM orchestration_runs
              ) WHERE rn > ?
            )`,
        )
        .run(ORCH_RUN_KEEP_PER_ORCH).changes,
    );
    return expired + overflow;
  }

  /** 手动清空：finished 只删终态；all 连 running 一起删（调用方须先停手）。 */
  clear(scope: 'finished' | 'all', projectId?: number): number {
    const where: string[] = [];
    const args: number[] = [];
    if (scope === 'finished') where.push(`status <> 'running'`);
    if (projectId != null) {
      where.push('project_id = ?');
      args.push(projectId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return Number(this.db.prepare(`DELETE FROM orchestration_runs ${clause}`).run(...args).changes);
  }
}

function toOrchestration(row: Record<string, unknown>): OrchestrationRow {
  return {
    id: Number(row.id),
    name: String(row.name),
    projectId: Number(row.project_id),
    startSessionId: String(row.start_session_id),
    startText: String(row.start_text),
    nodes: parseJson<string[]>(row.nodes, []),
    edges: parseJson<OrchestrationEdge[]>(row.edges, []),
    cron: row.cron == null ? null : String(row.cron),
    lastCronAt: row.last_cron_at == null ? null : String(row.last_cron_at),
    webhookToken: row.webhook_token == null ? null : String(row.webhook_token),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRun(row: Record<string, unknown>): OrchestrationRunRow {
  const state = parseJson<OrchestrationRunState>(row.state, emptyState());
  return {
    id: Number(row.id),
    orchestrationId: Number(row.orchestration_id),
    orchestrationName: String(row.orchestration_name),
    projectId: Number(row.project_id),
    trigger: String(row.trigger) as OrchestrationTrigger,
    status: String(row.status) as OrchestrationRunStatus,
    deliveries: Number(row.deliveries),
    state: { pending: state.pending ?? {}, events: state.events ?? [] },
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}
