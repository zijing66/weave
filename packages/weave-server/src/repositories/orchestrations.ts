import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** 编排日志保留口径（自动清理的唯一常量出处）：超期或超出每编排上限即删。 */
export const ORCH_RUN_RETENTION_DAYS = 7;
export const ORCH_RUN_KEEP_PER_ORCH = 100;

export interface OrchestrationEdge {
  id: string;
  from: string;
  to: string;
  /**
   * 边上的消息正文，支持变量：`{upstream}` 上游这一轮最终输出、`{summary}`
   * 本边提取结果（回落 `{upstream}`）、`{session}` 上游会话名。缺值占位原样
   * 保留 → 引擎渲染后判残留，残留即记失败（不投半截模板）。
   */
  text: string;
  /** 本边的提取指令（空 = 不提取）：对上游会话 fork 无头回合产出 `{summary}`。 */
  extract?: string;
  /**
   * 本边的放行条件（空 = 无条件）：对上游会话跑一次「衔接上下文的子 Agent」
   * （能力面，claude = fork），只认 yes/no 回答——yes 才投递；no / 判不出
   * （含 harness 无此能力面）都拦下并记 `stage:'condition'` 事件。
   */
  condition?: string;
  /**
   * 本边的文本预筛（空 = 不过筛）：`{upstream}`（宿主文末总结）里命中任一
   * 关键词（逗号/换行分隔，大小写不敏感子串）才继续（才烧 condition 的
   * fork）；不命中直接拦下——费 token 的判断不做，避免每回合都被触发。
   */
  when?: string;
}

export type OrchestrationNodeKind = 'session' | 'webhook' | 'trigger';

export interface OrchestrationNode {
  /**
   * session 节点 id = sessionId（运行态 pending 键、RunEvent.from/to、画布 flash
   * 全按它流转）；webhook 节点 = `w:<uuid>`；手动触发节点 = `t:<uuid>`——三者
   * 互不碰撞。
   */
  id: string;
  kind: OrchestrationNodeKind;
  /** webhook 入口：入站触发 token（`POST /webhooks/orchestrate/<token>`）。 */
  webhookToken?: string;
  /** webhook 出口：出站 POST 目标与可选 HMAC 签名密钥。 */
  url?: string;
  secret?: string;
  /**
   * session 节点：中间节点也参与「自然回合触发下游」（入口恒可）。
   * 编排投出来的回合不算自然回合（消费前 pending 快照判），enabled 闸全局管。
   */
  autoFire?: boolean;
}

/** nodes JSON 的解析（只认新形；坏项丢弃——写入口已 zod 拦，这里只兜磁盘）。 */
function parseNodes(raw: unknown): OrchestrationNode[] {
  let list: unknown;
  try {
    list = JSON.parse(String(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: OrchestrationNode[] = [];
  for (const n of list) {
    if (typeof n !== 'object' || n === null) continue;
    const o = n as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    const node: OrchestrationNode = {
      id: o.id,
      kind: o.kind === 'webhook' ? 'webhook' : o.kind === 'trigger' ? 'trigger' : 'session',
    };
    if (typeof o.webhookToken === 'string' && o.webhookToken) node.webhookToken = o.webhookToken;
    if (typeof o.url === 'string' && o.url) node.url = o.url;
    if (typeof o.secret === 'string' && o.secret) node.secret = o.secret;
    if (o.autoFire === true) node.autoFire = true;
    out.push(node);
  }
  return out;
}

/** 入口 = 无入边节点；出口 = 无出边节点（校验/引擎/触发共用这一份图语义）。 */
export function graphDirections(
  nodes: readonly OrchestrationNode[],
  edges: readonly OrchestrationEdge[],
): { entries: OrchestrationNode[]; exits: OrchestrationNode[] } {
  const hasIn = new Set(edges.map((e) => e.to));
  const hasOut = new Set(edges.map((e) => e.from));
  return {
    entries: nodes.filter((n) => !hasIn.has(n.id)),
    exits: nodes.filter((n) => !hasOut.has(n.id)),
  };
}

export interface OrchestrationRow {
  id: number;
  name: string;
  /** 入口 session 节点所属项目（「项目编排」即按它过滤）；webhook-only 由创建方显式给。 */
  projectId: number;
  /** session 入口的首条消息（手动/定时触发投给入口会话；webhook 入口不用它）。 */
  startText: string;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  /** false = 停用：cron 不触发、入口会话的自然回合不自动启动。 */
  enabled: boolean;
  cron: string | null;
  lastCronAt: string | null;
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
  /**
   * 事件种类：缺省 = 一次投递；`ensure` = 目标判死后拉起会话的一次尝试；
   * `condition` = 条件边被拦下（回答 no 或判不出，没有投递发生）；
   * `defer` = 人在场闸挂起（占位 pending 已入队，用户下一轮消费时真投）。
   */
  stage?: 'ensure' | 'condition' | 'defer';
  /** 耗时（ms）：ensure 用；投递事件不带。 */
  ms?: number;
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
    startText: string;
    nodes: OrchestrationNode[];
    edges: OrchestrationEdge[];
    enabled?: boolean;
    cron?: string | null;
  }): OrchestrationRow {
    const now = new Date().toISOString();
    const nodes = assignNodeTokens(this.db, input.nodes, input.edges);
    const result = this.db
      .prepare(
        `INSERT INTO orchestrations
           (name, project_id, start_text, nodes, edges, enabled, cron, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.projectId,
        input.startText,
        JSON.stringify(nodes),
        JSON.stringify(input.edges),
        input.enabled === false ? 0 : 1,
        input.cron ?? null,
        now,
        now,
      );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): OrchestrationRow | undefined {
    const row = this.db.prepare('SELECT * FROM orchestrations WHERE id = ?').get(id);
    return row ? toOrchestration(row) : undefined;
  }

  /** webhook 入口的 token → 编排 + 节点 id（nodes JSON 无索引，全表扫——量小）。 */
  getByNodeToken(token: string): { row: OrchestrationRow; nodeId: string } | undefined {
    for (const row of this.list()) {
      const hit = row.nodes.find((n) => n.kind === 'webhook' && n.webhookToken === token);
      if (hit) return { row, nodeId: hit.id };
    }
    return undefined;
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
      startText?: string;
      nodes?: OrchestrationNode[];
      edges?: OrchestrationEdge[];
      enabled?: boolean;
      cron?: string | null;
    },
  ): OrchestrationRow | undefined {
    const row = this.getById(id);
    if (!row) return undefined;
    const nodes = assignNodeTokens(
      this.db,
      patch.nodes ?? row.nodes,
      patch.edges ?? row.edges,
    );
    this.db
      .prepare(
        `UPDATE orchestrations
            SET name = ?, project_id = ?, start_text = ?, nodes = ?, edges = ?, enabled = ?, cron = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.name ?? row.name,
        patch.projectId ?? row.projectId,
        patch.startText ?? row.startText,
        JSON.stringify(nodes),
        JSON.stringify(patch.edges ?? row.edges),
        (patch.enabled ?? row.enabled) ? 1 : 0,
        patch.cron === undefined ? row.cron : patch.cron,
        new Date().toISOString(),
        id,
      );
    return this.getById(id);
  }

  setCronFired(id: number, minute: string): void {
    this.db.prepare('UPDATE orchestrations SET last_cron_at = ? WHERE id = ?').run(minute, id);
  }

  /** 换某枚 webhook 入口节点的 token（旧 token 即刻作废）。 */
  rotateNodeToken(id: number, nodeId: string): string | null {
    const row = this.getById(id);
    if (!row) return null;
    const target = row.nodes.find((n) => n.id === nodeId && n.kind === 'webhook');
    if (!target) return null;
    const taken = this.allTokens();
    let token = newToken();
    while (taken.has(token)) token = newToken();
    const nodes = row.nodes.map((n) => (n.id === nodeId ? { ...n, webhookToken: token } : n));
    this.db
      .prepare('UPDATE orchestrations SET nodes = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(nodes), new Date().toISOString(), id);
    return token;
  }

  /** 全库现役 token（行内 + 各节点），新 token 查重用。 */
  private allTokens(): Set<string> {
    const taken = new Set<string>();
    for (const row of this.list()) {
      for (const n of row.nodes) if (n.webhookToken) taken.add(n.webhookToken);
    }
    return taken;
  }

  /** 删定义（运行日志保留：日志表已去规范化编排名与项目 id）。 */
  deleteById(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM orchestrations WHERE id = ?').run(id).changes) === 1;
  }

  /** 删会话连带清定义（任一 session 节点命中）。 */
  deleteMentioningSession(sessionId: string): number {
    const doomed = this.list().filter((row) =>
      row.nodes.some((n) => n.kind === 'session' && n.id === sessionId),
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

/**
 * 给 webhook 入口节点补 token（缺才发，已有保留），全库查重。入口 = 无入边的
 * webhook 节点；出口节点（有入边）不需要 token。返回定稿后的节点数组。
 */
function assignNodeTokens(
  db: DatabaseSync,
  nodes: readonly OrchestrationNode[],
  edges: readonly OrchestrationEdge[],
): OrchestrationNode[] {
  const hasIn = new Set(edges.map((e) => e.to));
  const taken = new Set<string>();
  try {
    for (const row of db.prepare('SELECT nodes FROM orchestrations').all()) {
      for (const n of parseNodes((row as { nodes: unknown }).nodes)) {
        if (n.webhookToken) taken.add(n.webhookToken);
      }
    }
  } catch {
    // 表还没建（首启 SCHEMA 之前不会走到这里）；查重尽力而为
  }
  return nodes.map((n) => {
    if (n.kind !== 'webhook' || n.webhookToken || hasIn.has(n.id)) return n;
    let token = newToken();
    while (taken.has(token)) token = newToken();
    taken.add(token);
    return { ...n, webhookToken: token };
  });
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
    startText: String(row.start_text ?? ''),
    nodes: parseNodes(row.nodes),
    edges: parseJson<OrchestrationEdge[]>(row.edges, []),
    enabled: Number(row.enabled ?? 1) !== 0,
    cron: row.cron == null ? null : String(row.cron),
    lastCronAt: row.last_cron_at == null ? null : String(row.last_cron_at),
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
