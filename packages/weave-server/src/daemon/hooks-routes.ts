import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  HookRuleFilterSchema,
  HookRuleSourceSchema,
  HandlerConfigSchema,
  HookDispatchStatusSchema,
} from '@weavecode/core';
import type { WeaveServerDeps } from './server.js';
import { readJson, sendJson } from './http.js';
import { installPlugin, uninstallPlugin } from '../hooks/plugin-installer.js';
import { purgeSession } from '../hooks/session-purge.js';
import { effective, setProjectEnabled } from '../hooks/plugin-project-state.js';
import { readDaemonSettings } from './settings.js';
import { defaultProjectOpener } from './opener.js';
import { claudeLivenessById, pidAliveOf } from './claude-liveness.js';

/**
 * D3 hooks 系统的全部 HTTP 路由（规则 CRUD/toggle、派发查询、会话列表/改名）。
 * 从 server.ts 主路由链中调用；返回 false 表示未命中，主链继续分发。
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

/** 插件级开关：可选 projectId = 项目覆盖（写 meta.plugins.enabled，不动全局）。 */
const PluginToggleBody = z.object({ enabled: z.boolean(), projectId: z.number().int().optional() });

const RenameSessionBody = z.object({ title: z.string().min(1).max(200) });

const RunDispatchBody = z.object({ sessionId: z.string().min(1) });

const InstallBody = z.object({ src: z.string().min(1) });

export async function handleHooksRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  const isHooksPath =
    pathname.startsWith('/hooks/') ||
    pathname === '/sessions' ||
    pathname.startsWith('/sessions/');
  if (!isHooksPath) return false;

  // ---- 规则 CRUD ----
  if (pathname === '/hooks/rules') {
    if (!deps.hookRegistry) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    if (req.method === 'GET') {
      const projectIdRaw = url.searchParams.get('projectId');
      const projectId = projectIdRaw != null && projectIdRaw !== '' ? Number(projectIdRaw) : undefined;
      sendJson(res, 200, { rules: deps.hookRegistry.list(projectId) });
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = CreateRuleBody.parse(await readJson(req));
        const rule = deps.hookRegistry.create(body);
        sendJson(res, 201, { rule });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid rule body' });
      }
      return true;
    }
  }

  const ruleMatch = pathname.match(/^\/hooks\/rules\/([^/]+)$/);
  if (ruleMatch) {
    if (!deps.hookRegistry) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const id = decodeURIComponent(ruleMatch[1]!);
    if (req.method === 'PUT') {
      try {
        const patch = UpdateRuleBody.parse(await readJson(req));
        const rule = deps.hookRegistry.update(id, patch);
        if (!rule) {
          sendJson(res, 404, { error: 'Rule not found' });
          return true;
        }
        sendJson(res, 200, { rule });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid rule body' });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      if (!deps.hookRegistry.remove(id)) {
        sendJson(res, 404, { error: 'Rule not found' });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  const toggleMatch = pathname.match(/^\/hooks\/rules\/([^/]+)\/toggle$/);
  if (toggleMatch && req.method === 'POST') {
    if (!deps.hookRegistry) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    try {
      const body = ToggleBody.parse(await readJson(req));
      const rule = deps.hookRegistry.setEnabled(decodeURIComponent(toggleMatch[1]!), body.enabled);
      if (!rule) {
        sendJson(res, 404, { error: 'Rule not found' });
        return true;
      }
      sendJson(res, 200, { rule });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  // ---- 插件管理面（SPI 加载结果 + 插件级开关 + 安装/卸载）----
  if (pathname === '/hooks/plugins') {
    if (req.method === 'GET') {
      const projectIdRaw = url.searchParams.get('projectId');
      if (projectIdRaw == null || projectIdRaw === '') {
        sendJson(res, 200, { plugins: deps.hookPlugins?.list() ?? [] });
        return true;
      }
      const project = deps.projects.getById(Number(projectIdRaw));
      if (!project) {
        sendJson(res, 404, { error: 'Project not found' });
        return true;
      }
      if (!deps.pluginStates) {
        sendJson(res, 503, { error: 'Plugin states unavailable' });
        return true;
      }
      const states = deps.pluginStates;
      sendJson(res, 200, {
        plugins: (deps.hookPlugins?.list() ?? []).map((info) => {
          if (info.status === 'rejected') return info;
          const status = effective(project, info.id, { states }) ? 'active' : 'disabled';
          return status === info.status ? info : { ...info, status };
        }),
      });
      return true;
    }
    if (req.method === 'POST') {
      // 安装：body { src } = 本地路径 | git URL → 复制进全局插件根 → 立即重扫
      if (!deps.hookPlugins) {
        sendJson(res, 503, { error: 'Plugin loader unavailable' });
        return true;
      }
      try {
        const body = InstallBody.parse(await readJson(req));
        const result = await installPlugin(body.src);
        await deps.hookPlugins.reloadAll();
        sendJson(res, 201, result);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Install failed' });
      }
      return true;
    }
  }

  const pluginUninstallMatch = pathname.match(/^\/hooks\/plugins\/([^/]+)\/uninstall$/);
  if (pluginUninstallMatch && req.method === 'POST') {
    if (!deps.hookPlugins) {
      sendJson(res, 503, { error: 'Plugin loader unavailable' });
      return true;
    }
    const id = decodeURIComponent(pluginUninstallMatch[1]!);
    const removed = await uninstallPlugin(id);
    if (!removed) {
      sendJson(res, 404, { error: 'Plugin directory not found' });
      return true;
    }
    await deps.hookPlugins.reloadAll();
    sendJson(res, 200, { ok: true });
    return true;
  }

  const pluginToggleMatch = pathname.match(/^\/hooks\/plugins\/([^/]+)\/toggle$/);
  if (pluginToggleMatch && req.method === 'POST') {
    if (!deps.hookPlugins) {
      sendJson(res, 503, { error: 'Plugin loader unavailable' });
      return true;
    }
    try {
      const body = PluginToggleBody.parse(await readJson(req));
      const id = decodeURIComponent(pluginToggleMatch[1]!);
      if (body.projectId !== undefined) {
        const project = deps.projects.getById(body.projectId);
        if (!project) {
          sendJson(res, 404, { error: 'Project not found' });
          return true;
        }
        if (!deps.hookPlugins.list().some((p) => p.id === id)) {
          sendJson(res, 404, { error: 'Plugin not found' });
          return true;
        }
        setProjectEnabled(project, id, body.enabled, { projects: deps.projects });
        sendJson(res, 200, { ok: true });
        return true;
      }
      const ok = deps.hookPlugins.setPluginEnabled(id, body.enabled);
      if (!ok) {
        sendJson(res, 404, { error: 'Plugin not found' });
        return true;
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  // ---- 派发记录 ----
  if (pathname === '/hooks/dispatches' && req.method === 'GET') {
    if (!deps.hookDispatches) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const ruleId = url.searchParams.get('ruleId') ?? undefined;
    const statusRaw = url.searchParams.get('status');
    const status = statusRaw ? HookDispatchStatusSchema.parse(statusRaw) : undefined;
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    sendJson(res, 200, {
      dispatches: deps.hookDispatches.list({
        ruleId,
        status,
        sessionId,
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    });
    return true;
  }

  // ---- 指令池 resume：spawn claude --resume 后立即返回（「已启动」语义）----
  const runMatch = pathname.match(/^\/hooks\/dispatches\/(\d+)\/run$/);
  if (runMatch && req.method === 'POST') {
    if (!deps.hookRunner) {
      sendJson(res, 503, { error: 'Resume runner unavailable' });
      return true;
    }
    let sessionId: string;
    try {
      sessionId = RunDispatchBody.parse(await readJson(req)).sessionId;
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      return true;
    }
    const result = await deps.hookRunner.run(Number(runMatch[1]!), sessionId);
    if (result.ok) {
      sendJson(res, 200, { ok: true, dispatchId: result.dispatchId });
    } else {
      sendJson(res, result.status, { error: result.error });
    }
    return true;
  }

  // ---- 会话列表 / 改名 ----
  if (pathname === '/sessions' && req.method === 'GET') {
    if (!deps.hookSessions) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const projectIdRaw = url.searchParams.get('projectId');
    const projectId = projectIdRaw != null && projectIdRaw !== '' ? Number(projectIdRaw) : undefined;
    const sessions = deps.hookSessions.listWithCounts(projectId);
    // claude 注册表判活随返回：true/false=判得动，null=判不动（codex/新鲜会话）不猜
    const liveness = claudeLivenessById();
    sendJson(res, 200, {
      sessions: sessions.map((s) => ({ ...s, pidAlive: pidAliveOf(s, liveness) })),
    });
    return true;
  }

  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === 'PATCH') {
    if (!deps.hookSessions) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    if (!deps.hookSessions.getBySessionId(sessionId)) {
      sendJson(res, 404, { error: 'Session not found' });
      return true;
    }
    try {
      const body = RenameSessionBody.parse(await readJson(req));
      const session = deps.hookSessions.setPendingTitle(sessionId, body.title);
      // 改名挂起/撤销即时进 mirror——不然要等到下一个 hook 事件才同步
      if (session?.projectId != null) deps.hookMirror?.syncProject(session.projectId);
      sendJson(res, 200, { session });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
    }
    return true;
  }

  // ---- 删会话（手动）：会话行 + 该会话的采集事件 + 指令池派发一并清 ----
  if (sessionMatch && req.method === 'DELETE') {
    if (!deps.hookSessions || !deps.hookEvents) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    const session = deps.hookSessions.getBySessionId(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found' });
      return true;
    }
    const purged = purgeSession(
      { sessions: deps.hookSessions, events: deps.hookEvents, dispatches: deps.hookDispatches },
      sessionId,
    );
    if (session.projectId != null) deps.hookMirror?.syncProject(session.projectId);
    sendJson(res, 200, { ok: true, sessionId, ...purged });
    return true;
  }

  // ---- 在默认终端打开会话：spawn 独立终端跑 harness 交互式 resume（如
  // `claude --resume <id>`）——opener 的 detached+unref 保证进程不随 daemon 退出 ----
  const openTermMatch = pathname.match(/^\/sessions\/([^/]+)\/open-terminal$/);
  if (openTermMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(openTermMatch[1]!);
    if (!deps.hookSessions) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const session = deps.hookSessions.getBySessionId(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found' });
      return true;
    }
    if (!deps.hookEvents) {
      sendJson(res, 503, { error: 'Hook ingestion unavailable' });
      return true;
    }
    // harness 归属 = 最新事件 source（与 sessions 列表的计算字段同口径）
    const latest = deps.hookEvents.listBySession(sessionId, 1);
    const src = latest[latest.length - 1]?.source;
    if (src !== 'claude' && src !== 'codex') {
      sendJson(res, 400, { error: 'Session has no hook events to determine its harness' });
      return true;
    }
    // 交互式 resume 形态来自 harness 能力槽（server 不写 harness 命令硬编码）
    const spec = deps.harnesses?.get(src)?.resume;
    if (!spec?.supported || !spec.openArgs) {
      sendJson(res, 501, { error: `Harness "${src}" does not support interactive resume` });
      return true;
    }
    if (!session.projectId) {
      sendJson(res, 400, { error: 'Session is not bound to a project' });
      return true;
    }
    const project = deps.projects.getById(session.projectId);
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    const opener = deps.opener ?? defaultProjectOpener;
    // 多终端弹窗选定的目标（可选）：定点附加到那个 tab；缺省 = 自动选落点。
    let target: string | undefined;
    if (req.method === 'POST') {
      try {
        const raw = (await readJson(req)) as { target?: unknown };
        if (typeof raw?.target === 'string' && raw.target) target = raw.target;
      } catch {
        // 空 body 合法（老前端不带 body）——不是 JSON 就当没给 target
      }
    }
    try {
      const info = await stat(project.path);
      if (!info.isDirectory()) throw new Error(`Not a directory: ${project.path}`);
      const settings = await readDaemonSettings();
      const argv = [spec.bin, ...spec.openArgs(sessionId)];
      if (target) {
        // 定点附加只有 wezterm mux 有 pane 通道；其它 preset 明确拒绝而非静默忽略。
        if (settings.terminal.preset !== 'wezterm' && settings.terminal.preset !== 'auto') {
          throw new Error(
            `Terminal preset "${settings.terminal.preset}" cannot attach to a chosen pane — pick wezterm in settings`,
          );
        }
        const runAt = opener.runInTerminalAt;
        if (!runAt) throw new Error('Targeted attach is unavailable');
        await runAt(project.path, argv, target);
      } else {
        await opener.runInTerminal(project.path, argv, settings.terminal);
      }
      sendJson(res, 200, {
        ok: true,
        sessionId,
        command: argv.join(' '),
        cwd: project.path,
        ...(target ? { target } : {}),
      });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Open failed' });
    }
    return true;
  }

  return false;
}
