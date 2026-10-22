import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readBody, sendJson } from './http.js';

/**
 * 编排内置 MCP（Streamable HTTP，daemon 托管）：工具面只转发 daemon 自己的 HTTP
 * API，**不缓存任何编排状态**——编排的唯一事实源仍是 daemon 的仓储，web 画布、
 * CLI、MCP 三处修改互相立刻可见。
 *
 * 生命周期 = daemon 的启停（无子进程、无 CLI 命令）；端点固定 `/mcp`，无状态模式，
 * 认证沿用本机令牌（MCP 客户端配置里带 `x-weave-local` 头）。诊断走 stderr。
 */

export interface McpHttpContext {
  /** daemon 自己的监听端口（工具调用转回自己的 API）。 */
  port: number;
  /** 本机令牌；null = 未装认证（测试/开放口），调用不带令牌。 */
  token: string | null;
}

async function api<T>(
  ctx: McpHttpContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api${path}`, {
    method,
    headers: {
      ...(ctx.token ? { 'x-weave-local': ctx.token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  })();
  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return parsed as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

const nodeSchema = {
  type: 'object',
  required: ['id', 'kind'],
  properties: {
    id: { type: 'string', description: 'session id, or "w:<uuid>" for a webhook node' },
    kind: { type: 'string', enum: ['session', 'webhook'] },
    webhookToken: { type: 'string' },
    url: { type: 'string', description: 'webhook exit: outbound URL' },
    secret: { type: 'string', description: 'webhook exit: optional HMAC secret' },
  },
} as const;

const edgeSchema = {
  type: 'object',
  required: ['id', 'from', 'to', 'text'],
  properties: {
    id: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    text: { type: 'string', description: 'message body; {upstream}/{summary}/{session} are substituted' },
    extract: { type: 'string', description: 'optional extraction prompt for {summary}' },
  },
} as const;

/** 每个工具都带 outputSchema：宿主据此校验/展示返回，不用等模型猜形状。 */
const ORCH_REF = { type: 'object', additionalProperties: true } as const;
const RUN_REF = { type: 'object', additionalProperties: true } as const;

const TOOLS = [
  {
    name: 'list_orchestrations',
    description:
      'List orchestrations (optionally by project). Returns { orchestrations: OrchestrationRow[] }; each row has id/name/projectId/startText/nodes/edges/enabled/cron/nextRunAt.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'number' } } },
    outputSchema: {
      type: 'object',
      properties: { orchestrations: { type: 'array', items: ORCH_REF } },
      required: ['orchestrations'],
    },
  },
  {
    name: 'get_orchestration',
    description:
      'Get one orchestration definition (nodes, edges, startText, cron, enabled). Returns { orchestration }.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } },
    outputSchema: { type: 'object', properties: { orchestration: ORCH_REF }, required: ['orchestration'] },
  },
  {
    name: 'create_orchestration',
    description:
      'Create an orchestration. enabled defaults to true, which makes the entry session auto-fire the graph on EVERY natural turn — pass enabled:false when the run should be triggered manually. Edges support {upstream}/{summary}/{session}; a cycle is rejected. Returns { ok, orchestration }.',
    inputSchema: {
      type: 'object',
      required: ['name', 'nodes', 'edges'],
      properties: {
        name: { type: 'string' },
        startText: { type: 'string', description: 'first message for session entries (manual trigger)' },
        projectId: { type: 'number', description: 'webhook-only orchestrations' },
        nodes: { type: 'array', items: nodeSchema },
        edges: { type: 'array', items: edgeSchema },
        cron: { type: ['string', 'null'] },
        enabled: { type: 'boolean' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, orchestration: ORCH_REF },
      required: ['ok', 'orchestration'],
    },
  },
  {
    name: 'update_orchestration',
    description:
      'Update part of an orchestration (omit fields to keep them; changing the graph does not affect a run already in flight). Returns { ok, orchestration }.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'number' },
        name: { type: 'string' },
        startText: { type: 'string' },
        nodes: { type: 'array', items: nodeSchema },
        edges: { type: 'array', items: edgeSchema },
        cron: { type: ['string', 'null'] },
        enabled: { type: 'boolean' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, orchestration: ORCH_REF },
      required: ['ok', 'orchestration'],
    },
  },
  {
    name: 'delete_orchestration',
    description:
      'Delete a definition. Run history (orchestration_runs) is kept. Returns { ok, orchestrationId }.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, orchestrationId: { type: 'number' } },
      required: ['ok', 'orchestrationId'],
    },
  },
  {
    name: 'trigger_orchestration',
    description:
      'Start a run. Manual trigger works even when enabled=false. Optional text overrides startText; entries restricts which entry nodes run. Dead target sessions are opened automatically, and delivery waits for their SessionStart. Returns { ok, runId }.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'number' },
        text: { type: 'string' },
        entries: { type: 'array', items: { type: 'string' } },
      },
    },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, runId: { type: 'number' } },
      required: ['ok', 'runId'],
    },
  },
  {
    name: 'list_runs',
    description:
      'List runs, newest first. Returns { runs: RunSummary[], nextBefore }. RunSummary has id/orchestrationId/name/status/deliveries/pendingCounts/createdAt.',
    inputSchema: {
      type: 'object',
      properties: {
        orchestrationId: { type: 'number' },
        projectId: { type: 'number' },
        status: { type: 'string' },
        limit: { type: 'number' },
        before: { type: 'number' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        runs: { type: 'array', items: RUN_REF },
        nextBefore: { type: ['number', 'null'] },
      },
      required: ['runs'],
    },
  },
  {
    name: 'get_run',
    description:
      'Get a run with state.events (deliveries and stage:"ensure" opens) and state.pending per session. Returns { run }. status becomes interrupted when the daemon restarts (runs are not resumed).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } },
    outputSchema: { type: 'object', properties: { run: RUN_REF }, required: ['run'] },
  },
  {
    name: 'cancel_run',
    description: 'Cancel a running run. Returns { ok, runId }.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, runId: { type: 'number' } },
      required: ['ok', 'runId'],
    },
  },
  {
    name: 'list_sessions',
    description:
      'List sessions for picking graph nodes; minimal fields only (sessionId/projectId/title/harness/lastSeenAt/turnOpen/pidAlive). Returns { sessions }.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'number' } } },
    outputSchema: {
      type: 'object',
      properties: { sessions: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      required: ['sessions'],
    },
  },
] as const;

type Args = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

async function callTool(ctx: McpHttpContext, name: string, args: Args): Promise<unknown> {
  switch (name) {
    case 'list_orchestrations':
      return api(ctx, 'GET', `/messaging/orchestrations${qs({ projectId: num(args.projectId) })}`);
    case 'get_orchestration': {
      // 服务端没有单条 GET（只有列表）：按 id 过滤，找不到明确报错，
      // 绝不让 SPA 的 HTML 兜底页冒充编排定义。
      const all = await api<{ orchestrations: Array<{ id: number }> }>(
        ctx,
        'GET',
        '/messaging/orchestrations',
      );
      const found = all.orchestrations.find((o) => o.id === num(args.id));
      if (!found) throw new Error(`Orchestration not found: ${String(args.id)}`);
      return { orchestration: found };
    }
    case 'create_orchestration':
      return api(ctx, 'POST', '/messaging/orchestrations', {
        name: args.name,
        startText: args.startText,
        projectId: num(args.projectId),
        nodes: args.nodes,
        edges: args.edges,
        cron: args.cron ?? null,
        enabled: args.enabled,
      });
    case 'update_orchestration': {
      const id = num(args.id);
      return api(ctx, 'PUT', `/messaging/orchestrations/${id}`, {
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.startText === undefined ? {} : { startText: args.startText }),
        ...(args.nodes === undefined ? {} : { nodes: args.nodes }),
        ...(args.edges === undefined ? {} : { edges: args.edges }),
        ...(args.cron === undefined ? {} : { cron: args.cron }),
        ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
      });
    }
    case 'delete_orchestration':
      return api(ctx, 'DELETE', `/messaging/orchestrations/${num(args.id)}`);
    case 'trigger_orchestration':
      return api(ctx, 'POST', `/messaging/orchestrations/${num(args.id)}/trigger`, {
        ...(str(args.text) ? { text: args.text } : {}),
        ...(Array.isArray(args.entries) ? { entries: args.entries } : {}),
      });
    case 'list_runs':
      return api(
        ctx,
        'GET',
        `/messaging/orchestration-runs${qs({
          orchestrationId: num(args.orchestrationId),
          projectId: num(args.projectId),
          status: str(args.status),
          limit: num(args.limit),
          before: num(args.before),
        })}`,
      );
    case 'get_run':
      return api(ctx, 'GET', `/messaging/orchestration-runs/${num(args.id)}`);
    case 'cancel_run':
      return api(ctx, 'POST', `/messaging/orchestration-runs/${num(args.id)}/cancel`);
    case 'list_sessions': {
      const data = await api<{ sessions: Array<Record<string, unknown>> }>(
        ctx,
        'GET',
        `/sessions${qs({ projectId: num(args.projectId) })}`,
      );
      // 只回选节点要用的最小字段：完整行带着大量 UI 专用状态
      return {
        sessions: data.sessions.map((s) => ({
          sessionId: s.sessionId,
          projectId: s.projectId,
          title: s.title,
          harness: s.harness,
          lastSeenAt: s.lastSeenAt,
          turnOpen: s.turnOpen,
          pidAlive: s.pidAlive,
        })),
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function buildServer(ctx: McpHttpContext): Server {
  const server = new Server(
    { name: 'weave-orchestration', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callTool(ctx, name, (args ?? {}) as Args);
      // text 留给老客户端；structuredContent 给声明了 outputSchema 的宿主
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });
  return server;
}

/**
 * `/mcp` 的 HTTP 入口（无状态）：每个请求建一套 server+transport，响应完即回收。
 * 无状态模式不带会话 id、不做会话校验——工具都是「一问一答」，不需要长连接状态。
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McpHttpContext,
): Promise<void> {
  const server = buildServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  let parsed: unknown;
  if (req.method === 'POST') {
    const raw = await readBody(req);
    try {
      parsed = raw.trim() ? JSON.parse(raw) : undefined;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
  }
  await transport.handleRequest(req, res, parsed);
}
