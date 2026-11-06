import type { McpHttpContext, McpToolDef, McpToolRequest } from './registry.js';

/**
 * 会话域内置 MCP 服务 `weave-sessions`：活会话的观察 / 投递 / 问答 / 中断 / 订阅 /
 * 改动汇总。工具面只转发 daemon 自己的 HTTP API，**不缓存任何状态、不自带业务
 * 逻辑**——投递层序、判活、问答键序白名单等一切裁决仍在 daemon。
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

const SESSION_REF = { type: 'object', additionalProperties: true } as const;
const QUESTION_REF = { type: 'object', additionalProperties: true } as const;

export const SESSIONS_TOOLS = [
  {
    name: 'list_sessions',
    description:
      'List sessions with full fields (status, harness, model, liveness, activity timestamps, terminal placement...). Unlike the minimal list_sessions in weave-orchestration (for picking graph nodes), this is the full observation view. Returns { sessions: SessionRow[], modelCatalog }.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'number' } } },
    outputSchema: {
      type: 'object',
      properties: {
        sessions: { type: 'array', items: SESSION_REF },
        modelCatalog: { type: 'object', additionalProperties: true },
      },
      required: ['sessions'],
    },
  },
  {
    name: 'get_session',
    description:
      'Get one session row (same fields as list_sessions). Returns { session }; throws when the id is unknown.',
    inputSchema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { session: SESSION_REF }, required: ['session'] },
  },
  {
    name: 'send_message',
    description:
      'Send a prompt message to a session (goes through the prompt delivery channel; the message appears in the target session as if from another session, NOT as the user). In the text you may add recipient annotations `#<sessionId>「<session name>」` — these are labels for the target model to forward via its own native SendMessage; weave does not deliver them itself. Fast repeated sends to one session can be rejected (strict 1 send / 1 ack). Returns { ok, messageId, status, message }.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'text'],
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string', description: 'max 200000 chars; long text is pasted as one block' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        messageId: { type: 'string' },
        status: { type: 'string' },
        message: { type: ['string', 'null'] },
      },
      required: ['ok'],
    },
  },
  {
    name: 'list_questions',
    description:
      'List sessions with a pending blocking question (AskUserQuestion / plan approval / permission dialog). Returns { questions: QuestionEntry[] }; each entry has sessionId, questions (with questionKey and options), mode.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { questions: { type: 'array', items: QUESTION_REF } },
      required: ['questions'],
    },
  },
  {
    name: 'answer_question',
    description:
      'Answer a pending blocking question: per question, pick option indices (multi-select allowed, empty = unanswered) and optionally text for a free-input row. Keys are composed server-side and typed into the terminal pane. Returns { ok, sessionId }; 409 when the session has no pending question.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'answers'],
      properties: {
        sessionId: { type: 'string' },
        answers: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['questionKey', 'options'],
            properties: {
              questionKey: { type: 'string' },
              options: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 32 },
              text: { type: 'string' },
            },
          },
        },
      },
    },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, sessionId: { type: 'string' } },
      required: ['ok'],
    },
  },
  {
    name: 'interrupt_session',
    description:
      'Interrupt a running session (key ladder: kitty Esc, raw Esc, Ctrl+B). Always 200; confirmed=false means the keys were sent but the host did not stop yet (the transcript marker lands 10-29s later). Returns { ok, sessionId, confirmed }.',
    inputSchema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, sessionId: { type: 'string' }, confirmed: { type: 'boolean' } },
      required: ['ok', 'sessionId'],
    },
  },
  {
    name: 'watch_session',
    description:
      'Subscribe to a session: fire once (times, default 1) when it goes idle / ends a turn / has a failed delivery. Optional notify text. Returns { ok, watchId, watch }; 409 when the harness supports no such signal.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
        on: { type: 'array', items: { type: 'string', enum: ['idle', 'turnEnd', 'messageFailed'] }, minItems: 1 },
        notify: { type: 'string' },
        times: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, watchId: { type: 'number' } },
      required: ['ok', 'watchId'],
    },
  },
  {
    name: 'get_session_edits',
    description:
      'Summarize file changes made by the session (per file: additions/deletions/counts, clamped previews; diff computed by the caller). Optional since/until ISO window (default = the whole conversation). Returns { files: [...] , hunks, truncated } — files:null with a reason when the harness has no edit surface.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string' },
        since: { type: 'string', description: 'ISO timestamp, exclusive lower bound' },
        until: { type: 'string', description: 'ISO timestamp, inclusive upper bound' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        files: { type: ['array', 'null'], items: { type: 'object', additionalProperties: true } },
        hunks: { type: 'number' },
        truncated: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['files'],
    },
  },
  {
    name: 'get_session_activity',
    description:
      'Live sub-activity of a session: subagents (with transcripts), task lists, background shells. Observation only. Returns the activity account; empty/unsupported harnesses return their natural empty shape.',
    inputSchema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
    outputSchema: { type: 'object', additionalProperties: true },
  },
] as const satisfies readonly McpToolDef[];

type Args = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const idOf = (args: Args): string => encodeURIComponent(str(args.sessionId) ?? '');

/**
 * 工具 → 它转发的 daemon 请求（对账测试遍历这张映射，逐条比对 daemon 路由表）。
 */
export function toolRequest(name: string, args: Args): McpToolRequest {
  switch (name) {
    case 'list_sessions':
      return { method: 'GET', path: `/sessions${qs({ projectId: num(args.projectId) })}` };
    case 'get_session':
      // 服务端没有单条 GET（只有列表）：按 id 过滤，找不到明确报错，
      // 绝不让 SPA 的 HTML 兜底页冒充会话行。
      return { method: 'GET', path: '/sessions' };
    case 'send_message':
      return {
        method: 'POST',
        path: `/sessions/${idOf(args)}/messages`,
        body: { text: args.text, fromKind: 'session' },
      };
    case 'list_questions':
      return { method: 'GET', path: '/messaging/questions' };
    case 'answer_question':
      return { method: 'POST', path: `/sessions/${idOf(args)}/answer`, body: { answers: args.answers } };
    case 'interrupt_session':
      return { method: 'POST', path: `/sessions/${idOf(args)}/interrupt` };
    case 'watch_session':
      return {
        method: 'POST',
        path: `/sessions/${idOf(args)}/watch`,
        body: {
          ...(str(args.notify) ? { notify: args.notify } : {}),
          ...(Array.isArray(args.on) ? { on: args.on } : {}),
          ...(num(args.times) !== undefined ? { times: num(args.times) } : {}),
        },
      };
    case 'get_session_edits':
      return {
        method: 'GET',
        path: `/sessions/${idOf(args)}/edits${qs({ since: str(args.since), until: str(args.until) })}`,
      };
    case 'get_session_activity':
      return { method: 'GET', path: `/sessions/${idOf(args)}/activity` };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** 转发回包的策展整形（get_session 按 id 过滤；投递回包只留投递语义字段）。 */
function postProcess(name: string, data: unknown, args: Args): unknown {
  switch (name) {
    case 'get_session': {
      const all = data as { sessions: Array<{ sessionId: string }> };
      const found = all.sessions.find((s) => s.sessionId === args.sessionId);
      if (!found) throw new Error(`Session not found: ${String(args.sessionId)}`);
      return { session: found };
    }
    case 'send_message': {
      const r = data as { ok?: boolean; messageId?: string; status?: string; message?: string | null };
      return {
        ok: r.ok ?? true,
        ...(r.messageId === undefined ? {} : { messageId: r.messageId }),
        ...(r.status === undefined ? {} : { status: r.status }),
        ...(r.message === undefined ? {} : { message: r.message }),
      };
    }
    case 'watch_session': {
      const r = data as { watchId?: number };
      return { ok: true, watchId: r.watchId };
    }
    case 'answer_question':
      return data;
    default:
      return data;
  }
}

export async function callTool(ctx: McpHttpContext, name: string, args: Args): Promise<unknown> {
  const req = toolRequest(name, args);
  const data = await api(ctx, req.method, req.path, req.body);
  return postProcess(name, data, args);
}

