import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  HookRuleFilterSchema,
  HookRuleSourceSchema,
  HandlerConfigSchema,
  HookDispatchStatusSchema,
} from '@weave/core';
import type { WeaveServerDeps } from './server.js';

/**
 * D3 hooks 系统的全部 HTTP 路由（规则 CRUD/toggle、派发查询、会话列表/改名）。
 * 从 server.ts 主路由链中调用（server.ts 在鉴权块后插入一次调用）；
 * 返回 false 表示未命中，主链继续分发。
 */

const CreateRuleBody = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  projectId: z.number().int().nullable(),
  source: HookRuleSourceSchema,
  filter: HookRuleFilterSchema.optional(),
  handler: HandlerConfigSchema,
  timeoutMs: z.number().int().positive().optional(),
  record: z.boolean().optional(),
});

const UpdateRuleBody = CreateRuleBody.partial();

const ToggleBody = z.object({ enabled: z.boolean() });

const RenameSessionBody = z.object({ title: z.string().min(1).max(200) });

const RunDispatchBody = z.object({ sessionId: z.string().min(1) });

export async function handleHooksRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
  isAuthed: boolean,
): Promise<boolean> {
  const isHooksPath =
    pathname.startsWith('/hooks/') ||
    pathname === '/sessions' ||
    pathname.startsWith('/sessions/');
  if (!isHooksPath) return false;

  const sendJson = (status: number, data: unknown): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(data));
  };
  const readJson = async (): Promise<unknown> => JSON.parse(await readBody(req));

  if (!isAuthed) {
    sendJson(401, { error: 'Unauthorized' });
    return true;
  }

  // ---- 规则 CRUD ----
  if (pathname === '/hooks/rules') {
    if (!deps.hookRegistry) {
      sendJson(503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    if (req.method === 'GET') {
      const projectIdRaw = url.searchParams.get('projectId');
      const projectId = projectIdRaw != null && projectIdRaw !== '' ? Number(projectIdRaw) : undefined;
      sendJson(200, { rules: deps.hookRegistry.list(projectId) });
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = CreateRuleBody.parse(await readJson());
        const rule = deps.hookRegistry.create(body);
        sendJson(201, { rule });
      } catch (err) {
        sendJson(400, { error: err instanceof Error ? err.message : 'Invalid rule body' });
      }
      return true;
    }
  }

  const ruleMatch = pathname.match(/^\/hooks\/rules\/([^/]+)$/);
  if (ruleMatch) {
    if (!deps.hookRegistry) {
      sendJson(503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const id = decodeURIComponent(ruleMatch[1]!);
    if (req.method === 'PUT') {
      try {
        const patch = UpdateRuleBody.parse(await readJson());
        const rule = deps.hookRegistry.update(id, patch);
        if (!rule) {
          sendJson(404, { error: 'Rule not found' });
          return true;
        }
        sendJson(200, { rule });
      } catch (err) {
        sendJson(400, { error: err instanceof Error ? err.message : 'Invalid rule body' });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      if (!deps.hookRegistry.remove(id)) {
        sendJson(404, { error: 'Rule not found' });
        return true;
      }
      sendJson(200, { ok: true });
      return true;
    }
  }

  const toggleMatch = pathname.match(/^\/hooks\/rules\/([^/]+)\/toggle$/);
  if (toggleMatch && req.method === 'POST') {
    if (!deps.hookRegistry) {
      sendJson(503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    try {
      const body = ToggleBody.parse(await readJson());
      const rule = deps.hookRegistry.setEnabled(decodeURIComponent(toggleMatch[1]!), body.enabled);
      if (!rule) {
        sendJson(404, { error: 'Rule not found' });
        return true;
      }
      sendJson(200, { rule });
    } catch (err) {
      sendJson(400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  // ---- 派发记录 ----
  if (pathname === '/hooks/dispatches' && req.method === 'GET') {
    if (!deps.hookDispatches) {
      sendJson(503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const ruleId = url.searchParams.get('ruleId') ?? undefined;
    const statusRaw = url.searchParams.get('status');
    const status = statusRaw ? HookDispatchStatusSchema.parse(statusRaw) : undefined;
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    sendJson(200, {
      dispatches: deps.hookDispatches.list({
        ruleId,
        status,
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    });
    return true;
  }

  // ---- 指令池 resume：spawn claude --resume 后立即返回（「已启动」语义）----
  const runMatch = pathname.match(/^\/hooks\/dispatches\/(\d+)\/run$/);
  if (runMatch && req.method === 'POST') {
    if (!deps.hookRunner) {
      sendJson(503, { error: 'Resume runner unavailable' });
      return true;
    }
    let sessionId: string;
    try {
      sessionId = RunDispatchBody.parse(await readJson()).sessionId;
    } catch (err) {
      sendJson(400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    const result = await deps.hookRunner.run(Number(runMatch[1]!), sessionId);
    if (result.ok) {
      sendJson(200, { ok: true, dispatchId: result.dispatchId });
    } else {
      sendJson(result.status, { error: result.error });
    }
    return true;
  }

  // ---- 会话列表 / 改名 ----
  if (pathname === '/sessions' && req.method === 'GET') {
    if (!deps.hookSessions) {
      sendJson(503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const projectIdRaw = url.searchParams.get('projectId');
    const projectId = projectIdRaw != null && projectIdRaw !== '' ? Number(projectIdRaw) : undefined;
    sendJson(200, { sessions: deps.hookSessions.list(projectId) });
    return true;
  }

  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === 'PATCH') {
    if (!deps.hookSessions) {
      sendJson(503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    if (!deps.hookSessions.getBySessionId(sessionId)) {
      sendJson(404, { error: 'Session not found' });
      return true;
    }
    try {
      const body = RenameSessionBody.parse(await readJson());
      const session = deps.hookSessions.setPendingTitle(sessionId, body.title);
      sendJson(200, { session });
    } catch (err) {
      sendJson(400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  return false;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
