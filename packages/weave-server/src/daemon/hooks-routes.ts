import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  HookRuleFilterSchema,
  HookRuleSourceSchema,
  HandlerConfigSchema,
  HookDispatchStatusSchema,
  isHarness,
} from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import type { WeaveServerDeps } from './server.js';
import { readJson, sendJson } from './http.js';
import { installPlugin, uninstallPlugin } from '../hooks/plugin-installer.js';
import { purgeSession } from '../hooks/session-purge.js';
import { effective, setProjectEnabled } from '../hooks/plugin-project-state.js';
import { readDaemonSettings } from './settings.js';
import { defaultProjectOpener, terminalBackendFor } from './opener.js';
import { claudeLivenessById, pidAliveOf } from './claude-liveness.js';
import { messagingSurfaceFor, messagingSurfaces } from '../surfaces.js';
import { DEFAULT_WATCH_ON } from '../repositories/session-watches.js';
import { SEQUENCE_HOP_LIMIT } from '../hooks/sequence-engine.js';

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

/** 点对点消息投递（消息域重塑）：无模式入参——恒走 prompt 通道三层递送
 * （默认 = 原生 SendMessage 中继 + 未开会话积压队列；降级 = 终端 send-text，
 * 全自动）。inject/headless/auto 只活在编排域（序列步显式选项）。 */
const SendMessageBody = z.object({
  text: z.string().min(1).max(20_000),
  fromKind: z.enum(['dashboard', 'session']).optional(),
  fromSessionId: z.string().min(1).nullable().optional(),
});

/** 会话订阅：watcherSessionId 缺省 null = dashboard 订阅（fire 走 toast + 浏览器通知）；
 *  on = 触发类型集（缺省 idle，批 2 语义）。 */
const CreateWatchBody = z.object({
  watcherSessionId: z.string().min(1).nullable().optional(),
  notify: z.string().min(1).max(20_000).nullable().optional(),
  on: z.array(z.enum(['idle', 'turnEnd', 'messageFailed'])).min(1).optional(),
  /** 提醒次数：1..100；null = 持久化（不自动失效）；缺省 1（一次）。 */
  times: z.number().int().min(1).max(100).nullable().optional(),
});

const DeleteWatchBody = z.object({ watchId: z.number().int().positive() });

/** 跨会话序列（批 3）：步数上限单独校验（错误文案要带 hop limit 语义）。 */
const CreateSequenceBody = z.object({
  name: z.string().max(200).optional(),
  steps: z
    .array(
      z.object({
        to: z.string().min(1),
        text: z.string().min(1).max(20_000),
        mode: z.enum(['prompt', 'inject', 'headless', 'auto']).optional(),
      }),
    )
    .min(1),
});

const InstallBody = z.object({ src: z.string().min(1) });

/** prompt 通道可用性（与投递裁决同口径）：层① 原生中继 || 层② 终端 send-text 兜底。 */
function promptChannelOf(surface: MessagingSurface, terminalChannel: boolean): boolean {
  return surface.prompt !== null || terminalChannel;
}

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
    pathname.startsWith('/sessions/') ||
    pathname.startsWith('/messaging');
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
    // （在途消息角标不在这里：走 SSE push 'inflightCounts'，见 InflightCountsRefresher）
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
      {
        sessions: deps.hookSessions,
        events: deps.hookEvents,
        dispatches: deps.hookDispatches,
        deliverer: deps.messageDeliverer,
        watches: deps.sessionWatches,
      },
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
    if (!isHarness(src)) {
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
        // 定点附加的能力归后端：能反查目标的 preset 才有定点通道（wezterm mux /
        // Terminal.app osascript / wt 进程表），其余明确拒绝而非静默忽略——调用方不列白名单。
        if (!terminalBackendFor(settings.terminal).enumerable) {
          throw new Error(
            `Terminal preset "${settings.terminal.preset}" cannot attach to a chosen pane — pick wezterm, wt or Terminal.app in settings`,
          );
        }
        const runAt = opener.runInTerminalAt;
        if (!runAt) throw new Error('Targeted attach is unavailable');
        await runAt(project.path, argv, target, settings.terminal);
      } else {
        await opener.runInTerminal(project.path, argv, settings.terminal);
      }
      // 角标立刻对账，不等隐藏刷新的下一个周期
      void deps.terminalRefresher?.refreshNow();
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

  // ---- 消息域（消息域重塑：纯递送管道）：在途视图读 + 投递 ----
  const messagesMatch = pathname.match(/^\/sessions\/([^/]+)\/messages$/);
  if (messagesMatch) {
    const sessionId = decodeURIComponent(messagesMatch[1]!);
    if (req.method === 'GET') {
      if (!deps.messageDeliverer) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      if (!deps.hookSessions?.getBySessionId(sessionId)) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      sendJson(res, 200, { messages: deps.messageDeliverer.listVisible(sessionId) });
      return true;
    }
    if (req.method === 'POST') {
      if (!deps.messageDeliverer || !deps.hookSessions) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      let body: z.infer<typeof SendMessageBody>;
      try {
        body = SendMessageBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      const result = await deps.messageDeliverer.send({
        toSessionId: sessionId,
        text: body.text,
        mode: 'prompt',
        fromKind: body.fromKind ?? 'dashboard',
        fromSessionId: body.fromSessionId ?? null,
        // 手动面 = 单向注入：没有接收方会话，中继载荷带「无需回复」注记
        // （编排域不置 = 双向对话保留）。
        oneWay: true,
      });
      if (result.ok) {
        sendJson(res, 201, {
          ok: true,
          messageId: result.messageId,
          status: result.status,
          message: result.message,
        });
      } else {
        sendJson(res, result.status, { error: result.error });
      }
      return true;
    }
  }

  // ---- 手动重发（暂停闸解除动作）：prompt 通道 failed / delivered-未回执 才可重发 ----
  const resendMatch = pathname.match(/^\/sessions\/([^/]+)\/messages\/([^/]+)\/resend$/);
  if (resendMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const result = await deps.messageDeliverer.resend(decodeURIComponent(resendMatch[2]!));
    if (result.ok) {
      sendJson(res, 200, { ok: true, messageId: result.messageId, status: result.status, message: result.message });
    } else {
      sendJson(res, result.status, { error: result.error });
    }
    return true;
  }

  // ---- 空闲订阅域（session-orchestration 批 2）：one-shot「空闲时提醒我」 ----
  const watchMatch = pathname.match(/^\/sessions\/([^/]+)\/watch$/);
  if (watchMatch) {
    const sessionId = decodeURIComponent(watchMatch[1]!);
    if (req.method === 'POST') {
      if (!deps.sessionWatches || !deps.hookSessions || !deps.hookEvents) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      let body: z.infer<typeof CreateWatchBody>;
      try {
        body = CreateWatchBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      const target = deps.hookSessions.getBySessionId(sessionId);
      if (!target) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      // 目标 harness = 最新事件 source（与 open-terminal / 消息投递同口径）
      const latest = deps.hookEvents.listBySession(sessionId, 1);
      const targetSrc = latest[latest.length - 1]?.source;
      if (!isHarness(targetSrc)) {
        sendJson(res, 400, { error: 'Session has no hook events to determine its harness' });
        return true;
      }
      const targetSurface = messagingSurfaceFor(targetSrc);
      const on = body.on ?? [...DEFAULT_WATCH_ON];
      // 按订阅类型逐个验通道：空闲/回合结束要 idleSignals（批 2 判据）；
      // 投递失败要该会话「可被投递」（prompt 列 || inject/headless），否则永不可达。
      if ((on.includes('idle') || on.includes('turnEnd')) && targetSurface.idleSignals.length === 0) {
        sendJson(
          res,
          409,
          { error: targetSurface.unsupportedReasons?.watch ?? `Harness "${targetSrc}" does not support idle watching` },
        );
        return true;
      }
      if (on.includes('messageFailed')) {
        const messageable =
          promptChannelOf(targetSurface, deps.messageDeliverer?.hasTerminalChannel() ?? false) ||
          targetSurface.inject !== null ||
          targetSurface.headless !== null;
        if (!messageable) {
          sendJson(res, 409, {
            error:
              targetSurface.unsupportedReasons?.prompt ??
              `Harness "${targetSrc}" supports no messaging channel`,
          });
          return true;
        }
      }
      // 会话订阅方：通知注入它的 inject 通道必须在场（否则 fire 时必然无声丢弃）
      if (body.watcherSessionId) {
        const watcher = deps.hookSessions.getBySessionId(body.watcherSessionId);
        if (!watcher) {
          sendJson(res, 404, { error: 'Watcher session not found' });
          return true;
        }
        const watcherLatest = deps.hookEvents.listBySession(body.watcherSessionId, 1);
        const watcherSrc = watcherLatest[watcherLatest.length - 1]?.source;
        if (!isHarness(watcherSrc)) {
          sendJson(res, 400, { error: 'Watcher session has no hook events to determine its harness' });
          return true;
        }
        const watcherSurface = messagingSurfaceFor(watcherSrc);
        if (!watcherSurface.inject) {
          sendJson(
            res,
            409,
            { error: watcherSurface.unsupportedReasons?.inject ?? `Harness "${watcherSrc}" cannot receive watch notifications` },
          );
          return true;
        }
      }
      const watch = deps.sessionWatches.insert({
        watcherSessionId: body.watcherSessionId ?? null,
        targetSessionId: sessionId,
        notify: body.notify ?? null,
        onEvents: on,
        times: body.times === undefined ? 1 : body.times,
      });
      // 目标此刻已空闲 → 立即 fire（不等下一拍；one-shot 语义即「答案就是现在」）
      deps.watchEngine?.created(watch);
      sendJson(res, 201, { ok: true, watchId: watch.id, watch });
      return true;
    }
    if (req.method === 'DELETE') {
      if (!deps.sessionWatches) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      let body: z.infer<typeof DeleteWatchBody>;
      try {
        body = DeleteWatchBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      const row = deps.sessionWatches.getById(body.watchId);
      if (!row || row.targetSessionId !== sessionId || row.firedAt !== null) {
        sendJson(res, 404, { error: 'Watch not found' });
        return true;
      }
      deps.sessionWatches.deleteById(body.watchId);
      sendJson(res, 200, { ok: true, watchId: body.watchId });
      return true;
    }
  }

  // ---- 订阅面查询：pending 全量（web 按 watcherSessionId 过滤 dashboard 行） ----
  if (pathname === '/messaging/watches' && req.method === 'GET') {
    if (!deps.sessionWatches) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    sendJson(res, 200, { watches: deps.sessionWatches.listPending() });
    return true;
  }

  // ---- 序列域（session-orchestration 批 3）：手工编排多步链 A→B→C ----
  if (pathname === '/messaging/sequences') {
    if (req.method === 'GET') {
      if (!deps.sessionSequences) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      sendJson(res, 200, { sequences: deps.sessionSequences.list() });
      return true;
    }
    if (req.method === 'POST') {
      if (!deps.sessionSequences || !deps.sequenceEngine || !deps.hookSessions || !deps.hookEvents) {
        sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
        return true;
      }
      let body: z.infer<typeof CreateSequenceBody>;
      try {
        body = CreateSequenceBody.parse(await readJson(req));
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
        return true;
      }
      if (body.steps.length > SEQUENCE_HOP_LIMIT) {
        sendJson(res, 400, {
          error: `Sequences are capped at ${SEQUENCE_HOP_LIMIT} steps (hop limit)`,
        });
        return true;
      }
      // 全部目标前置校验（每步 404/400/409 指明步号）：中途失败 = 步 1 已发出去、
      // 链断在半路，比创建前拒绝差得多——宁可先验完再触发步 0。
      // 按步的 mode 检验对应通道（prompt = 原生中继 || 终端兜底，与能力矩阵同源）。
      const terminalChannel = deps.messageDeliverer?.hasTerminalChannel() ?? false;
      for (let i = 0; i < body.steps.length; i++) {
        const step = body.steps[i]!;
        const target = deps.hookSessions.getBySessionId(step.to);
        if (!target) {
          sendJson(res, 404, { error: `Step ${i + 1}: session not found` });
          return true;
        }
        const latest = deps.hookEvents.listBySession(step.to, 1);
        const src = latest[latest.length - 1]?.source;
        if (!isHarness(src)) {
          sendJson(res, 400, { error: `Step ${i + 1}: session has no hook events to determine its harness` });
          return true;
        }
        const surface = messagingSurfaceFor(src);
        const mode = step.mode ?? 'auto';
        const supported =
          mode === 'prompt'
            ? promptChannelOf(surface, terminalChannel)
            : mode === 'inject'
              ? surface.inject !== null
              : mode === 'headless'
                ? surface.headless !== null
                : surface.inject !== null || surface.headless !== null;
        if (!supported) {
          const why =
            mode === 'auto'
              ? surface.unsupportedReasons?.inject ?? `Harness "${src}" supports no messaging channel`
              : surface.unsupportedReasons?.[mode] ?? `Harness "${src}" does not support the ${mode} channel`;
          sendJson(res, 409, { error: `Step ${i + 1}: ${why}` });
          return true;
        }
      }
      const sequence = deps.sessionSequences.insert({
        name: body.name ?? '',
        steps: body.steps.map((step) => ({ ...step, mode: step.mode ?? 'auto' })),
      });
      await deps.sequenceEngine.trigger(sequence);
      // trigger 后重读：响应即带步 0 的 messageId（web 画布直接渲染首步边）
      sendJson(res, 201, { ok: true, sequence: deps.sessionSequences.getById(sequence.id) ?? sequence });
      return true;
    }
  }

  const sequenceMatch = pathname.match(/^\/messaging\/sequences\/(\d+)$/);
  if (sequenceMatch && req.method === 'DELETE') {
    if (!deps.sessionSequences) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const row = deps.sessionSequences.getById(Number(sequenceMatch[1]));
    if (!row) {
      sendJson(res, 404, { error: 'Sequence not found' });
      return true;
    }
    if (row.status !== 'running') {
      sendJson(res, 409, { error: `Sequence already ${row.status}` });
      return true;
    }
    if (deps.sequenceEngine) deps.sequenceEngine.cancel(row.id);
    else deps.sessionSequences.finish(row.id, 'cancelled');
    sendJson(res, 200, { ok: true, sequenceId: row.id });
    return true;
  }

  // ---- 能力矩阵：纯派生自 MessagingSurface + 终端通道装配态（无第二事实源） ----
  if (pathname === '/messaging/capabilities' && req.method === 'GET') {
    // prompt 列 = 层① 原生中继 || 层② 终端 send-text 兜底（随 settings/机器变）。
    const terminalChannel = deps.messageDeliverer?.hasTerminalChannel() ?? false;
    sendJson(res, 200, {
      capabilities: messagingSurfaces().map(({ harness, surface }) => ({
        harness,
        discovery: surface.discovery,
        prompt: promptChannelOf(surface, terminalChannel),
        inject: surface.inject !== null,
        headless: surface.headless !== null,
        watch: surface.idleSignals.length > 0,
        unsupportedReasons: surface.unsupportedReasons ?? null,
      })),
    });
    return true;
  }

  return false;
}
