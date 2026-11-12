import type { McpHttpContext, McpToolDef, McpToolRequest } from './registry.js';

/**
 * 事件域内置 MCP 服务 `weave-events`：事件流查询 / 仪表盘总量与速率 / 接口日志 /
 * 会话用量。工具面只转发 daemon 自己的 HTTP API，**不缓存任何状态、不自带业务
 * 逻辑**——保留期、速率快照回填、日志脱敏等一切裁决仍在 daemon。
 */

async function api<T>(
  ctx: McpHttpContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api${path}`, {
    method,
    headers: {
      'x-weave-origin': 'mcp',
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

const EVENT_REF = { type: 'object', additionalProperties: true } as const;

export const EVENTS_TOOLS = [
  {
    name: 'list_events',
    description:
      'List captured harness events of a project, newest first (or a session chain when sessionId is given, ascending). Payload is the JSON the host hook reported. Returns { events: HookEventRow[] }.',
    inputSchema: {
      type: 'object',
      required: ['projectId'],
      properties: {
        projectId: { type: 'number' },
        sessionId: { type: 'string', description: 'given: that session\'s event chain (limit caps the window)' },
        limit: { type: 'number', description: 'default 100, capped at 500' },
        types: { type: 'string', description: 'comma-separated event_type filter (sessionId mode only)' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: { events: { type: 'array', items: EVENT_REF } },
      required: ['events'],
    },
  },
  {
    name: 'get_dashboard',
    description:
      'Dashboard totals (projects/sessions/events/today) plus the last hour of event-rate buckets (10s each). Rate reads the in-process snapshot, NOT a time-window query. Returns { totals, series }.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        totals: { type: 'object', additionalProperties: true },
        series: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['totals', 'series'],
    },
  },
  {
    name: 'query_api_logs',
    description:
      'Query the daemon interface log (one JSONL row per HTTP request), newest first. Bodies (req/res payloads) are stripped here — ask for metadata only; raw rows stay on disk. Returns { entries: ApiLogEntry[], files }.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO lower bound' },
        to: { type: 'string', description: 'ISO upper bound' },
        path: { type: 'string', description: 'substring filter on the request path' },
        method: { type: 'string' },
        status: { type: 'number' },
        limit: { type: 'number', description: 'default 200, capped at 1000' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
        files: { type: 'number' },
      },
      required: ['entries'],
    },
  },
  {
    name: 'get_session_usage',
    description:
      'Per-turn token usage of a session (input/output/cache/reasoning/context), read passively from the transcript. Returns { supported, usage: UsageTurn[] | null }; usage=null means unreadable, supported=false means the harness has no usage surface. Requires the sessionProbe dep.',
    inputSchema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'get_backup_status',
    description:
      'Daily-backup subsystem: enabled/hour settings, last run result (or error), running progress (phase/ratio/etaSeconds), and the list of backup packages on disk. Returns { status, settings, packages }; 503 when the backup engine is unavailable.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'run_backup',
    description:
      'Trigger a backup run now. includeHistory=true additionally packs the history domain (transcripts/sessions/events) and uploads — off by default (default pack = settings, projects, market git-tracked files, plugins). Returns { ok, result } when finished; 409 when a run is already in progress.',
    inputSchema: {
      type: 'object',
      properties: { includeHistory: { type: 'boolean' } },
    },
    outputSchema: { type: 'object', additionalProperties: true },
  },
] as const satisfies readonly McpToolDef[];

type Args = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * 工具 → 它转发的 daemon 请求（对账测试遍历这张映射，逐条比对 daemon 路由表）。
 */
export function toolRequest(name: string, args: Args): McpToolRequest {
  switch (name) {
    case 'list_events':
      return {
        method: 'GET',
        path: `/projects/${num(args.projectId) ?? 0}/hooks${qs({
          sessionId: str(args.sessionId),
          limit: num(args.limit),
          types: str(args.types),
        })}`,
      };
    case 'get_dashboard':
      return { method: 'GET', path: '/dashboard' };
    case 'query_api_logs':
      return {
        method: 'GET',
        path: `/api-logs${qs({
          from: str(args.from),
          to: str(args.to),
          path: str(args.path),
          method: str(args.method),
          status: num(args.status),
          limit: num(args.limit),
        })}`,
      };
    case 'get_session_usage':
      return { method: 'GET', path: `/sessions/${encodeURIComponent(str(args.sessionId) ?? '')}/usage` };
    case 'get_backup_status':
      return { method: 'GET', path: '/backup/status' };
    case 'run_backup':
      return {
        method: 'POST',
        path: '/backup/run',
        body: { ...(args.includeHistory === undefined ? {} : { includeHistory: args.includeHistory }) },
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** 转发回包的策展整形（接口日志的 req/res 正文不进 MCP 回包——体积大且是原文）。 */
function postProcess(name: string, data: unknown): unknown {
  switch (name) {
    case 'list_events': {
      const rows = (data as { events: Array<Record<string, unknown>> }).events;
      return {
        events: rows.map((e) => ({
          id: e.id,
          projectId: e.projectId,
          source: e.source,
          eventType: e.eventType,
          sessionId: e.sessionId,
          createdAt: e.createdAt,
          // payload 服务端已按 4KB capFields 裁过：照原样给（解析坏行不在此修）
          payload: e.payload,
          ...(Array.isArray(e.images) ? { images: e.images } : {}),
        })),
      };
    }
    case 'query_api_logs': {
      const r = data as { entries: Array<Record<string, unknown>>; files: number };
      return {
        entries: r.entries.map((e) => ({
          ts: e.ts,
          method: e.method,
          path: e.path,
          status: e.status,
          durationMs: e.durationMs,
          origin: e.origin,
          resBytes: e.resBytes,
          ...(e.stream === undefined ? {} : { stream: e.stream }),
          ...(e.aborted === undefined ? {} : { aborted: e.aborted }),
        })),
        files: r.files,
      };
    }
    default:
      return data;
  }
}

export async function callTool(ctx: McpHttpContext, name: string, args: Args): Promise<unknown> {
  const req = toolRequest(name, args);
  const data = await api(ctx, req.method, req.path, req.body);
  return postProcess(name, data);
}
