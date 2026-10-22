import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getAuthPath, readDaemonState } from '@weavecode/server';

/**
 * 编排内置 MCP（stdio）：工具面只转发 daemon 的 HTTP API，**不缓存任何编排状态**
 * ——编排的唯一事实源仍是 daemon 的仓储，web 画布 / CLI / 这里的修改互相立刻可见。
 *
 * 宿主侧注册命令：`weave mcp orchestration`（daemon 没起时调用会直接报错）。
 * stdout 归协议，诊断一律走 stderr。
 */

interface DaemonTarget {
  base: string;
  token: string;
}

function daemonTarget(): DaemonTarget {
  const state = readDaemonState();
  if (!state?.port) {
    throw new Error('weave daemon is not running — start it with `weave daemon start`');
  }
  const auth = JSON.parse(readFileSync(getAuthPath(), 'utf8')) as { localToken?: string };
  if (!auth.localToken) throw new Error('local token missing — run `weave daemon start` first');
  return { base: `http://127.0.0.1:${state.port}/api`, token: auth.localToken };
}

async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const { base, token } = daemonTarget();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'x-weave-local': token,
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

const TOOLS = [
  {
    name: 'list_orchestrations',
    description: 'List orchestrations (optionally filtered by project).',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'number' } },
    },
  },
  {
    name: 'get_orchestration',
    description: 'Get one orchestration definition (nodes, edges, startText, cron, enabled).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } },
  },
  {
    name: 'create_orchestration',
    description:
      'Create an orchestration. Pass enabled:false to keep it manual-only (enabled means the entry session auto-fires every natural turn).',
    inputSchema: {
      type: 'object',
      required: ['name', 'nodes', 'edges'],
      properties: {
        name: { type: 'string' },
        startText: { type: 'string' },
        projectId: { type: 'number', description: 'webhook-only orchestrations' },
        nodes: { type: 'array', items: nodeSchema },
        edges: { type: 'array', items: edgeSchema },
        cron: { type: ['string', 'null'] },
        enabled: { type: 'boolean' },
      },
    },
  },
  {
    name: 'update_orchestration',
    description: 'Update part of an orchestration (omit fields to keep them).',
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
  },
  {
    name: 'delete_orchestration',
    description: 'Delete an orchestration definition (run history is kept).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } },
  },
  {
    name: 'trigger_orchestration',
    description: 'Start a run. Optional text overrides startText; entries restricts entry nodes.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'number' },
        text: { type: 'string' },
        entries: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'list_runs',
    description: 'List orchestration runs (newest first).',
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
  },
  {
    name: 'get_run',
    description: 'Get a run with its delivery/ensure events and pending counts.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } },
  },
  {
    name: 'cancel_run',
    description: 'Cancel a running run.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'number' } } },
  },
  {
    name: 'list_sessions',
    description: 'List sessions (id, project, harness, title, liveness) for picking graph nodes.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'number' } },
    },
  },
] as const;

type Args = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

async function callTool(name: string, args: Args): Promise<unknown> {
  switch (name) {
    case 'list_orchestrations':
      return api('GET', `/messaging/orchestrations${qs({ projectId: num(args.projectId) })}`);
    case 'get_orchestration':
      return api('GET', `/messaging/orchestrations/${num(args.id)}`);
    case 'create_orchestration':
      return api('POST', '/messaging/orchestrations', {
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
      return api('PUT', `/messaging/orchestrations/${id}`, {
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.startText === undefined ? {} : { startText: args.startText }),
        ...(args.nodes === undefined ? {} : { nodes: args.nodes }),
        ...(args.edges === undefined ? {} : { edges: args.edges }),
        ...(args.cron === undefined ? {} : { cron: args.cron }),
        ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
      });
    }
    case 'delete_orchestration':
      return api('DELETE', `/messaging/orchestrations/${num(args.id)}`);
    case 'trigger_orchestration':
      return api('POST', `/messaging/orchestrations/${num(args.id)}/trigger`, {
        ...(str(args.text) ? { text: args.text } : {}),
        ...(Array.isArray(args.entries) ? { entries: args.entries } : {}),
      });
    case 'list_runs':
      return api(
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
      return api('GET', `/messaging/orchestration-runs/${num(args.id)}`);
    case 'cancel_run':
      return api('POST', `/messaging/orchestration-runs/${num(args.id)}/cancel`);
    case 'list_sessions': {
      const data = await api<{ sessions: Array<Record<string, unknown>> }>(
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

/** 启动 stdio MCP 服务（宿主按需拉起；daemon 不在时每次调用会明确报错）。 */
export async function runOrchestrationMcp(): Promise<void> {
  const server = new Server(
    { name: 'weave-orchestration', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callTool(name, (args ?? {}) as Args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });
  await server.connect(new StdioServerTransport());
}
