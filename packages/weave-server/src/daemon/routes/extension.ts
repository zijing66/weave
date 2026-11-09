import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HARNESS_KEYS, HARNESS_LIFECYCLE } from '@weavecode/core';
import type {
  ExtensionEndpoint,
  ExtensionPoint,
} from '../../repositories/extension-bindings.js';
import type { WeaveServerDeps } from '../server.js';
import { messagingSurfaceFor } from '../../surfaces.js';
import { readJson, sendJson } from '../http.js';

/**
 * 会话扩展点域路由（L1 绑定域，批 2b）：绑定 CRUD + 执行日志查询。照编排域
 * 先例（`routes/orchestration.ts`）：zod 收形状、projectId 只收数字（项目路径
 * 由 server 查库，前端路径不进协议）、端点 kind 校验只认 session|webhook（v1；
 * plugin 随其落地批次放开）。
 */

const EndpointBody: z.ZodType<ExtensionEndpoint> = z.union([
  z.object({
    kind: z.literal('session'),
    /** sessionId 或 'self'（自指 = 外部事件转告本会话）。 */
    target: z.string().min(1).max(128),
    text: z.string().max(20_000),
    oneWay: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('webhook'),
    url: z.string().min(1).max(2_000),
    secret: z.string().max(400).optional(),
  }),
]);

const POINTS = new Set<ExtensionPoint>(['turn-end', 'idle', 'tool-failed', 'session-end']);

const BindingBody = z.object({
  name: z.string().min(1).max(200),
  projectId: z.number().int(),
  /** null/缺省 = 项目级；非空 = 会话级（只绑这一个会话）。 */
  sessionId: z.string().min(1).max(128).nullish(),
  point: z.string().refine((p): p is ExtensionPoint => POINTS.has(p as ExtensionPoint), {
    message: 'Unknown extension point',
  }),
  when: z.string().max(500).nullish(),
  condition: z.string().max(4_000).nullish(),
  summarize: z.string().max(4_000).nullish(),
  endpoints: z.array(EndpointBody).max(8),
  enabled: z.boolean().optional(),
});

const BindingPatchBody = BindingBody.partial();

function intParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 扩展点域路由。返回 true = 本路由认领；false = 未命中，主链继续。 */
export async function handleExtensionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  const unavailable = (): boolean => {
    sendJson(res, 503, { error: 'Extensions subsystem unavailable' });
    return true;
  };

  if (pathname === '/extensions/bindings') {
    if (!deps.extensionBindings) return unavailable();
    if (req.method === 'GET') {
      const projectId = intParam(url, 'projectId');
      const rows =
        projectId === undefined
          ? deps.extensionBindings.list()
          : deps.extensionBindings.listByProject(projectId);
      sendJson(res, 200, { bindings: rows });
      return true;
    }
    if (req.method === 'POST') {
      let body: z.infer<typeof BindingBody>;
      try {
        body = BindingBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      if (!deps.projects.getById(body.projectId)) {
        sendJson(res, 400, { error: 'Unknown project' });
        return true;
      }
      // 会话级绑定的会话必须存在（作用域写错 = 绑定永远不命中，静默失能更糟）。
      if (body.sessionId && !deps.hookSessions?.getBySessionId(body.sessionId)) {
        sendJson(res, 400, { error: `Unknown session: ${body.sessionId}` });
        return true;
      }
      const row = deps.extensionBindings.insert({
        name: body.name.trim(),
        projectId: body.projectId,
        sessionId: body.sessionId ?? null,
        point: body.point,
        when: body.when ?? null,
        condition: body.condition ?? null,
        summarize: body.summarize ?? null,
        endpoints: body.endpoints,
        enabled: body.enabled,
      });
      deps.extensionEngine?.reload();
      sendJson(res, 201, { ok: true, binding: row });
      return true;
    }
  }

  const bindingMatch = pathname.match(/^\/extensions\/bindings\/(\d+)(\/dry-run)?$/);
  if (bindingMatch) {
    const id = Number(bindingMatch[1]);
    if (!deps.extensionBindings) return unavailable();
    // POST /extensions/bindings/:id/dry-run — §1.6 测试台：合成一拍执行（不真扇出、
    // 不烧目标会话），走引擎同一条闸链；逐阶段落执行日志并随响应回报。
    if (bindingMatch[2] === '/dry-run' && req.method === 'POST') {
      if (!deps.extensionEngine?.dryRun) return unavailable();
      let body: { sessionId?: string; upstream?: string } = {};
      try {
        body = (await readJson(req)) as { sessionId?: string; upstream?: string };
      } catch {
        body = {};
      }
      const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
      const binding = deps.extensionBindings.getById(id);
      if (!binding) {
        sendJson(res, 404, { error: 'Binding not found' });
        return true;
      }
      // 合成事件总要落在一个会话上：请求带了就用（须存在），没带取该项目
      // 最近的一条会话（有会话才谈得上 upstream）；项目一条会话都没有 = 409。
      let target: string | null = sessionId;
      if (!target) {
        const row = deps.hookSessions?.list(binding.projectId)[0] ?? null;
        target = row?.sessionId ?? null;
      }
      if (!target) {
        sendJson(res, 409, { error: 'No session to dry-run against — pass sessionId' });
        return true;
      }
      if (sessionId && !deps.hookSessions?.getBySessionId(sessionId)) {
        sendJson(res, 400, { error: `Unknown session: ${sessionId}` });
        return true;
      }
      const result = await deps.extensionEngine.dryRun(id, target, {
        ...(typeof body.upstream === 'string' ? { upstream: body.upstream } : {}),
      });
      sendJson(res, 200, { ok: result.ok, stages: result.stages });
      return true;
    }
    if (req.method === 'PUT') {
      const row = deps.extensionBindings.getById(id);
      if (!row) {
        sendJson(res, 404, { error: 'Binding not found' });
        return true;
      }
      let body: z.infer<typeof BindingPatchBody>;
      try {
        body = BindingPatchBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      if (body.sessionId && !deps.hookSessions?.getBySessionId(body.sessionId)) {
        sendJson(res, 400, { error: `Unknown session: ${body.sessionId}` });
        return true;
      }
      const next = deps.extensionBindings.update(id, {
        name: body.name?.trim(),
        sessionId: body.sessionId === undefined ? undefined : (body.sessionId ?? null),
        point: body.point,
        when: body.when === undefined ? undefined : (body.when ?? null),
        condition: body.condition === undefined ? undefined : (body.condition ?? null),
        summarize: body.summarize === undefined ? undefined : (body.summarize ?? null),
        endpoints: body.endpoints,
        enabled: body.enabled,
      });
      deps.extensionEngine?.reload();
      sendJson(res, 200, { ok: true, binding: next });
      return true;
    }
    if (req.method === 'DELETE') {
      if (!deps.extensionBindings.getById(id)) {
        sendJson(res, 404, { error: 'Binding not found' });
        return true;
      }
      deps.extensionBindings.deleteById(id);
      deps.extensionEngine?.reload();
      sendJson(res, 200, { ok: true, bindingId: id });
      return true;
    }
  }

  if (pathname === '/extensions/executions' && req.method === 'GET') {
    if (!deps.extensionExecutions) return unavailable();
    const page = deps.extensionExecutions.query({
      bindingId: intParam(url, 'bindingId'),
      sessionId: url.searchParams.get('sessionId') || undefined,
      before: intParam(url, 'before'),
      limit: intParam(url, 'limit'),
    });
    sendJson(res, 200, { executions: page.rows, nextBefore: page.nextBefore });
    return true;
  }

  // GET /extensions/capabilities — 派生面（批 3）：可用触发点/端点能力按 harness
  // 派生，web 据此置灰与说明原因，不摆空壳。全部字段从既有面现读（生命周期表、
  // messaging 槽的 idleSignals、resume 槽的 extractArgs、deliverer 的 prompt 通道），
  // 不写第二份支持状态事实源。
  if (pathname === '/extensions/capabilities' && req.method === 'GET') {
    const promptChannel = deps.messageDeliverer?.hasTerminalChannel() ?? false;
    const harnesses = HARNESS_KEYS.map((harness) => {
      let close: readonly string[] = [];
      let idle: readonly string[] = [];
      let reason: string | null = null;
      let extract = false;
      let prompt = false;
      try {
        const surface = messagingSurfaceFor(harness);
        close = HARNESS_LIFECYCLE[harness].close;
        idle = surface.idleSignals;
        prompt = surface.queuedPrompt !== null || surface.prompt !== null || promptChannel;
        // fork 提取面（condition/summarize 可用性）：resume 槽有 extractArgs 才有。
        extract = typeof deps.harnesses?.get(harness)?.resume?.extractArgs === 'function';
      } catch {
        reason = `no messaging surface for ${harness}`;
      }
      return {
        harness,
        // 触发点：turn-end = 生命周期表 close；idle = idleSignals（两端点恒可配，
        // 只是没会话可投时不执行）。
        points: { 'turn-end': close, idle },
        // 端点两类（v1；plugin 随批 4 放开）：session 靠 prompt 通道、webhook 恒可。
        endpoints: {
          session: prompt,
          webhook: true,
        },
        // 决策内核（condition/summarize）：fork 提取面在场才可用。
        decision: extract,
        ...(reason ? { unsupportedReasons: { messaging: reason } } : {}),
      };
    });
    sendJson(res, 200, { harnesses });
    return true;
  }
  return false;
}
