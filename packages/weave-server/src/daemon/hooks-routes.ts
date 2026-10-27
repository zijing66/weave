import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  HARNESS_SESSION_CONTROL,
  isHarness,
  type Harness,
} from '@weavecode/core';
import {
  aliasOfModel,
  modelAliasTargets,
  type CaptureScriptHealth,
  type MessagingSurface,
  type ModelAliasTarget,
} from '@weavecode/harness';

import type { WeaveServerDeps } from './server.js';
import type { MessageAttachment, SessionDeliveryDiagnosis } from '../hooks/message-deliverer.js';
import { readJson, sendJson } from './http.js';
import { purgeSession } from '../hooks/session-purge.js';
import { readDaemonSettingsSync, readHooksEnabled } from './settings.js';
import { handleOrchestrationRoutes } from './routes/orchestration.js';
import { handleHookAdminRoutes } from './routes/hooks-admin.js';
import { handleUploadRoutes } from './routes/uploads.js';
import { handleSessionControlRoutes } from './routes/session-control.js';
import { handlePathRefRoutes } from './routes/path-refs.js';
import { handleSessionInsightRoutes } from './routes/session-insights.js';
import { handleWatchRoutes } from './routes/watches.js';
import { openSessionTerminal, transcriptState } from './session-open.js';
import { pidAliveOf } from './claude-liveness.js';
import { combinedLivenessOf } from './liveness.js';
import {
  captureSurfaces,
  messagingSurfaces,
  sessionTitleSurfaceFor,
} from '../surfaces.js';
import { getDataDir } from '../db/paths.js';
import { WEAVE_VERSION } from '../version.js';

/**
 * D3 hooks 系统的全部 HTTP 路由（规则 CRUD/toggle、派发查询、会话列表/改名）。
 * 从 server.ts 主路由链中调用；返回 false 表示未命中，主链继续分发。
 */

const RenameSessionBody = z.object({ title: z.string().min(1).max(200) });

/** 点对点消息投递（消息域重塑）：无模式入参——恒走 prompt 通道三层递送
 * （默认 = 原生 SendMessage 中继 + 未开会话积压队列；降级 = 终端 send-text，
 * 全自动）。inject/headless/auto 只活在编排域（序列步显式选项）。 */
const SendMessageBody = z.object({
  text: z.string().max(20_000),
  fromKind: z.enum(['dashboard', 'session']).optional(),
  fromSessionId: z.string().min(1).nullable().optional(),
  /** 随附文件（上传件 id）；带文件且目标 harness 的 `attach` 面不收该类型即 409。 */
  attachments: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8).optional(),
  /** 旧名（图片随附）；与 `attachments` 等价，读侧合并。 */
  images: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8).optional(),
  /** 强制层② 终端 send-text（发送人下拉选的通道；缺省 = 直投优先的自动层序）。 */
  forceTerminal: z.boolean().optional(),
});

/** prompt 通道可用性（与投递裁决同口径）：宿主队列 || 层① 原生中继 || 层② 终端 send-text 兜底。 */
function promptChannelOf(surface: MessagingSurface, terminalChannel: boolean): boolean {
  return surface.queuedPrompt !== null || surface.prompt !== null || terminalChannel;
}

/**
 * 投递诊断的「修法码」：每条 = 一个「消息为什么送不到」的成因（判定条件见
 * `MessageDeliverer.diagnose` 与 `CaptureScriptHealth`）。只出机器码，文案归 CLI/web。
 * 与通道 reason 重叠的不重复报（脚本压根不上报时，「没凭据」不是独立成因）。
 */
function deliveryHints(input: {
  diag: SessionDeliveryDiagnosis | null;
  capture: CaptureScriptHealth | null;
  eventCount: number;
}): string[] {
  const { diag, capture, eventCount } = input;
  const hints: string[] = [];
  if (!capture || capture.source === 'none' || !capture.present) hints.push('no-hook-script');
  else if (!capture.weaveOwned) hints.push('hook-script-not-weave');
  // 只有「该 harness 本来就有会话 inbox 通道」时，脚本不上报凭据才算陈旧——
  // 没有这个通道的 harness（codex）恒不上报，不是成因。
  else if (!capture.reportsInbox && diag?.inbox.reason !== 'no-mechanism') hints.push('hook-script-stale');
  if (eventCount === 0) hints.push('no-events');
  if (!diag) return hints;
  if (diag.alive === false) hints.push('not-running');
  if (diag.inbox.reason === 'no-credentials' && capture?.reportsInbox === true) {
    hints.push('no-inbox-credentials');
  }
  if (diag.inbox.reason === 'auth-token-required') hints.push('inbox-token-required');
  if (diag.relay.reason === 'no-peer-name') hints.push('no-peer-name');
  if (diag.terminal.reason === 'no-backend') hints.push('terminal-no-backend');
  if (diag.terminal.reason === 'no-pane-env') hints.push('terminal-no-pane-env');
  if (diag.pending > 0) hints.push('queued');
  if (diag.stalled) hints.push('stalled');
  return hints;
}

export async function handleHooksRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  // 本路由器认领的路径前缀：漏一个就整条路由死在门外（2026-10-17 /uploads 与
  // /images 就是这么死的——分支写好了却没进这张表，一律 404 Not found）。
  const isOwnedPath =
    pathname.startsWith('/hooks/') ||
    pathname === '/dashboard/refresh' ||
    pathname === '/sessions' ||
    pathname.startsWith('/sessions/') ||
    pathname.startsWith('/messaging') ||
    pathname.startsWith('/webhooks/orchestrate/') ||
    pathname === '/uploads' ||
    pathname.startsWith('/uploads/') ||
    pathname.startsWith('/images/');
  if (!isOwnedPath) return false;

  // ---- hooks 管理域 → routes/hooks-admin.ts（规则 CRUD/插件面/派发/指令池）----
  if (await handleHookAdminRoutes(req, res, deps, pathname, url)) return true;

  // ---- 会话列表 / 改名 ----
  // POST /dashboard/refresh — 空载荷的「重推一次」触发：SSE 连接早于仪表盘挂载，
  // 首连推送的分块会被错过；挂载时打这一枪让服务端按需重发（数据仍走 SSE）。
  if (pathname === '/dashboard/refresh' && req.method === 'POST') {
    deps.dashboardRefresh?.();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/sessions' && req.method === 'GET') {
    if (!deps.hookSessions) {
      sendJson(res, 503, { error: 'Hooks subsystem unavailable' });
      return true;
    }
    const projectIdRaw = url.searchParams.get('projectId');
    const projectId = projectIdRaw != null && projectIdRaw !== '' ? Number(projectIdRaw) : undefined;
    const sessions = deps.hookSessions.listWithCounts(projectId);
    // 判活随返回（claude 注册表 + codex 锁探针缓存）：true/false=判得动，
    // null=判不动（新鲜会话）不猜
    // （在途消息角标不在这里：走 SSE push 'inflightCounts'，见 InflightCountsRefresher）
    const liveness = combinedLivenessOf();
    // 会话所在可见屏幕（列表分块）：探测要吃子进程，只能回隐藏刷新器的**上次快照**
    // （null = 反查不到，不分组），增量经 push 'terminalTopology' 到达——同角标口径。
    const screens = deps.terminalRefresher?.lastSnapshot?.terminals ?? {};
    // 模型别名 → 真名（claude 的 `ANTHROPIC_DEFAULT_<别名>_MODEL` 约定）：下拉要两个
    // 都摆，转录里照会的真名也得认回别名那档。按 harness 分面，各问各的词表。
    const catalog: Record<string, ModelAliasTarget[]> = {};
    for (const s of sessions) {
      const key = s.harness ?? '';
      if (key in catalog) continue;
      catalog[key] = modelAliasTargets(HARNESS_SESSION_CONTROL[s.harness as Harness]?.modelNames ?? []);
    }
    sendJson(res, 200, {
      sessions: sessions.map((s) => {
        const model = deps.sessionProbe?.currentModel(s.sessionId) ?? null;
        const present = deps.sessionProbe?.transcriptPresent(s.sessionId) ?? null;
        // 「在终端打开」的能力位：harness 的 resume 槽声明了交互式 openArgs 才有。
        // web 只渲染这个字段，不自带 harness 白名单（路由侧仍做同样的 501 校验）。
        const resume = isHarness(s.harness) ? deps.harnesses?.get(s.harness)?.resume : undefined;
        return {
          ...s,
          pidAlive: pidAliveOf(s, liveness),
          canOpenTerminal: !!(resume?.supported && resume.openArgs),
          terminal: screens[s.sessionId] ?? null,
          // 已中断（转录最后一条标记晚于最后一条事件）：只有「看着还在跑」的会话才现算
          interruptedAt:
            s.turnOpen === true ? (deps.sessionProbe?.interruptedAt(s.sessionId, s.lastSeenAt) ?? null) : null,
          // 当前模型：换模型落定由 `PostModelSwitch` 先说（标签立刻跟得上），转录
          // 只在 assistant 消息上照会——两边取更晚的那个；null = 不知道（不猜）。
          model,
          // 同一个模型的**别名**（`/model` 收的那个）：网关把别名换成自家 ID，转录里
          // 只见真名；认不出 = null，前端回落显示真名。
          modelAlias: aliasOfModel(catalog[s.harness ?? ''] ?? [], model),
          // 执行模式（事件自带的 permission_mode 优先、转录兜底）：切模式既不落转录、
          // 也没有专门事件，故是「最后已知」。
          mode: deps.sessionProbe?.currentMode(s.sessionId) ?? null,
          // 推理档位（hook 事件自带的 `effort.level`）：状态栏 `thinking` 块的事实，
          // 与模型/模式同口径（只放内存、最后已知、没上报过即 null）。
          effort: deps.sessionProbe?.currentEffort(s.sessionId) ?? null,
          // 上下文窗口占用（转录最后一条 assistant 的 usage 四项之和，「上一轮完成
          // 时」）：对话页摆当前上下文读数用；没跑过一轮 / 没转录 = null。
          contextTokens: deps.sessionProbe?.currentContextTokens(s.sessionId) ?? null,
          // 转录还在不在（与 `claude --resume` 认的那份文件对齐）：false = 接不回来了，
          // 行内给提示、「打开」禁用；null = 判不动（该 harness 没有转录概念，或这个
          // 会话还没跑过——刚建的会话转录文件尚未写入，没内容不等于丢过）。
          transcriptPresent: transcriptState(present, s.hasRun),
        };
      }),
      modelCatalog: catalog,
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
      // 宿主侧名字通道（titles 面，codex = thread/name/set）：写宿主成功才落库，
      // 不挂 pending——该通道无 hook 回执，挂了永不 confirm、徽标常驻。失败如实报错。
      const latest = deps.hookEvents?.listBySession(sessionId, 1);
      const src = latest?.[latest.length - 1]?.source;
      const titleSurface = isHarness(src) ? sessionTitleSurfaceFor(src) : null;
      if (titleSurface) {
        try {
          await titleSurface.setSessionTitle(sessionId, body.title);
        } catch (err) {
          sendJson(res, 502, { error: err instanceof Error ? err.message : 'Host rename failed' });
          return true;
        }
        const session = deps.hookSessions.setTitle(sessionId, body.title);
        if (session?.projectId != null) deps.hookMirror?.syncProject(session.projectId);
        sendJson(res, 200, { session });
        return true;
      }
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
        orchestrations: deps.orchestrations,
        questions: deps.questionTracker,
        sideQuestions: deps.sideQuestions?.repo,
        probe: deps.sessionProbe,
        uploads: deps.uploads,
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
    // 多终端弹窗选定的目标（可选）：定点附加到那个 tab；缺省 = 自动选落点。
    let target: string | undefined;
    try {
      const raw = (await readJson(req)) as { target?: unknown };
      if (typeof raw?.target === 'string' && raw.target) target = raw.target;
    } catch {
      // 空 body 合法（老前端不带 body）——不是 JSON 就当没给 target
    }
    const result = await openSessionTerminal(deps, sessionId, target);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      sessionId: result.sessionId,
      command: result.command,
      cwd: result.cwd,
      ...(result.target ? { target: result.target } : {}),
    });
    return true;
  }

  // ---- 上传域 → routes/uploads.ts（分块/一次性上传、附件清理、图片回显）----
  if (await handleUploadRoutes(req, res, deps, pathname, url)) return true;

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
      // 两种入参名并存：`attachments` 是新名，`images` 是既有调用方的旧名
      const attachmentIds = [...(body.attachments ?? []), ...(body.images ?? [])];
      if (!body.text.trim() && attachmentIds.length === 0) {
        sendJson(res, 400, { error: 'Message is empty' });
        return true;
      }
      let attachments: MessageAttachment[] = [];
      if (attachmentIds.length > 0) {
        const refs = deps.uploads?.refsOf(attachmentIds) ?? null;
        if (!refs) {
          sendJson(res, 404, { error: 'Attachment not found' });
          return true;
        }
        attachments = refs;
      }
      const result = await deps.messageDeliverer.send({
        toSessionId: sessionId,
        text: body.text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(body.forceTerminal === true ? { forceTerminal: true } : {}),
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

  // ---- 会话洞察域 → routes/session-insights.ts（计划/命令候选/返显/改动汇总）----
  if (await handleSessionInsightRoutes(req, res, deps, pathname, url)) return true;

  // ---- 路径引用域 → routes/path-refs.ts（文件索引/引用表达式/反向认引用/预览）----
  if (await handlePathRefRoutes(req, res, deps, pathname, url)) return true;

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

  // ---- 删除在途视图里的消息行（暂停闸成因也能删：删即解闸并续排空；
  //      队列待递送行删 = 取消发送）----
  const dismissMatch = pathname.match(/^\/sessions\/([^/]+)\/messages\/([^/]+)\/dismiss$/);
  if (dismissMatch && req.method === 'POST') {
    if (!deps.messageDeliverer) {
      sendJson(res, 503, { error: 'Messaging subsystem unavailable' });
      return true;
    }
    const result = deps.messageDeliverer.dismiss(
      decodeURIComponent(dismissMatch[1]!),
      decodeURIComponent(dismissMatch[2]!),
    );
    if (result.ok) {
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, result.status, { error: result.error });
    }
    return true;
  }

  // ---- 会话控制域 → routes/session-control.ts（中断/关 pane/模式/模型/effort/问答/旁路）----
  if (await handleSessionControlRoutes(req, res, deps, pathname, url)) return true;

  // ---- 提醒域 → routes/watches.ts（空闲订阅/Web Push）----
  if (await handleWatchRoutes(req, res, deps, pathname)) return true;

  // ---- 编排域 → routes/orchestration.ts（定义/触发/运行日志/公开 webhook）----
  if (await handleOrchestrationRoutes(req, res, deps, pathname, url)) return true;

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
        /** 附件随 prompt 的对齐面收哪些类型（空 = 该 harness 不收附件，附件钮置灰）。 */
        attachKinds: surface.attach?.kinds ?? [],
        /** 项目内路径的引用文法（false = 该 harness 没有这种文法，文件钮置灰）。 */
        pathRefs: surface.pathRefs !== null,
        /** 该文法认不认行区间（false = 选择器只给整文件引用，不摆行号选择）。 */
        pathRefLines: surface.pathRefs?.lines === true,
        /** 该文法能引用什么（`dir` 缺席 = 只给文件引用，目录行不摆「引用此文件夹」）。 */
        pathRefKinds: surface.pathRefs?.kinds ?? [],
        /** 旁路会话（侧问）通道；false = 该 harness 没有这种机制（入口不渲染）。 */
        sideQuestion: surface.sideQuestion !== null,
        unsupportedReasons: surface.unsupportedReasons ?? null,
      })),
    });
    return true;
  }

  // ---- 投递诊断：daemon + 项目采集脚本健康 + 会话通道矩阵（被动只读现算） ----
  // 判据集 = 各通道「何时不可用」的全部条件（见 MessageDeliverer.diagnose / CaptureSurface.
  // scriptHealth），不探端口、不起子进程、不落库、不回传凭据值。?session= / ?project= 收窄。
  if (pathname === '/messaging/diagnostics' && req.method === 'GET') {
    if (!deps.messageDeliverer || !deps.hookSessions) {
      sendJson(res, 503, { error: 'Message subsystem unavailable' });
      return true;
    }
    const sessionFilter = url.searchParams.get('session');
    const projectFilter = url.searchParams.get('project');
    const captures = captureSurfaces();
    const projects = deps.projects.list();

    const projectRows = await Promise.all(
      projects.map(async (p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        captures: await Promise.all(
          captures.map(async ({ harness, surface }) => ({
            harness,
            ...(await surface.scriptHealth({ projectPath: p.path })),
          })),
        ),
      })),
    );
    const captureOf = (projectId: number | null, harness: string | null) =>
      projectRows
        .find((p) => p.id === projectId)
        ?.captures.find((c) => c.harness === harness) ?? null;

    const liveness = combinedLivenessOf();
    const rows = deps.hookSessions.listWithCounts(
      sessionFilter ? undefined : projectFilter ? Number(projectFilter) : undefined,
    );
    const sessions = rows
      .filter((s) => (sessionFilter ? s.sessionId === sessionFilter : pidAliveOf(s, liveness) !== false))
      .map((s) => {
        const diag = deps.messageDeliverer!.diagnose(s.sessionId);
        const capture = captureOf(s.projectId, s.harness ?? null);
        const channels = { inbox: diag.inbox, queue: diag.queue, relay: diag.relay, terminal: diag.terminal };
        return {
          sessionId: s.sessionId,
          projectId: s.projectId,
          harness: s.harness ?? null,
          title: s.title,
          lastSeenAt: s.lastSeenAt,
          eventCount: s.eventCount ?? 0,
          lastEventType: s.lastEventType ?? null,
          alive: diag.alive,
          paneEnvReported: diag.paneEnvReported,
          channels,
          queue: { pending: diag.pending, stalled: diag.stalled },
          reachable: Object.values(channels).some((c) => c.status === 'ready'),
          hints: deliveryHints({ diag, capture, eventCount: s.eventCount ?? 0 }),
        };
      });

    sendJson(res, 200, {
      daemon: {
        version: WEAVE_VERSION,
        platform: process.platform,
        dataDir: getDataDir(),
        uptimeMs: Math.round(process.uptime() * 1000),
        terminalPreset: readDaemonSettingsSync().terminal.preset,
        terminalTextChannel: deps.messageDeliverer.hasTerminalChannel(),
        hooksEnabled: readHooksEnabled(),
      },
      projects: projectRows,
      sessions,
    });
    return true;
  }

  return false;
}
