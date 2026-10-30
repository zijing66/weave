import http from 'node:http';
import { WEAVE_VERSION } from '../version.js';
import type { Harness } from '@weavecode/core';
import { isHarness } from '@weavecode/core';
import type { EventSource, HarnessRegistry, PluginSurface } from '@weavecode/harness';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ProjectRepository } from '../repositories/projects.js';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { LibraryRepository } from '../repositories/libraries.js';
import type { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { HookRuleRegistry } from '../hooks/registry.js';
import type { MirrorWriter } from '../hooks/mirror.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { HookEventBus } from '../hooks/bus.js';
import type { DataBus } from './data-bus.js';
import { SseHub } from './sse-hub.js';
import type { TerminalTopologyRefresher } from './terminal-topology-refresher.js';
import type { InflightCountsRefresher } from './inflight-counts-refresher.js';
import type { SnapshotRefresher } from './snapshot-refresher.js';
import type { SessionProbe } from './session-probe.js';
import { importPromptImagesOnce, needsImageImport } from './prompt-images.js';
import type { ProjectUpdatesRefresher } from './project-updates-refresher.js';
import type { ResumeRunner } from '../hooks/resume-runner.js';
import type { MessageDeliverer, PromptTerminal } from '../hooks/message-deliverer.js';
import type { QuestionTracker } from '../hooks/question-tracker.js';
import type { SideQuestionDeps } from '../hooks/side-questions.js';
import type { WatchEngine } from '../hooks/watch-engine.js';
import type { SessionWatchRepository } from '../repositories/session-watches.js';
import type { PushSubscriptionRepository } from '../repositories/push-subscriptions.js';
import type { PushNotifier } from '../hooks/push-notify.js';
import type {
  OrchestrationRepository,
  OrchestrationRunRepository,
} from '../repositories/orchestrations.js';
import type { OrchestrationEngine } from '../hooks/orchestration-engine.js';
import type { PluginManager } from '../hooks/plugin-loader.js';
import type { PluginStateRepository } from '../repositories/plugin-states.js';
import type { UploadRepository } from '../repositories/uploads.js';
import type { UploadSessions } from './upload-sessions.js';
import type { WatchService } from '../watch/watch-service.js';
import { sendJson } from './http.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { ApiLogger } from './api-log.js';
import { handleHooksRoutes } from './hooks-routes.js';
import { handleMcpRequest } from './mcp-orchestration.js';
import { handleToolkitRoutes } from './toolkit-routes.js';
import { handleCaptureRoutes } from './capture-routes.js';
import { handleConfigRoutes } from './config-routes.js';
import { handleMarketRoutes } from './routes/market.js';
import { handleProjectRoutes } from './routes/projects.js';
import { handleSettingsRoutes } from './routes/settings-statusline.js';
import { handleSearchRoutes } from './routes/search.js';
import { handleProjectFileRoutes } from './routes/project-files.js';
import type { ToolkitService } from '../hooks/toolkit.js';
import type { ProjectOpener } from './opener.js';
import { DAEMON_HOST } from './port.js';
import { handleAuthRoutes } from './auth-routes.js';
import { handleAiRoutes } from './ai-routes.js';
import type { AuthService } from './dashboard-auth.js';

export const DAEMON_VERSION = WEAVE_VERSION;

export interface WeaveServerDeps {
  projects: ProjectRepository;
  port: number;
  /** 局域网 HTTPS 监听端口（settings server.tlsPort；0/缺省 = 未开，/settings 的访问地址据此派生）。 */
  tlsPort?: number;
  /** File watch service; optional so tests can run without chokidar. */
  watch?: WatchService;
  /** Hook event repository; optional so non-ingestion tests can omit it. */
  hookEvents?: HookEventRepository;
  /**
   * 事件接入源（批 4b：类型由 HookAdapter 放宽为结构兼容的 EventSource，
   * `HookAdapter[]` 仍可赋值）；`harnesses` 存在时 POST /hooks 由其派生。
   */
  adapters?: EventSource[];
  /** 批 4b：harness 驱动注册表（图② 装配）——events/resume 等能力槽的运行时来源。 */
  harnesses?: HarnessRegistry;
  /** Library registry (asset sources) for the install panel; optional. */
  libraries?: LibraryRepository;
  /** Content-fingerprint cache for update detection; created if absent. */
  fingerprintCache?: FingerprintCache;
  /** 接口日志（出入参 + 耗时按小时 JSONL；GET /api-logs 查询）；缺省 `<cache>/logs/api`。 */
  apiLog?: ApiLogger;
  /** Directory of the built SPA to statically host; optional. */
  staticDir?: string;
  /** Directory-opening backend for the project context menu; spied in tests. */
  opener?: ProjectOpener;
  /** 开机自启注册器；默认落系统自启动项（PUT /settings 即时生效），测试注入 spy。 */
  autoStart?: (enabled: boolean) => void;
  // ---- D3 hooks subsystem (all optional so existing tests can omit them) ----
  /** In-memory rule index (match candidates + CRUD facade). */
  hookRegistry?: HookRuleRegistry;
  /** Dispatch (运行态) store. */
  hookDispatches?: HookDispatchRepository;
  /** Session titles (rename 双向). */
  hookSessions?: SessionRepository;
  /** Hook event bus — SSE subscribes alongside the watch service. */
  hookBus?: HookEventBus;
  /** 数据变更帧总线（SSE 第三订阅源：载荷推送 / 失效键）。 */
  dataBus?: DataBus;
  /** 事件流中枢（编号 + 环形缓冲 + 扇出）：weaveRequestHandler 建一份，两监听共享。 */
  sseHub?: SseHub;
  /** SSE 首连回调（仪表盘在连接时流式补发历史）。 */
  onAttach?: () => void;
  /** POST /dashboard/refresh：仪表盘挂载时让服务端重推一次快照（数据仍走 SSE）。 */
  dashboardRefresh?: () => void;
  /** 终端世界（角标计数 + 会话所在屏幕）的后端隐藏刷新器；缺省则该角标只能靠前端自拉（兼容旧装配）。 */
  terminalRefresher?: TerminalTopologyRefresher;
  /** 会话中断态快照刷新器（ESC 打断后多数连 Stop 都不发）：中断成功后即时补一拍。 */
  interruptRefresher?: SnapshotRefresher;
  /** 会话判活快照刷新器（关 pane 后进程死掉同样无 hook 事件）：关完即时补一拍。 */
  livenessRefresher?: SnapshotRefresher;
  /** 会话转录探测（中断态判据）：GET /sessions 逐行现算；缺省不带该字段。 */
  sessionProbe?: SessionProbe;
  /** 在途消息角标（会话行）的推送器：新 SSE 客户端接入时补一份首帧快照。 */
  inflightRefresher?: InflightCountsRefresher;
  /** 项目行「有更新待同步」角标（含项目插件模板漂移）：源变更/同步落地后对账。 */
  updatesRefresher?: ProjectUpdatesRefresher;
  /** Event dispatcher; hook 文件化后由 inbox 消费线程（inbox-worker）驱动。 */
  hookDispatcher?: HookDispatcher;
  /** 指令池 resume 执行器；POST /hooks/dispatches/:id/run 依赖它。 */
  hookRunner?: ResumeRunner;
  /** 消息域投递器（消息域重塑：纯管道裁决 + prompt 三层）；/sessions/:id/messages 依赖它。 */
  messageDeliverer?: MessageDeliverer;
  /**
   * 层② 终端通道（promptTerminalChannel 的产物，与 messageDeliverer 的 terminal
   * 同一实例）：new-session 的引导注入（`resume.bootstrapText`）借它定位 pane env
   * → pane id 并打文本。缺省 = 无引导注入（会话行等宿主自己的建档节奏）。
   */
  terminal?: PromptTerminal;
  /** 会话上传件（内容寻址落盘 + event_images 指针）；/uploads 与 /images/:id 依赖它。 */
  uploads?: UploadRepository;
  /** 分块上传的半截件（cache/tmp）；/uploads/begin 等依赖它（缺省用进程内默认落点）。 */
  uploadSessions?: UploadSessions;
  /** 阻塞问答跟踪器（AskUserQuestion / 计划与权限确认）；/messaging/questions 与 /sessions/:id/answer 依赖它。 */
  questionTracker?: QuestionTracker;
  /** 旁路会话历史（claude = /btw）：问句只有 weave 自己发过才知道，故得自己记；
   *  `/sessions/:id/side-question(s)` 与删会话级联依赖它。 */
  sideQuestions?: SideQuestionDeps;
  /** 空闲订阅存储（批 2）；POST/DELETE /sessions/:id/watch 与 GET /messaging/watches 依赖它。 */
  sessionWatches?: SessionWatchRepository;
  /** Web Push 订阅存储；POST /messaging/push/(un)subscribe 依赖它。 */
  pushSubscriptions?: PushSubscriptionRepository;
  /** Web Push 发送器（提醒第三条腿）；GET /messaging/push/key 依赖它。 */
  pushNotifier?: Pick<PushNotifier, 'publicKey'>;
  /** 空闲订阅引擎（批 2）；创建即空闲段的 fire 依赖它。 */
  watchEngine?: Pick<WatchEngine, 'created'>;
  /** 跨会话编排定义存储；/messaging/orchestrations 依赖它。 */
  orchestrations?: OrchestrationRepository;
  /** 编排运行日志（统一视图 + 保留清理）；/messaging/orchestration-runs 依赖它。 */
  orchestrationRuns?: OrchestrationRunRepository;
  /** 编排引擎；触发 / 取消 / webhook 入口依赖它。 */
  orchestrationEngine?: Pick<OrchestrationEngine, 'start' | 'cancel'>;
  /** 插件管理面；GET /hooks/plugins 与 toggle 依赖它（loader 异步就绪前返回空表）。 */
  hookPlugins?: PluginManager;
  /** D3 插件全局开关行；GET /hooks/plugins?projectId= 的 effective 回落源。 */
  pluginStates?: PluginStateRepository;
  /** hook 注入计划镜像（规则/标题变更后重写 mirror 文件，缺省不同步 = 无注入）。 */
  hookMirror?: Pick<MirrorWriter, 'syncProject' | 'syncAll'>;
  /** hook 文件管道根（归档路由焚毁 inbox/mirror/outbox 用；缺省 hooksRoot()，测试注入临时根）。 */
  hooksDir?: string;
  /** 批 10 工具包服务；/projects/:id/toolkit 依赖它。 */
  toolkit?: ToolkitService;
  /** 插件安装面（plugins/uninstall 依赖它）；缺省经 registry 取 Claude 面，测试注入 fake exec。 */
  pluginSurface?: PluginSurface;
  /** dashboard 平面认证（见 auth.ts）。缺省不装 = 开放（存量测试口径），生产由 start/dev-entry 装配。 */
  auth?: AuthService;
  /** AI key 文件路径（测试注入）；缺省 `<local>/ai.json`（见 daemon/ai-config.ts）。 */
  aiKeyPath?: string;
  /** Decision-model key file override (tests); default `<local>/decision.json`. */
  decisionKeyPath?: string;
}

/**
 * 请求 handler 工厂（http 与 https 两个监听共享同一份，含 fingerprint 缓存）。
 * 传给 createServer 前先在这里做一次 deps 缺省补齐，别在两处各建一份缓存。
 */
export function weaveRequestHandler(
  deps: WeaveServerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  // Ensure a long-lived fingerprint cache so update detection reuses hashes.
  const fingerprintCache = deps.fingerprintCache ?? new FingerprintCache();
  const apiLog = deps.apiLog ?? new ApiLogger();
  // 中枢与 fingerprint 缓存同口径：一处建、两个监听共用——每个连接各自订阅会让
  // 序号与缓冲随连接数翻倍（同一帧被记 N 次）。
  const sseHub = deps.sseHub ?? new SseHub(deps);
  const serverDeps: WeaveServerDeps = { ...deps, fingerprintCache, apiLog, sseHub };
  return (req, res) => {
    apiLog.begin(req, res);
    void handleRequest(req, res, serverDeps);
  };
}

/** Create the daemon HTTP server (no TLS; 绑定地址由调用方 listen 决定，认证经 deps.auth)。 */
export function createWeaveServer(deps: WeaveServerDeps): Server {
  return http.createServer(weaveRequestHandler(deps));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${DAEMON_HOST}`);

  // The SPA calls /api/<route>; strip the prefix so existing routes work for
  // both the CLI (which calls /<route> directly) and the frontend.
  let pathname = url.pathname;
  if (pathname.startsWith('/api/')) pathname = pathname.slice(4);
  else if (pathname === '/api') pathname = '/';

  // /health — unauthenticated; used for port probing and single-instance checks.
  if (pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, {
      service: 'weave-daemon',
      version: DAEMON_VERSION,
      pid: process.pid,
      port: deps.port,
      uptimeMs: Math.round(process.uptime() * 1000),
    });
    return;
  }

  // /auth/* —— 认证子系统自身（登录/登出/改密/状态），门豁免：登录页要用它。
  if (await handleAuthRoutes(req, res, deps, pathname)) return;

  // /ai/* —— AI 助手（OpenAI 兼容的服务端代理，见 daemon/ai-routes.ts）。
  // 不豁免：门内的路由，只有已登录用户能花机主的 key。
  if (await handleAiRoutes(req, res, deps, pathname)) return;

  // 认证门（装 auth 才生效）：除「HTML 导航 + 真实静态文件」外一律要凭据——
  // 浏览器 fetch/SSE、CLI 全部走同一条判定（会话 cookie 或本机令牌）。放行 HTML
  // 与静态文件是因为登录页必须未认证可载；导航类请求带的是 SPA 外壳，不含数据。
  if (deps.auth && !isPublicRequest(req, pathname, deps)) {
    if (!deps.auth.isAuthenticated(req.headers)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
  }

  // POST/GET /mcp —— 内置 MCP（Streamable HTTP，无状态）：工具面 = 编排。
  // 生命周期即 daemon 生命周期；认证沿用上面的门（MCP 客户端配置带本机令牌头）。
  if (pathname === '/mcp') {
    await handleMcpRequest(req, res, {
      port: deps.port,
      token: deps.auth?.getLocalToken() ?? null,
    });
    return;
  }

  // GET /api-logs —— 接口日志查询（只读面；写入侧见 daemon/api-log.ts）。
  if (pathname === '/api-logs' && req.method === 'GET') {
    if (!deps.apiLog) {
      sendJson(res, 503, { error: 'API log unavailable' });
      return;
    }
    const statusRaw = url.searchParams.get('status');
    const limitRaw = url.searchParams.get('limit');
    const result = await deps.apiLog.query({
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      path: url.searchParams.get('path') ?? undefined,
      method: url.searchParams.get('method') ?? undefined,
      status: statusRaw == null ? undefined : Number(statusRaw),
      limit: limitRaw == null ? undefined : Number(limitRaw),
    });
    sendJson(res, 200, result);
    return;
  }

  // D3 hooks 子路由（规则/派发/会话）——未命中返回 false，主链继续。
  if (await handleHooksRoutes(req, res, deps, pathname, url)) return;

  // 批 10 工具包子路由（包清单/开关）——未命中返回 false，主链继续。
  if (await handleToolkitRoutes(req, res, deps, pathname, url)) return;

  // §6-2d user 档采集面（能力槽 capture）——未命中返回 false，主链继续。
  if (await handleCaptureRoutes(req, res, deps, pathname)) return;

  // 资源管理 · harness 配置文件（能力槽 config）——未命中返回 false，主链继续。
  if (await handleConfigRoutes(req, res, deps, pathname, url)) return;

  // GET /projects/:id/hooks — hook events for the task view (by session).
  const hooksMatch = pathname.match(/^\/projects\/(\d+)\/hooks$/);
  if (hooksMatch && req.method === 'GET') {
    if (!deps.hookEvents) {
      sendJson(res, 503, { error: 'Hook ingestion unavailable' });
      return;
    }
    const projectId = Number(hooksMatch[1]);
    const limit = clampLimit(url.searchParams.get('limit'));
    const sessionId = url.searchParams.get('sessionId');
    const beforeIdRaw = url.searchParams.get('beforeId');
    const beforeId = beforeIdRaw ? Number(beforeIdRaw) : undefined;
    const types = (url.searchParams.get('types') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // sessionId 过滤语义（任务视图按会话画事件链）：projectId 仅作鉴权锚点——
    // 会话可能采集到跨项目事件，双条件过滤会丢事件。
    if (sessionId) {
      const events = deps.hookEvents.listBySession(sessionId, limit ?? 300, beforeId, types);
      // 消息随附图（对话气泡缩略图）：挂在开轮事件上，逐行带回。
      let images = deps.uploads?.imagesBySession(sessionId);
      // 终端里粘的图只在转录里（hook 只有 `[Image #N]` 占位）：缺图就补采一次。
      // 等它一拍——历史会话不会再来事件帧，后台补完前端没有刷新时机。
      if (needsImageImport(events, images)) {
        // 补采图落项目自定义存储目录（没配 = 全局默认）
        const meta = deps.projects.getMeta(projectId) as { storage?: { images?: string | null } } | null;
        const imported = await importPromptImagesOnce(
          {
            hookEvents: deps.hookEvents,
            uploads: deps.uploads,
            sessionProbe: deps.sessionProbe,
            uploadDir: meta?.storage?.images ?? null,
          },
          sessionId,
          harnessOf(events),
        );
        if (imported) images = deps.uploads?.imagesBySession(sessionId);
      }
      sendJson(res, 200, {
        events: events.map((e) => {
          const rows = images?.get(e.id);
          return rows?.length
            ? {
                ...e,
                images: rows.map((r) => ({ id: r.id, name: r.name, mediaType: r.mediaType, size: r.size })),
              }
            : e;
        }),
      });
      return;
    }
    sendJson(res, 200, { events: deps.hookEvents.listByProject(projectId, limit) });
    return;
  }

  // --- 资源/安装域 → routes/market.ts（libraries/市场/装卸/MCP/更新同步/文件读取）---
  if (await handleMarketRoutes(req, res, deps, pathname, url)) return;

  // --- 设置/状态栏域 → routes/settings-statusline.ts（settings/目录浏览/config/statusline/assets）---
  if (await handleSettingsRoutes(req, res, deps, pathname, url)) return;

  // --- 全局搜索 → routes/search.ts（Ctrl+K：会话名/聊天记录/项目文件三路聚合）---
  if (await handleSearchRoutes(req, res, deps, pathname, url)) return;

  // --- 项目文件数据面 → routes/project-files.ts（索引浏览/搜索 + 根内只读预览）---
  if (await handleProjectFileRoutes(req, res, deps, pathname, url)) return;

  // /events — Server-Sent Events stream of asset change events.
  if (pathname === '/events' && req.method === 'GET') {
    handleSse(req, res, deps, url);
    return;
  }

  // --- 项目域 → routes/projects.ts（开目录/终端、新会话、归档/恢复、排序、pane 枚举）---
  if (await handleProjectRoutes(req, res, deps, pathname)) return;

  // Static SPA hosting (GET only, unauthenticated). Non-file paths fall back
  // to index.html so client-side routing works on deep links.
  if (req.method === 'GET' && deps.staticDir) {
    serveStatic(res, pathname, deps.staticDir);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

/** SSE 心跳间隔：比常见代理的 30~60s 空闲超时短一截，且远小于前端判死阈值。 */
const SSE_HEARTBEAT_MS = 25_000;

/** Upgrade a response to an SSE stream fed by the shared hub. */
function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  url: URL,
): void {
  const hub = deps.sseHub;
  if (!hub || (!deps.watch && !deps.hookBus && !deps.dataBus)) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Event stream unavailable' }));
    return;
  }
  // 断线重连的 offset：自己新建连接时带 `?since=`；浏览器在**同一个** EventSource 上
  // 自带的重连会带 Last-Event-ID——那条比查询串新（它就记在这条对象身上），优先认它，
  // 否则重连会从旧 offset 开始重放已经收过的帧（toast 弹两遍）。
  const header = req.headers['last-event-id'];
  const since =
    (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('since') ?? null;
  const replay = hub.replay(since);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  // 心跳：中间的代理与移动网络会**静默**掐断空闲流——浏览器那边既不报错也不重连，
  // dashboard 就停在旧帧上直到刷新页面（实机见过：面板一直挂着「已发出」，刷新才
  // 正常）。定期写一帧让「没数据」与「断了」在客户端可分辨，前端据此判死重建
  // （见 web/src/lib/sse.ts）。心跳不带 id：它不是数据帧，不该挪客户端的 offset。
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`);
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  // 漏掉的帧补不回来（纪元变了 / 缓冲越界 / 中断期间没人在听）：先告诉前端整页重来。
  if (replay.gap) res.write(`data: ${JSON.stringify({ type: 'resync' })}\n\n`);
  for (const frame of replay.frames) res.write(`id: ${frame.id}\ndata: ${frame.data}\n\n`);

  // 先接上实时流再补快照：补发与订阅之间不许有空档，否则那一拍的新帧会漏。
  const unsubscribe = hub.subscribe((frame) => {
    res.write(`id: ${frame.id}\ndata: ${frame.data}\n\n`);
  });

  // 新客户端补一份在途消息角标快照：推送只在变化时发，首帧不该等到下一次消息事件。
  deps.inflightRefresher?.refreshNow();
  // 终端角标同理：先补上次快照（无则跳过），再后台对一次账补差量——前端零轮询。
  deps.terminalRefresher?.onSubscriberJoin();
  // 项目行更新角标：补一份绝对值快照（含 0），页面一打开即准确，不必等 hover。
  deps.updatesRefresher?.onSubscriberJoin();

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/**
 * 门豁免判定：HTML 导航（SPA 外壳/登录页，浏览器导航必带 `Accept: text/html`，
 * 而 fetch/EventSource 不带）+ staticDir 下真实存在的静态文件。API 数据一律不豁免。
 */
function isPublicRequest(
  req: IncomingMessage,
  pathname: string,
  deps: WeaveServerDeps,
): boolean {
  if (pathname === '/health') return true;
  // 编排的公开触发端点：token 即凭证（外部 webhook 无法带 dashboard 凭据）。
  // 必须在 GET-only 早退之前——它是 POST。
  if (pathname.startsWith('/webhooks/orchestrate/')) return true;
  if (req.method !== 'GET') return false;
  if ((req.headers.accept ?? '').includes('text/html')) return true;
  if (!deps.staticDir) return false;
  const safe = path.normalize(pathname).replace(/^([/\\]\.\.[/\\])+/, '');
  const filePath = path.join(deps.staticDir, safe);
  return (
    filePath.startsWith(deps.staticDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()
  );
}

/**
 * 静态件的缓存口径：`/assets/` 下是 vite 的内容哈希文件名（内容不变则名不变），
 * 可长缓存；其余（index.html、sw.js、图标）名字恒定而内容会变——尤其是 sw.js
 * 被长缓存会让 Web Push 的更新卡死在旧版，一律 no-cache（走 ETag 协商）。
 */
function setStaticCache(res: ServerResponse, pathname: string): void {
  res.setHeader(
    'cache-control',
    pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  );
}

/** Serve a static file from `staticDir`, falling back to index.html (SPA). */
function serveStatic(res: ServerResponse, pathname: string, staticDir: string): void {
  const safe = path.normalize(pathname).replace(/^([/\\]\.\.[/\\])+/, '');
  const filePath = path.join(staticDir, safe);
  if (!filePath.startsWith(staticDir)) {
    res.statusCode = 403;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      res.setHeader('content-type', mime(filePath));
      setStaticCache(res, pathname);
      res.setHeader('content-length', String(stat.size));
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    // SPA fallback for non-file routes.
    fs.readFile(path.join(staticDir, 'index.html'), (e, data) => {
      if (e) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.setHeader('cache-control', 'no-cache');
      res.end(data);
    });
  });
}

function mime(filePath: string): string {
  if (filePath.endsWith('.js')) return 'text/javascript';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.html')) return 'text/html';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.json')) return 'application/json';
  // PWA manifest：类型不对（octet-stream）时 Chrome 会拒绝安装，仍不影响页面访问。
  if (filePath.endsWith('.webmanifest')) return 'application/manifest+json';
  return 'application/octet-stream';
}

/** 一页事件所属 harness（取最新那条认得出来的 source；认不出 = null，不猜）。 */
function harnessOf(events: readonly { source: string }[]): Harness | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const source = events[i]!.source;
    if (isHarness(source)) return source;
  }
  return null;
}

function clampLimit(raw: string | null): number {
  const n = Number(raw ?? '100');
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(Math.floor(n), 500);
}




