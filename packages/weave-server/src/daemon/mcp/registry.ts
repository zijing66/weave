import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readBody, sendJson } from '../http.js';
import { TOOLS, callTool } from './orchestration.js';
import * as sessionsNs from './sessions.js';

/**
 * 内置 MCP 注册表（Streamable HTTP，daemon 托管）：`serverName → 服务定义`。
 * 每个服务 = 名字 + 版本 + 工具清单 + 调用实现；`server.ts` 按 `/mcp/<server>`
 * 分发，`/mcp` 裸路径保留指向编排（存量已装配置不断）。
 *
 * 工具面只转发 daemon 自己的 HTTP API，**不缓存任何状态**——唯一事实源仍是
 * daemon 的仓储。生命周期 = daemon 的启停（无子进程、无 CLI 命令），无状态模式，
 * 认证沿用本机令牌（MCP 客户端配置里带 `x-weave-local` 头）。诊断走 stderr。
 */

export interface McpHttpContext {
  /** daemon 自己的监听端口（工具调用转回自己的 API）。 */
  port: number;
  /** 本机令牌；null = 未装认证（测试/开放口），调用不带令牌。 */
  token: string | null;
}

/** 工具的 schema 定义（每个工具都带 outputSchema：宿主据此校验/展示返回）。 */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

/** 工具调用 = 一次对 daemon 自身 REST API 的转发请求。 */
export interface McpToolRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** daemon 上的路径（`/api` 前缀之外的部分，如 `/messaging/orchestrations`）。 */
  path: string;
  body?: unknown;
}

export interface McpServerDef {
  /** 配置里的服务名（与 `BUILTIN_MCP_SERVERS` 的 name 对齐）。 */
  name: string;
  version: string;
  /** 服务的端点路径段：`/mcp`（裸，留存量）或 `/mcp/<server>`。 */
  path: string;
  tools: readonly McpToolDef[];
  callTool: (ctx: McpHttpContext, name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** 唯一注册点：加内置 MCP 服务 = 这里加一条（`BUILTIN_MCP_SERVERS` 同步一行）。 */
export const MCP_SERVERS: readonly McpServerDef[] = [
  {
    name: 'weave-orchestration',
    version: '0.1.0',
    // `/mcp` 裸路径 = 编排（存量已装配置不断）；后续新服务走 `/mcp/<server>`。
    path: '/mcp',
    tools: TOOLS,
    callTool,
  },
  {
    name: 'weave-sessions',
    version: '0.1.0',
    path: '/mcp/sessions',
    tools: sessionsNs.SESSIONS_TOOLS,
    callTool: sessionsNs.callTool,
  },
];
export function mcpServerForPath(pathname: string): McpServerDef | null {
  for (const def of MCP_SERVERS) {
    if (def.path === pathname) return def;
  }
  return null;
}

function buildServer(def: McpServerDef, ctx: McpHttpContext): Server {
  const server = new Server(
    { name: def.name, version: def.version },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: def.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await def.callTool(ctx, name, (args ?? {}) as Record<string, unknown>);
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
 * 内置 MCP 的 HTTP 入口（无状态）：每个请求建一套 server+transport，响应完即回收。
 * 无状态模式不带会话 id、不做会话校验——工具都是「一问一答」，不需要长连接状态。
 */
export async function handleMcpServerRequest(
  def: McpServerDef,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McpHttpContext,
): Promise<void> {
  const server = buildServer(def, ctx);
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
