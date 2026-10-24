import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  OrchestrationEdge,
  OrchestrationNode,
  OrchestrationRow,
  OrchestrationRunStatus,
} from '../../repositories/orchestrations.js';
import { nextRunAt, parseCron } from '../cron.js';
import { validateOrchestration } from '../../hooks/orchestration-graph.js';
import { graphDirections, toRunSummary } from '../../repositories/orchestrations.js';
import type { WeaveServerDeps } from '../server.js';
import { readBody, readJson, sendJson } from '../http.js';

/** 跨会话编排的定义体：图规模/成环/方向形状由 `validateOrchestration` 判（错误文案归它）。 */
const OrchestrationNodeBody = z.object({
  /** session 节点 = sessionId；webhook = `w:<uuid>`；手动触发 = `t:<uuid>`。 */
  id: z.string().min(1).max(128),
  kind: z.enum(['session', 'webhook', 'trigger']),
  /** webhook 入口的触发 token（省略由仓储补发；回存已有 token 原样保留）。 */
  webhookToken: z.string().min(1).max(200).optional(),
  /** webhook 出口的出站目标与可选 HMAC 密钥。 */
  url: z.string().max(2_000).optional(),
  secret: z.string().max(400).optional(),
  /** session 中间节点也参与自然回合触发（入口恒可；webhook 节点设了无效）。 */
  autoFire: z.boolean().optional(),
});

const OrchestrationBody = z.object({
  name: z.string().min(1).max(200),
  startText: z.string().max(20_000).optional(),
  /** webhook-only 编排的项目归属（有 session 入口时恒从入口派生，给了不一致即拒）。 */
  projectId: z.number().int().optional(),
  nodes: z.array(OrchestrationNodeBody).min(1),
  edges: z.array(
    z.object({
      id: z.string().min(1).max(64),
      from: z.string().min(1),
      to: z.string().min(1),
      /** 空正文只在 webhook 入口的出边或设了提取指令的边上合法（`validateOrchestration` 判）。 */
      text: z.string().max(20_000),
      /** 本边提取指令（对上游会话 fork 无头回合产出 {summary}；空 = 不提取）。 */
      extract: z.string().max(4_000).optional(),
      /** 本边放行条件（对上游会话问 yes/no；no 或判不出都拦下不投）。 */
      condition: z.string().max(4_000).optional(),
      /** 本边文本预筛（{upstream} 命中任一关键词才继续/才 fork）。 */
      when: z.string().max(500).optional(),
    }),
  ),
  cron: z.string().max(200).nullish(),
  /** false = 停用：cron 不触发、入口会话的自然回合不自动启动。 */
  enabled: z.boolean().optional(),
});

const OrchestrationPatchBody = OrchestrationBody.partial();

/** 手动触发可带一条首步消息（缺省用编排自己的起始文本）与入口子集（缺省全部 session 入口）。 */
const TriggerBody = z.object({
  text: z.string().min(1).max(20_000).optional(),
  entries: z.array(z.string().min(1)).optional(),
});

/** 换某枚 webhook 入口节点的 token。 */
const RotateNodeBody = z.object({ nodeId: z.string().min(1).max(128) });

const RUN_STATUSES = new Set<OrchestrationRunStatus>([
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);

function intParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 编排行的对外形状：补一个「下次 cron 触发时刻」（现算，不落库）。 */
function withNextRun(row: OrchestrationRow) {
  const schedule = row.cron ? parseCron(row.cron) : null;
  return { ...row, nextRunAt: schedule ? nextRunAt(schedule) : null };
}

/**
 * 定义落库前的唯一闸（POST/PUT 同一份判据）：图合法（规模/可达/成环/方向形状）、
 * session 节点都还在管、cron 可解析。项目归属 = 入口 session 节点所属项目
 * （入口必须同项目，web 项目视图同判据）；webhook-only 编排由 body 显式给。
 */
function resolveOrchestration(
  deps: WeaveServerDeps,
  input: {
    name: string;
    startText?: string;
    projectId?: number;
    nodes: OrchestrationNode[];
    edges: OrchestrationEdge[];
    cron?: string | null;
  },
):
  | {
      ok: true;
      value: {
        name: string;
        projectId: number;
        startText: string;
        nodes: OrchestrationNode[];
        edges: OrchestrationEdge[];
        cron: string | null;
      };
    }
  | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Name is required' };
  const valid = validateOrchestration(input);
  if (!valid.ok) return { ok: false, error: valid.error };
  const cron = input.cron?.trim() || null;
  if (cron && !parseCron(cron)) return { ok: false, error: `Invalid cron expression: ${cron}` };
  for (const node of input.nodes) {
    if (node.kind !== 'session') continue;
    if (!deps.hookSessions?.getBySessionId(node.id)) {
      return { ok: false, error: `Unknown session: ${node.id}` };
    }
  }
  const { entries } = graphDirections(input.nodes, input.edges);
  const sessionEntries = entries.filter((e) => e.kind === 'session');
  let projectId = input.projectId ?? null;
  if (sessionEntries.length > 0) {
    const first = deps.hookSessions!.getBySessionId(sessionEntries[0]!.id)!;
    if (projectId != null && projectId !== first.projectId) {
      return { ok: false, error: 'projectId must match the entry sessions' };
    }
    projectId = first.projectId;
    if (projectId == null) return { ok: false, error: 'Entry session has no project' };
    for (const entry of sessionEntries) {
      if (deps.hookSessions!.getBySessionId(entry.id)!.projectId !== projectId) {
        return { ok: false, error: 'All entry sessions must belong to the same project' };
      }
    }
  } else {
    // 没有 session 入口（webhook 入口直挂 session / webhook-only）：项目归属
    // 回落到第一个 session 节点，纯 webhook 编排才要求显式给。
    const firstSession = input.nodes.find((n) => n.kind === 'session');
    if (firstSession) {
      projectId = deps.hookSessions!.getBySessionId(firstSession.id)!.projectId ?? projectId;
    }
  }
  if (projectId == null) {
    return { ok: false, error: 'projectId is required for webhook-only orchestrations' };
  }
  return {
    ok: true,
    value: {
      name,
      projectId,
      startText: (input.startText ?? '').trim(),
      nodes: input.nodes,
      edges: input.edges,
      cron,
    },
  };
}

/** 删定义/清日志前先停掉在飞的运行：运行态活着却没有行可写，只会静默失败。 */
function cancelRunsOf(deps: WeaveServerDeps, orchestrationId: number): void {
  for (const run of deps.orchestrationRuns?.listRunning() ?? []) {
    if (run.orchestrationId === orchestrationId) deps.orchestrationEngine?.cancel(run.id);
  }
}

/**
 * 编排域路由（从 hooks-routes 拆出）：定义 CRUD/触发/rotate、运行日志、公开 webhook。
 * 返回 true = 本路由认领；false = 未命中，主链继续。
 */
export async function handleOrchestrationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (pathname === '/messaging/orchestrations') {
    if (!deps.orchestrations) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    if (req.method === 'GET') {
      const projectId = intParam(url, 'projectId');
      const rows =
        projectId === undefined
          ? deps.orchestrations.list()
          : deps.orchestrations.listByProject(projectId);
      sendJson(res, 200, { orchestrations: rows.map(withNextRun) });
      return true;
    }
    if (req.method === 'POST') {
      let body: z.infer<typeof OrchestrationBody>;
      try {
        body = OrchestrationBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      const resolved = resolveOrchestration(deps, body);
      if (!resolved.ok) {
        sendJson(res, 400, { error: resolved.error });
        return true;
      }
      sendJson(res, 201, {
        ok: true,
        // enabled 不在 resolve 的字段里（insert 默认启用）：建「默认停用」的编排
        // 必须透传，否则入口会话的下一个自然回合就会自动触发
        orchestration: withNextRun(
          deps.orchestrations.insert({ ...resolved.value, enabled: body.enabled }),
        ),
      });
      return true;
    }
  }

  const orchestrationMatch = pathname.match(/^\/messaging\/orchestrations\/(\d+)$/);
  if (orchestrationMatch) {
    const id = Number(orchestrationMatch[1]);
    if (req.method === 'PUT') {
      if (!deps.orchestrations) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      const row = deps.orchestrations.getById(id);
      if (!row) {
        sendJson(res, 404, { error: 'Orchestration not found' });
        return true;
      }
      let body: z.infer<typeof OrchestrationPatchBody>;
      try {
        body = OrchestrationPatchBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      // 在飞的运行吃的是触发那一刻的快照：改图不影响它，下一次触发才生效。
      const resolved = resolveOrchestration(deps, {
        name: body.name ?? row.name,
        startText: body.startText ?? row.startText,
        projectId: body.projectId ?? (row.nodes.some((n) => n.kind === 'session') ? undefined : row.projectId),
        nodes: body.nodes ?? row.nodes,
        edges: body.edges ?? row.edges,
        cron: body.cron === undefined ? row.cron : body.cron,
      });
      if (!resolved.ok) {
        sendJson(res, 400, { error: resolved.error });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        orchestration: withNextRun(
          deps.orchestrations.update(id, { ...resolved.value, enabled: body.enabled })!,
        ),
      });
      return true;
    }
    if (req.method === 'DELETE') {
      if (!deps.orchestrations) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      if (!deps.orchestrations.getById(id)) {
        sendJson(res, 404, { error: 'Orchestration not found' });
        return true;
      }
      cancelRunsOf(deps, id);
      deps.orchestrations.deleteById(id);
      sendJson(res, 200, { ok: true, orchestrationId: id });
      return true;
    }
  }

  const triggerMatch = pathname.match(/^\/messaging\/orchestrations\/(\d+)\/trigger$/);
  if (triggerMatch && req.method === 'POST') {
    if (!deps.orchestrationEngine || !deps.orchestrations) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    let body: z.infer<typeof TriggerBody> = {};
    try {
      const raw = (await readBody(req)).trim();
      if (raw) body = TriggerBody.parse(JSON.parse(raw));
    } catch {
      sendJson(res, 400, { error: 'Invalid body' });
      return true;
    }
    const result = await deps.orchestrationEngine.start(
      Number(triggerMatch[1]),
      'manual',
      body.text,
      body.entries,
    );
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 201, { ok: true, runId: result.runId });
    return true;
  }

  const rotateMatch = pathname.match(/^\/messaging\/orchestrations\/(\d+)\/rotate-webhook$/);
  if (rotateMatch && req.method === 'POST') {
    if (!deps.orchestrations) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    let body: z.infer<typeof RotateNodeBody>;
    try {
      body = RotateNodeBody.parse(await readJson(req));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    const token = deps.orchestrations.rotateNodeToken(Number(rotateMatch[1]), body.nodeId);
    if (!token) {
      sendJson(res, 404, { error: 'Webhook entry node not found' });
      return true;
    }
    sendJson(res, 200, { ok: true, webhookToken: token });
    return true;
  }

  // ---- 公开 webhook 触发：token 即凭证（认证门在 server.ts 的 isPublicRequest 放行）----
  const webhookMatch = pathname.match(/^\/webhooks\/orchestrate\/([A-Za-z0-9_-]+)$/);
  if (webhookMatch && req.method === 'POST') {
    if (!deps.orchestrations || !deps.orchestrationEngine) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const hit = deps.orchestrations.getByNodeToken(webhookMatch[1]!);
    if (!hit) {
      sendJson(res, 404, { error: 'Unknown webhook token' });
      return true;
    }
    // 载荷随该入口的出边正文下发（空则只发边正文）。
    const payload = (await readBody(req)).trim().slice(0, 20_000);
    const result = await deps.orchestrationEngine.start(hit.row.id, 'webhook', payload || undefined, [
      hit.nodeId,
    ]);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 202, { ok: true, runId: result.runId });
    return true;
  }

  if (pathname === '/messaging/orchestration-runs') {
    if (!deps.orchestrationRuns) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    if (req.method === 'GET') {
      const status = url.searchParams.get('status') || undefined;
      if (status && !RUN_STATUSES.has(status as OrchestrationRunStatus)) {
        sendJson(res, 400, { error: `Unknown run status: ${status}` });
        return true;
      }
      const page = deps.orchestrationRuns.query({
        orchestrationId: intParam(url, 'orchestrationId'),
        projectId: intParam(url, 'projectId'),
        status,
        text: url.searchParams.get('text') || undefined,
        before: intParam(url, 'before'),
        limit: intParam(url, 'limit'),
      });
      sendJson(res, 200, { runs: page.runs.map(toRunSummary), nextBefore: page.nextBefore });
      return true;
    }
    if (req.method === 'DELETE') {
      const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'finished';
      const projectId = intParam(url, 'projectId');
      if (scope === 'all') {
        // 全清 = 先停手再删：运行态活着却没有行可写，只会静默失败。
        for (const run of deps.orchestrationRuns.listRunning()) {
          if (projectId != null && run.projectId !== projectId) continue;
          deps.orchestrationEngine?.cancel(run.id);
        }
      }
      sendJson(res, 200, {
        ok: true,
        deleted: deps.orchestrationRuns.clear(scope, projectId),
      });
      return true;
    }
  }

  const runDetailMatch = pathname.match(/^\/messaging\/orchestration-runs\/(\d+)$/);
  if (runDetailMatch && req.method === 'GET') {
    if (!deps.orchestrationRuns) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const run = deps.orchestrationRuns.getById(Number(runDetailMatch[1]));
    if (!run) {
      sendJson(res, 404, { error: 'Run not found' });
      return true;
    }
    // 详情 = summary + state：列表行带 pendingCounts 无 state，原始行反之——
    // web 的 OrchestrationRunRow 两者都要（展开行直接顶替列表行渲染）。
    sendJson(res, 200, { run: { ...toRunSummary(run), state: run.state } });
    return true;
  }

  const cancelRunMatch = pathname.match(/^\/messaging\/orchestration-runs\/(\d+)\/cancel$/);
  if (cancelRunMatch && req.method === 'POST') {
    if (!deps.orchestrationRuns) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const run = deps.orchestrationRuns.getById(Number(cancelRunMatch[1]));
    if (!run) {
      sendJson(res, 404, { error: 'Run not found' });
      return true;
    }
    if (run.status !== 'running') {
      sendJson(res, 409, { error: `Run already ${run.status}` });
      return true;
    }
    if (!deps.orchestrationEngine?.cancel(run.id)) {
      deps.orchestrationRuns.finish(run.id, 'cancelled');
    }
    sendJson(res, 200, { ok: true, runId: run.id });
    return true;
  }
  return false;
}
