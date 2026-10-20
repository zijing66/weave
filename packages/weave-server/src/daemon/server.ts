import http from 'node:http';
import { WEAVE_VERSION } from '../version.js';
import type { Harness } from '@weavecode/core';
import { checkHarness, isHarness } from '@weavecode/core';
import type { EventSource, HarnessRegistry, PluginSurface } from '@weavecode/harness';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ProjectRepository } from '../repositories/projects.js';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { LibraryRepository, LibraryRow } from '../repositories/libraries.js';
import type { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { HookRuleRegistry } from '../hooks/registry.js';
import { hooksRoot, type MirrorWriter } from '../hooks/mirror.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { HookEventBus } from '../hooks/bus.js';
import type { DataBus } from './data-bus.js';
import type { TerminalTopologyRefresher } from './terminal-topology-refresher.js';
import type { InflightCountsRefresher } from './inflight-counts-refresher.js';
import type { SnapshotRefresher } from './snapshot-refresher.js';
import type { SessionProbe } from './session-probe.js';
import type { ProjectUpdatesRefresher } from './project-updates-refresher.js';
import type { ResumeRunner } from '../hooks/resume-runner.js';
import type { MessageDeliverer } from '../hooks/message-deliverer.js';
import type { QuestionTracker } from '../hooks/question-tracker.js';
import type { SideQuestionDeps } from '../hooks/side-questions.js';
import type { WatchEngine } from '../hooks/watch-engine.js';
import type { SessionWatchRepository } from '../repositories/session-watches.js';
import type { PushSubscriptionRepository } from '../repositories/push-subscriptions.js';
import type { PushNotifier } from '../hooks/push-notify.js';
import type { SessionSequenceRepository } from '../repositories/session-sequences.js';
import type { SequenceEngine } from '../hooks/sequence-engine.js';
import type { PluginManager } from '../hooks/plugin-loader.js';
import type { PluginStateRepository } from '../repositories/plugin-states.js';
import type { UploadRepository } from '../repositories/uploads.js';
import { syncPlugins } from '../hooks/plugin-project-state.js';
import type { WatchService } from '../watch/watch-service.js';
import { getLibraryScan, invalidateScan } from '../install/scan-cache.js';
import {
  installSkill,
  uninstallSkill,
  installFileAsset,
  uninstallFileAsset,
  InstallConflictError,
  AssetNotFoundError,
} from '../install/installer.js';
import type { McpServerConfig, InstallAgent } from '../install/installer.js';
import { isFileAssetCategory, type FileAssetCategory } from '../install/file-assets.js';
import { installCapabilities } from '../install/capabilities.js';
import { readMcpRows } from '../install/mcp-rows.js';
import {
  installGlobalSkill,
  uninstallGlobalSkill,
  readGlobalSkillGroups,
  resolveGlobalSkillDir,
  listGlobalSkillFiles,
  readGlobalSkillFile,
  ClaudeJsonCorruptError,
} from '../install/global-config.js';
import type { GlobalSkillSource } from '../install/global-config.js';
import { CodexTomlCorruptError } from '../install/codex-toml.js';
import { forgetInstalled, recordInstalled } from '../install/install-ledger.js';
import { setMcpEnableOverride } from '../install/settings-mcp.js';
import { readProjectConfig, writeProjectConfig } from '../install/project-config.js';
import type { ProjectConfig } from '../install/project-config.js';
import { applyUpdate, syncAll } from '../install/apply-update.js';
import { buildLibraryIndex } from '../install/library-index.js';
import { importFromDir, importFromGit, importLibraryIntoMarket } from '../market/import.js';
import { marketDir, readManifest } from '../market/manifest.js';
import { marketIdOf } from '../market/identity.js';
import { isInsideDir, toRelPosix } from '../market/resolve.js';
import { checkMarketUpdates } from '../market/updates.js';
import { refreshMarketItems, type RefreshResult } from '../market/refresh.js';
import { ensureBuiltinMarket, isBuiltinMarketDir } from '../market/builtin.js';
import { removeInstalled } from '../market/install-link.js';
import {
  readProjectFile,
  readGlobalFile,
  PathEscapeError,
  FileTooLargeError,
} from '../install/reader.js';
import { listGlobalFileAssets } from '../install/global-file-assets.js';
import {
  readStatuslineConfig,
  readStatuslineScript,
  readStatuslineFacts,
  applyStatuslineConfig,
  readGlobalStatuslineConfig,
  writeGlobalStatuslineConfig,
} from '../statusline/manager.js';
import { DEFAULT_STATUSLINE_CONFIG, type StatuslineConfig } from '../statusline/config.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { detectUpdates } from '../install/updates.js';
import { detectPluginTemplateUpdates } from '../install/plugin-templates.js';
import { detectInitFileUpdates, needsInit } from '../install/init-files.js';
import { readBody, sendJson } from './http.js';
import { ApiLogger } from './api-log.js';
import { handleHooksRoutes } from './hooks-routes.js';
import { handleToolkitRoutes } from './toolkit-routes.js';
import { handleCaptureRoutes } from './capture-routes.js';
import { purgeProjectPipeline } from './hook-pipeline.js';
import { projectFileNamespaces, type ToolkitService } from '../hooks/toolkit.js';
import { listBrowseRoots, listDirectoryChildren } from './fs-browser.js';
import {
  DEFAULT_AI_SETTINGS,
  readDaemonSettings,
  writeDaemonSettings,
  terminalPresetsFor,
  type AiSettings,
  type DaemonSettings,
} from './settings.js';
import {
  closeTerminalsIn,
  defaultProjectOpener,
  readTerminalCounts,
  terminalBackendFor,
  type ProjectOpener,
} from './opener.js';
import { applyLaunchOnLogin } from './auto-start.js';
import { DAEMON_HOST } from './port.js';
import {
  assetSurfaces,
  pluginStateSurfaces,
  pluginSurfaces,
  pluginSurfaceFor,
} from '../surfaces.js';
import { readPluginRows } from '../install/plugin-rows.js';
import { installPluginPack } from '../install/plugin-install.js';
import { handleAuthRoutes } from './auth-routes.js';
import { handleAiRoutes } from './ai-routes.js';
import { hasAiKey, writeAiKey } from './ai-config.js';
import { accessUrls } from './tls.js';
import { projectHarnesses, withProjectHarnesses } from './project-harnesses.js';
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
  /** 接口日志（出入参 + 耗时按小时 JSONL；GET /api-logs 查询）；缺省 <dataDir>/logs/api。 */
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
  /** 会话图片上传件（内容寻址落盘 + event_images 指针）；/uploads 与 /images/:id 依赖它。 */
  uploads?: UploadRepository;
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
  /** 跨会话序列存储（批 3）；/messaging/sequences 依赖它。 */
  sessionSequences?: SessionSequenceRepository;
  /** 序列引擎（批 3）；POST 触发步 0 与 DELETE 取消依赖它。 */
  sequenceEngine?: Pick<SequenceEngine, 'trigger' | 'cancel'>;
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
  /** AI key 文件路径（测试注入）；缺省 `<dataDir>/ai.json`（见 daemon/ai-config.ts）。 */
  aiKeyPath?: string;
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
  const serverDeps: WeaveServerDeps = { ...deps, fingerprintCache, apiLog };
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
      const images = deps.uploads?.imagesBySession(sessionId);
      sendJson(res, 200, {
        events: events.map((e) => {
          const rows = images?.get(e.id);
          return rows?.length ? { ...e, images: rows.map((r) => ({ id: r.id, name: r.name, mediaType: r.mediaType })) } : e;
        }),
      });
      return;
    }
    sendJson(res, 200, { events: deps.hookEvents.listByProject(projectId, limit) });
    return;
  }

  // --- daemon settings (terminal preset for "open in terminal") ---
  if (pathname === '/settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        settings: withAiStatus(await readDaemonSettings(), deps.aiKeyPath),
        presets: terminalPresetsFor(process.platform),
        platform: process.platform,
        // 对外访问地址（设置页展示面）：全部局域网 IP × 已开协议。
        urls: accessUrls(deps.port, deps.tlsPort ?? 0),
      });
      return;
    }
    if (req.method === 'PUT') {
      let body: Partial<DaemonSettings> & { ai?: { apiKey?: string | null } };
      try {
        body = JSON.parse(await readBody(req)) as Partial<DaemonSettings> & {
          ai?: { apiKey?: string | null };
        };
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      // `ai.apiKey` 是**只写**字段：拆出来落 <dataDir>/ai.json（0600），不进 settings 表；
      // 响应与 GET 都只回派生布尔 apiKeySet——密钥永不回显。
      const apiKey = body.ai?.apiKey;
      if (apiKey !== undefined) {
        writeAiKey(typeof apiKey === 'string' ? apiKey : null, deps.aiKeyPath);
      }
      const saved = await writeDaemonSettings({ ...body, ai: stripAiKey(body.ai) } as DaemonSettings);
      // 保留期等事件策略改动即刻生效：重置被动清理天标记，下一条事件写入
      // 就按新配置重扫（否则要等次日跨天）。
      deps.hookEvents?.resetPrune();
      // 开机自启即刻注册/注销（内部吞错，不阻塞保存响应）。
      (deps.autoStart ?? applyLaunchOnLogin)(saved.startup?.launchOnLogin ?? false);
      deps.dataBus?.emit({ key: 'settings' });
      sendJson(res, 200, withAiStatus(saved, deps.aiKeyPath));
      return;
    }
  }

  // --- open a project directory in the file manager or a terminal ---
  const openMatch = pathname.match(/^\/projects\/(\d+)\/open$/);
  if (openMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(openMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    let body: { target?: string };
    try {
      body = JSON.parse(await readBody(req)) as { target?: string };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    if (body.target !== 'explorer' && body.target !== 'terminal') {
      sendJson(res, 400, { error: 'Invalid "target" (explorer|terminal)' });
      return;
    }
    const opener = deps.opener ?? defaultProjectOpener;
    try {
      const stat = await fs.promises.stat(project.path);
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${project.path}`);
      if (body.target === 'explorer') {
        await opener.openExplorer(project.path);
      } else {
        const settings = await readDaemonSettings();
        await opener.openTerminal(project.path, settings.terminal);
        // 角标对账：新窗 pane 的 cwd 上报有一拍延迟，立即探也看不到增量——
        // 600ms 后对一次账（原先由前端 setTimeout 拉 GET，改服务端自对账）。
        setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
      }
      sendJson(res, 200, { ok: true, target: body.target, path: project.path });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Open failed' });
    }
    return;
  }

  // --- close this project's open terminals (project card "关闭终端") ---
  // 只关 body.paneIds 清单里的 pane（用户在多选弹窗里勾的那些）——**不提供一口气
  // 全关**。命中判据仍是 pane 的 cwd **恰为**项目目录（与「终端」角标同一条，不含
  // 子目录）：窗口里别的 cwd 的 pane 不动（不替用户关掉顺手开着的别的活）。
  // 关完角标自己掉——与 /open 同口径，600ms 后对一次账。
  const closeTermMatch = pathname.match(/^\/projects\/(\d+)\/close-terminal$/);
  if (closeTermMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(closeTermMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    let body: { paneIds?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || '{}') as { paneIds?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    if (
      !Array.isArray(body.paneIds) ||
      body.paneIds.length === 0 ||
      body.paneIds.some((id) => typeof id !== 'string')
    ) {
      sendJson(res, 400, { error: 'paneIds must be a non-empty array of strings' });
      return;
    }
    const opener = deps.opener ?? defaultProjectOpener;
    const settings = await readDaemonSettings();
    try {
      const close = opener.closeTerminals ?? closeTerminalsIn;
      const closed = await close(project.path, settings.terminal, body.paneIds as string[]);
      setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
      sendJson(res, 200, { ok: true, closed });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Close failed' });
    }
    return;
  }

  // --- start a new session in this project's terminal ---
  // POST /projects/:id/new-session — 落进本项目的终端：命令 = harness 裸 bin（新会话，
  // 不带 resume 参数——`openArgs` 才是 resume），落点由终端后端的复用逻辑决定
  // （同项目目录的既有 pane 分屏 → 没有就新窗口；wezterm 连实例都没开则后端报因）。
  // **不要求「本项目已打开终端」**：没有就自己开一个，新建会话不靠先手动开终端。
  const newSessionMatch = pathname.match(/^\/projects\/(\d+)\/new-session$/);
  if (newSessionMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(newSessionMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    let body: { harness?: unknown };
    try {
      body = JSON.parse((await readBody(req)) || '{}') as { harness?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    // 起哪个 harness = 项目 init 选择结果里的；请求体指定则用它。未接入的不许起
    // （不替用户跨配置起会话），能起交互会话的 = resume 槽有裸 bin（codex 无 → 501）。
    const integrated = await projectHarnesses(project.path, deps.harnesses);
    if (body.harness !== undefined && !isHarness(body.harness)) {
      sendJson(res, 400, { error: 'Invalid "harness"' });
      return;
    }
    const requested = body.harness as Harness | undefined;
    if (requested && !integrated.some((h) => h.id === requested)) {
      sendJson(res, 409, { error: `Harness "${requested}" is not integrated in this project` });
      return;
    }
    const wanted = requested ? [requested] : integrated.map((h) => h.id);
    const picked = wanted
      .map((id) => ({ id, spec: deps.harnesses?.get(id)?.resume }))
      .find((c) => c.spec?.bin);
    if (!picked) {
      sendJson(res, 501, {
        error: `Harness "${wanted[0]}" cannot start an interactive session`,
      });
      return;
    }
    const spec = picked.spec!;
    const opener = deps.opener ?? defaultProjectOpener;
    try {
      const stat = await fs.promises.stat(project.path);
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${project.path}`);
      const settings = await readDaemonSettings();
      await opener.runInTerminal(project.path, [spec.bin], settings.terminal);
      // 角标对账：新 pane 的 cwd 上报有一拍延迟（与 /open 同口径）。
      setTimeout(() => void deps.terminalRefresher?.refreshNow(), 600);
      sendJson(res, 200, { ok: true, command: spec.bin, cwd: project.path });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Open failed' });
    }
    return;
  }

  // --- cross-platform directory browsing (powers the web folder picker) ---
  if (pathname === '/fs/roots' && req.method === 'GET') {
    const libraryPaths = deps.libraries ? deps.libraries.list().map((l) => l.path) : [];
    const roots = await listBrowseRoots(libraryPaths);
    sendJson(res, 200, { roots });
    return;
  }
  if (pathname === '/fs/children' && req.method === 'GET') {
    const dirPath = url.searchParams.get('path');
    if (!dirPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return;
    }
    try {
      const children = await listDirectoryChildren(dirPath);
      sendJson(res, 200, { children });
    } catch (err) {
      sendJson(res, 400, { error: `Cannot list directory: ${String(err)}` });
    }
    return;
  }

  // --- 安装属性矩阵（harness 适配 × 安装范围；web 拖拽/点击禁用共用） ---
  if (pathname === '/capabilities' && req.method === 'GET') {
    sendJson(res, 200, installCapabilities());
    return;
  }

  // --- libraries (asset sources for the install panel) ---
  if (pathname === '/libraries' && req.method === 'GET') {
    sendJson(res, 200, { libraries: deps.libraries ? deps.libraries.list() : [] });
    return;
  }
  if (pathname === '/libraries' && req.method === 'POST') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    let body: { path?: string; kind?: string };
    try {
      body = JSON.parse(await readBody(req)) as { path?: string; kind?: string };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    if (!body.path || !body.kind) {
      sendJson(res, 400, { error: 'Missing "path" or "kind"' });
      return;
    }
    if (!['skill', 'mcp', 'both'].includes(body.kind)) {
      sendJson(res, 400, { error: 'Invalid "kind" (skill|mcp|both)' });
      return;
    }
    const row = deps.libraries.add({
      path: body.path,
      kind: body.kind as 'skill' | 'mcp' | 'both',
    });
    deps.dataBus?.emit({ key: 'libraries' });
    sendJson(res, 201, row);
    return;
  }
  const libAssetsMatch = pathname.match(/^\/libraries\/(\d+)\/assets$/);
  if (libAssetsMatch && req.method === 'GET') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    const lib = deps.libraries.getById(Number(libAssetsMatch[1]));
    if (!lib) {
      sendJson(res, 404, { error: 'Library not found' });
      return;
    }
    // 四扫描编排收编在 scan-cache（plugins 先行 → packRoots 排除：包内
    // skill/表面成分/mcp 隶属包，随包启停不独立安装）。缓存存原料，kind
    // 门控在此：plugins/files/mcp 门控、skills 不门控（维持现状）。
    const { plugins: allPlugins, skills, mcp: allMcp, files: allFiles } = await getLibraryScan(
      lib.path,
    );
    const plugins = lib.kind === 'skill' || lib.kind === 'both' ? allPlugins : [];
    const mcp = lib.kind === 'mcp' || lib.kind === 'both' ? allMcp : [];
    // files 按分类分组，出参按 web 契约摊平为扁平数组（每项自带 category）
    const files = lib.kind === 'skill' || lib.kind === 'both' ? Object.values(allFiles).flat() : null;
    sendJson(res, 200, { library: lib, skills, mcp, files, plugins });
    return;
  }
  const libMatch = pathname.match(/^\/libraries\/(\d+)$/);
  if (libMatch && req.method === 'DELETE') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    const libId = Number(libMatch[1]);
    const libRow = deps.libraries.getById(libId);
    if (libRow) await invalidateScan(libRow.path); // 外部目录不删库不删目录，清掉缓存文件
    deps.libraries.remove(libId);
    deps.dataBus?.emit({ key: 'libraries' });
    deps.dataBus?.emit({ key: 'market' });
    sendJson(res, 200, { ok: true });
    return;
  }

  // --- 资源市场（批 9）：清单 / 双导入 / 删除 / legacy 外部源迁入 ---
  if (pathname === '/market' && req.method === 'GET') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    const items = await Promise.all(
      deps.libraries.list().map((row) => marketItem(row, deps.libraries!.dataDir)),
    );
    sendJson(res, 200, { items });
    return;
  }
  if (pathname === '/market' && req.method === 'POST') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    let body: { kind?: string; path?: string; url?: string };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    // dataDir 跟随库实例（生产 = getDataDir()；测试可注入临时根，读写两侧同根）
    const importDeps = { libraries: deps.libraries, dataDir: deps.libraries.dataDir };
    try {
      if (body.kind === 'dir' && body.path) {
        const imported = await importFromDir(body.path, importDeps);
        if (imported.refreshed) deps.fingerprintCache?.invalidate(imported.dir); // 覆盖重导 → 指纹失效
        await invalidateScan(imported.dir); // 源目录可能带旧 scans.json，导入后一律作废重扫
        deps.dataBus?.emit({ key: 'market' });
        sendJson(res, 201, {
          item: await marketItem(deps.libraries.getById(imported.libraryId)!, deps.libraries.dataDir),
        });
      } else if (body.kind === 'git' && body.url) {
        const imported = await importFromGit(body.url, importDeps);
        if (imported.refreshed) deps.fingerprintCache?.invalidate(imported.dir);
        await invalidateScan(imported.dir);
        deps.dataBus?.emit({ key: 'market' });
        sendJson(res, 201, {
          item: await marketItem(deps.libraries.getById(imported.libraryId)!, deps.libraries.dataDir),
        });
      } else {
        sendJson(res, 400, { error: 'Invalid body (kind: "dir" + path | "git" + url)' });
      }
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Import failed' });
    }
    return;
  }
  // 批量检查市场缓存更新（M4）：比对 origin，只读不落库；body 可空 = 全量。
  if (pathname === '/market/check-updates' && req.method === 'POST') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    let body: { ids?: number[] } = {};
    const raw = (await readBody(req)).trim();
    if (raw) {
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
    }
    const rows = deps.libraries
      .list()
      // 内置仓无远程源：不进批量检查（否则只会在 UI 上显示成 unknown 徽标）。
      .filter((r) => !isBuiltinMarketDir(r.path, deps.libraries!.dataDir))
      .filter((r) => !body.ids?.length || body.ids.includes(r.id));
    for (const r of rows) await invalidateScan(r.path); // 检查即重扫事件：之后同路径取新结果
    const results = await checkMarketUpdates(rows.map((r) => ({ id: r.id, dir: r.path })));
    deps.dataBus?.emit({ key: 'market' });
    sendJson(res, 200, { results });
    return;
  }
  // 刷新市场缓存（M4 一键更新）：dir 重拷 / git 重 clone + 回写 commit；body 可空 = 全量。
  if (pathname === '/market/refresh' && req.method === 'POST') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    let body: { ids?: number[] } = {};
    const raw = (await readBody(req)).trim();
    if (raw) {
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
    }
    const selected = deps.libraries
      .list()
      .filter((r) => !body.ids?.length || body.ids.includes(r.id));
    // 内置仓的「刷新」= 重新从包内落地：它不是导入来的，没有可回拷的 origin；
    // 重铺同时会把此前因链接不可用而落成副本的落点改回链接。
    const builtinResults: RefreshResult[] = [];
    for (const row of selected.filter((r) => isBuiltinMarketDir(r.path, deps.libraries!.dataDir))) {
      const r = await ensureBuiltinMarket({ libraries: deps.libraries });
      builtinResults.push({ id: row.id, status: r.error ? 'failed' : 'refreshed' });
    }
    const targets = selected
      .filter((r) => !isBuiltinMarketDir(r.path, deps.libraries!.dataDir))
      .map((r) => ({ id: r.id, dir: r.path }));
    const results = [
      ...(await refreshMarketItems(targets, {
        libraries: deps.libraries,
        dataDir: deps.libraries.dataDir,
      })),
      ...builtinResults,
    ];
    const dirOf = new Map(targets.map((t) => [t.id, t.dir]));
    for (const r of results) {
      if (r.status === 'refreshed') {
        const dir = dirOf.get(r.id);
        if (dir) {
          deps.fingerprintCache?.invalidate(dir);
          await invalidateScan(dir);
        }
      }
    }
    deps.dataBus?.emit({ key: 'market' });
    sendJson(res, 200, { results });
    return;
  }
  const marketMatch = pathname.match(/^\/market\/(\d+)$/);
  if (marketMatch && req.method === 'DELETE') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    const row = deps.libraries.getById(Number(marketMatch[1]));
    if (!row) {
      sendJson(res, 404, { error: 'Library not found' });
      return;
    }
    if (isBuiltinMarketDir(row.path, deps.libraries.dataDir)) {
      sendJson(res, 409, {
        error: 'Built-in market is owned by weave and cannot be deleted',
        note: 'It is re-materialized from @weavecode/templates on every daemon start.',
      });
      return;
    }
    if (!isInsideDir(row.path, marketDir(deps.libraries.dataDir))) {
      sendJson(res, 400, { error: 'Not a market resource (legacy row — use DELETE /libraries/:id)' });
      return;
    }
    // 层 1 反向收口：weave 经 globalInstall 注册进宿主的市场（`marketplace add`
    // 的就是该目录）一并注销——否则 known_marketplaces 指向已删目录成悬空注册。
    // 宿主的 marketplace remove 会**级联卸载**该市场的插件（连同其数据）——
    // 破坏性，前端已加确认弹窗。skills 等装面副本不在此列，保留。
    // best-effort：CLI 缺失/旧版不该堵死市场移除，warning 带回前端提示。
    let warning: string | undefined;
    try {
      const surface = deps.pluginSurface ?? pluginSurfaceFor('claude');
      await surface.removeMarketplace(row.path);
    } catch (e) {
      warning = `Host marketplace deregistration failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    // 市场落点可能是链接（全局位置优先链接）：必须 lstat 判定后 unlink，
    // 裸 rm -rf 会把链接当目录递归删而删穿到包内/外部源。
    await removeInstalled(row.path);
    deps.libraries.remove(row.id);
    await invalidateScan(row.path); // 目录已带走 scans.json，此处兜底热层
    deps.dataBus?.emit({ key: 'market' });
    deps.dataBus?.emit({ key: 'libraries' });
    // 简化裁决：只删市场目录与 libraries 行；非插件装面副本（链接/复制）不级联。
    sendJson(res, 200, {
      ok: true,
      removed: row.path,
      installedCopiesKept: true,
      ...(warning ? { warning } : {}),
      note: 'The host cascade-uninstalls plugins installed from this market; other installed copies are kept.',
    });
    return;
  }
  const migrateMatch = pathname.match(/^\/libraries\/(\d+)\/market-import$/);
  if (migrateMatch && req.method === 'POST') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    const row = deps.libraries.getById(Number(migrateMatch[1]));
    if (!row) {
      sendJson(res, 404, { error: 'Library not found' });
      return;
    }
    try {
      const oldPath = row.path;
      const imported = await importLibraryIntoMarket(row, {
        libraries: deps.libraries,
        dataDir: deps.libraries.dataDir,
      });
      await invalidateScan(oldPath); // 外部源残留的 scans.json 清掉
      await invalidateScan(imported.dir); // 拷贝可能带进旧 scans.json，不作数
      sendJson(res, 200, {
        item: await marketItem(deps.libraries.getById(imported.libraryId)!, deps.libraries.dataDir),
      });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Import failed' });
    }
    return;
  }

  // --- install / uninstall assets (filesystem ops; SSE auto-refreshes the UI) ---
  const installMatch = pathname.match(/^\/projects\/(\d+)\/install$/);
  if (installMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(installMatch[1]));
    let body: InstallBody;
    try {
      body = JSON.parse(await readBody(req)) as InstallBody;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    if (!project && needsProjectPath(body)) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const projectPath = project?.path ?? '';
    try {
      if (body.category === 'skill') {
        if (!body.name || !body.sourceDir) {
          sendJson(res, 400, { error: 'Missing "name" or "sourceDir"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        const target =
          body.scope === 'user'
            ? await installGlobalSkill(body.sourceDir, body.name, agent)
            : await installSkill(projectPath, body.sourceDir, body.name, agent);
        sendJson(res, 201, { category: 'skill', name: body.name, scope: body.scope ?? 'project', agent, path: target });
      } else if (body.category && isFileAssetCategory(body.category)) {
        if (!body.name || !body.sourceFile) {
          sendJson(res, 400, { error: 'Missing "name" or "sourceFile"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        const scope = body.scope ?? 'project';
        const target = await installFileAsset(
          projectPath,
          body.category,
          body.name,
          body.sourceFile,
          agent,
          scope,
        );
        sendJson(res, 201, { category: body.category, name: body.name, scope, agent, path: target });
      } else if (body.category === 'mcp') {
        if (!body.name || !body.mcpConfig) {
          sendJson(res, 400, { error: 'Missing "name" or "mcpConfig"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        const surface = mcpSurfaceOf(agent);
        if (!surface) {
          sendJson(res, 400, { error: `Unsupported agent: ${agent}` });
          return;
        }
        const scopes = surface.mcpScopes();
        // 显式给了该 harness 没有的 scope → 400（没给 = 取它唯一的那个）。
        const scope = body.scope ?? scopes[0];
        if (!scope || !scopes.includes(scope)) {
          sendJson(res, 400, {
            error: `MCP servers for ${agent} are ${scopes.join('/')}-level only — scope "${body.scope}" is not available`,
          });
          return;
        }
        if (body.name in (await surface.mcpRead(scope, projectPath, homedir()))) {
          sendInstallError(res, new InstallConflictError(`MCP server "${body.name}" is already configured`));
          return;
        }
        await surface.mcpWrite(scope, projectPath, homedir(), body.name, body.mcpConfig as McpServerConfig);
        // 安装台账挂在项目上：只有项目档有它（user 档是全局的，无项目可挂）。
        if (scope === 'project') {
          await recordInstalled(projectPath, { category: 'mcp', name: body.name, agent });
        }
        sendJson(res, 201, { category: 'mcp', name: body.name, scope, agent });
      } else if (body.category === 'plugin') {
        // user 档安装管理面（拍板 7-6 方案 A：先开 user 档安装，project/local 待
        // 可逆实验后开）。市场身份与 CLI 编排收在 installPluginPack 唯一处。
        if (!body.name || !body.sourceDir) {
          sendJson(res, 400, { error: 'Missing "name" or "sourceDir"' });
          return;
        }
        if (body.scope && body.scope !== 'user') {
          sendJson(res, 400, { error: 'Plugin install currently only supports scope "user"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        const installFace = pluginSurfaces().find((p) => p.harness === agent);
        if (!installFace) {
          sendJson(res, 400, { error: `No plugin install surface for runtime: ${agent}` });
          return;
        }
        // `deps.pluginSurface` 是 claude 的测试注入点（生产缺省经 registry 取面）。
        const surface =
          agent === 'claude' && deps.pluginSurface
            ? deps.pluginSurface
            : installFace.surface;
        const info = await installPluginPack(surface, {
          dir: body.sourceDir,
          name: body.name,
          version: body.version,
          description: body.description,
        });
        deps.dataBus?.emit({ key: 'toolkit' });
        sendJson(res, 201, {
          category: 'plugin',
          key: info.key,
          scope: 'user',
          agent,
          alreadyInstalled: info.alreadyInstalled,
        });
      } else {
        sendJson(res, 400, { error: 'Invalid "category" (skill|mcp|plugin|command|agent|workflow|rule|output-style)' });
      }
    } catch (e) {
      sendInstallError(res, e);
    }
    return;
  }
  const uninstallMatch = pathname.match(/^\/projects\/(\d+)\/uninstall$/);
  if (uninstallMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(uninstallMatch[1]));
    let body: {
      category?: string;
      name?: string;
      scope?: 'project' | 'user';
      agent?: Harness;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    if (!project && needsProjectPath(body)) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const projectPath = project?.path ?? '';
    try {
      if (body.category === 'skill') {
        if (!body.name) {
          sendJson(res, 400, { error: 'Missing "name"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        if (body.scope === 'user') await uninstallGlobalSkill(body.name, agent);
        else await uninstallSkill(projectPath, body.name, agent);
      } else if (body.category && isFileAssetCategory(body.category)) {
        if (!body.name) {
          sendJson(res, 400, { error: 'Missing "name"' });
          return;
        }
        await uninstallFileAsset(
          projectPath,
          body.category,
          body.name,
          body.agent ?? 'claude',
          body.scope ?? 'project',
        );
      } else if (body.category === 'mcp') {
        if (!body.name) {
          sendJson(res, 400, { error: 'Missing "name"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        const surface = mcpSurfaceOf(agent);
        if (!surface) {
          sendJson(res, 400, { error: `Unsupported agent: ${agent}` });
          return;
        }
        const scopes = surface.mcpScopes();
        const scope = body.scope ?? scopes[0];
        if (!scope || !scopes.includes(scope)) {
          sendJson(res, 400, {
            error: `MCP servers for ${agent} are ${scopes.join('/')}-level only — scope "${body.scope}" is not available`,
          });
          return;
        }
        if (!(await surface.mcpRemove(scope, projectPath, homedir(), body.name))) {
          sendInstallError(res, new AssetNotFoundError(`MCP server "${body.name}" is not configured`));
          return;
        }
        if (scope === 'project') {
          await forgetInstalled(projectPath, { category: 'mcp', name: body.name, agent });
        }
      } else {
        sendJson(res, 400, { error: 'Invalid "category" (skill|mcp|command|agent|workflow|rule|output-style)' });
        return;
      }
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendInstallError(res, e);
    }
    return;
  }

  // --- project file reader (e.g. a skill's SKILL.md) ---
  const fileMatch = pathname.match(/^\/projects\/(\d+)\/file$/);
  if (fileMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(fileMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const relPath = url.searchParams.get('path');
    if (!relPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return;
    }
    try {
      const file = await readProjectFile(project.path, relPath);
      sendJson(res, 200, { path: relPath, content: file.content, size: file.size });
    } catch (e) {
      sendReaderError(res, e);
    }
    return;
  }

  // --- machine-level file reader (~/.claude/…, ~/.codex/…) for the global tree ---
  if (pathname === '/global-file' && req.method === 'GET') {
    const relPath = url.searchParams.get('path');
    if (!relPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return;
    }
    try {
      const file = await readGlobalFile(relPath);
      sendJson(res, 200, { path: relPath, content: file.content, size: file.size });
    } catch (e) {
      sendReaderError(res, e);
    }
    return;
  }

  // --- mcp servers (工具行：claude 项目 .mcp.json / user ~/.claude.json + codex user config.toml) ---
  const mcpMatch = pathname.match(/^\/projects\/(\d+)\/mcp$/);
  if (mcpMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(mcpMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    sendJson(res, 200, { rows: await readMcpRows(project.path) });
    return;
  }

  // --- harness health checks (read-only, 批 8): structured results from core,
  // rendered by each client's own dictionary ---
  const harnessChecksMatch = pathname.match(/^\/projects\/(\d+)\/harness-checks$/);
  if (harnessChecksMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(harnessChecksMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    sendJson(res, 200, { checks: await checkHarness(project.path) });
    return;
  }

  // --- global skills (grouped: personal + plugin, Claude + Codex) ---
  const globalSkillsMatch = pathname.match(/^\/projects\/(\d+)\/skills\/global$/);
  if (globalSkillsMatch && req.method === 'GET') {
    sendJson(res, 200, { groups: await readGlobalSkillGroups() });
    return;
  }

  // --- global skill file listing (resolves symlinks; source/name/pluginKey
  // identify the skill so the client never supplies an arbitrary path) ---
  const globalSkillFilesMatch = pathname.match(/^\/projects\/(\d+)\/skills\/global\/files$/);
  if (globalSkillFilesMatch && req.method === 'GET') {
    const source = url.searchParams.get('source') as GlobalSkillSource | null;
    const name = url.searchParams.get('name');
    const pluginKey = url.searchParams.get('pluginKey') ?? undefined;
    if (!source || !name) {
      sendJson(res, 400, { error: 'Missing "source" or "name" query parameter' });
      return;
    }
    const dir = await resolveGlobalSkillDir(source, name, pluginKey);
    if (!dir) {
      sendJson(res, 404, { error: 'Skill not found' });
      return;
    }
    sendJson(res, 200, { files: await listGlobalSkillFiles(dir) });
    return;
  }

  // --- global skill file content (reads through symlinks; path is relative
  // to the resolved skill dir and confined to it) ---
  const globalSkillFileMatch = pathname.match(/^\/projects\/(\d+)\/skills\/global\/file$/);
  if (globalSkillFileMatch && req.method === 'GET') {
    const source = url.searchParams.get('source') as GlobalSkillSource | null;
    const name = url.searchParams.get('name');
    const pluginKey = url.searchParams.get('pluginKey') ?? undefined;
    const relPath = url.searchParams.get('path');
    if (!source || !name || !relPath) {
      sendJson(res, 400, { error: 'Missing "source", "name" or "path" query parameter' });
      return;
    }
    const dir = await resolveGlobalSkillDir(source, name, pluginKey);
    if (!dir) {
      sendJson(res, 404, { error: 'Skill not found' });
      return;
    }
    try {
      const file = await readGlobalSkillFile(dir, relPath);
      sendJson(res, 200, { path: relPath, content: file.content, size: file.size });
    } catch (e) {
      sendReaderError(res, e);
    }
    return;
  }

  // --- plugin tool rows (工具对象模型：每键 × 每可装档一行；effective 服务端
  //     唯一解析，PluginEnabledMap 的替换面) ---
  const pluginStateMatch = pathname.match(/^\/projects\/(\d+)\/plugins\/state$/);
  if (pluginStateMatch) {
    const project = deps.projects.getById(Number(pluginStateMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { rows: await readPluginRows(project.path) });
      return;
    }
    if (req.method === 'PUT') {
      let body: { runtime?: string; key?: string; scope?: string; state?: string };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      if (
        !isHarness(body.runtime) ||
        !body.key ||
        !body.scope ||
        !['user', 'project', 'local'].includes(body.scope) ||
        !body.state ||
        !['on', 'off', 'inherit'].includes(body.state)
      ) {
        sendJson(res, 400, {
          error: 'Missing or invalid "runtime"/"key"/"scope" (user|project|local)/"state" (on|off|inherit)',
        });
        return;
      }
      const scope = body.scope as 'user' | 'project' | 'local';
      const state = body.state as 'on' | 'off' | 'inherit';
      try {
        const installFace = pluginSurfaces().find((p) => p.harness === body.runtime);
        if (installFace) {
          // `deps.pluginSurface` 是 claude 的测试注入点（生产缺省经 registry 取面）。
          const surface =
            body.runtime === 'claude' && deps.pluginSurface
              ? deps.pluginSurface
              : installFace.surface;
          await surface.setEnabledOverride(project.path, scope, body.key, state);
        } else {
          // 仅启用面 harness（codex）：只有 user 档布尔写，无 inherit 删除语义。
          const stateFace = pluginStateSurfaces().find((s) => s.harness === body.runtime);
          if (!stateFace || scope !== 'user' || state === 'inherit') {
            sendJson(res, 400, {
              error: 'This runtime only supports user-scope on/off overrides',
            });
            return;
          }
          await stateFace.state.writeGlobalEnabled(body.key, state === 'on');
        }
        // 插件启停域变化 → 包视图（ToolkitSection）与行消费方（SkillGrid 徽标）重拉。
        deps.dataBus?.emit({ key: 'toolkit' });
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'Plugin state write failed' });
      }
      return;
    }
  }

  // --- plugin pack uninstall (harness-level, by registry key; works even
  //     after the market copy is gone — ToolkitSection rescans market roots,
  //     this is the only way off installed_plugins.json) ---
  const pluginUninstallMatch = pathname.match(/^\/projects\/(\d+)\/plugins\/uninstall$/);
  if (pluginUninstallMatch && req.method === 'POST') {
    let body: { runtime?: string; key?: string };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    if (!isHarness(body.runtime) || !body.key) {
      sendJson(res, 400, { error: 'Missing or invalid "runtime"/"key"' });
      return;
    }
    try {
      // runtime 声明了 plugins 槽才可卸；未补槽的 harness（如 codex）→ 400。
      // `deps.pluginSurface` 是 claude 的测试注入点（生产缺省经 registry 取面）。
      const surface =
        body.runtime === 'claude' && deps.pluginSurface
          ? deps.pluginSurface
          : pluginSurfaceFor(body.runtime);
      const { name, market } = surface.parsePluginKey(body.key);
      await surface.uninstall(name, market);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Plugin uninstall failed' });
    }
    return;
  }

  // --- MCP enable/disable overrides (project settings.json；词表 = 工具对象模型) ---
  const mcpEnableMatch = pathname.match(/^\/projects\/(\d+)\/mcp\/enable$/);
  if (mcpEnableMatch) {
    const project = deps.projects.getById(Number(mcpEnableMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    if (req.method === 'PUT') {
      let body: { name?: string; state?: string };
      try {
        body = JSON.parse(await readBody(req)) as { name?: string; state?: string };
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      if (!body.name || !body.state) {
        sendJson(res, 400, { error: 'Missing "name" or "state"' });
        return;
      }
      if (!['on', 'off', 'inherit'].includes(body.state)) {
        sendJson(res, 400, { error: 'Invalid "state" (on|off|inherit)' });
        return;
      }
      await setMcpEnableOverride(
        project.path,
        body.name,
        body.state as 'on' | 'off' | 'inherit',
      );
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // --- update detection (installed assets vs library sources) ---
  const updatesMatch = pathname.match(/^\/projects\/(\d+)\/updates$/);
  if (updatesMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(updatesMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const cache = deps.fingerprintCache ?? new FingerprintCache();
    if (!deps.libraries) {
      // 项目自有 weave 源（`.weave/plugins` 模板）与 init 生成物都不依赖 libraries
      // ——无库时照样报漂移（init 那半边是「待 init」提醒的唯一数据源）。
      const pluginTemplates = await detectPluginTemplateUpdates(project.path, cache);
      const initFiles = await detectInitFileUpdates(project.path);
      sendJson(res, 200, {
        skills: [],
        mcp: [],
        files: [],
        pluginTemplates,
        initFiles,
        available:
          pluginTemplates.filter((t) => t.outdated).length
          + initFiles.filter((f) => f.outdated && f.syncClass === 'auto').length,
        needsInit: needsInit(initFiles),
      });
      return;
    }
    const report = await detectUpdates(project.path, deps.libraries.list(), cache);
    sendJson(res, 200, report);
    return;
  }

  // --- apply a single update (overwrite one asset from its source) ---
  const updateMatch = pathname.match(/^\/projects\/(\d+)\/update$/);
  if (updateMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(updateMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    let body: {
      category?: string;
      name?: string;
      scope?: 'project' | 'user';
      agent?: Harness;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    if (!body.category || !body.name || !body.scope) {
      sendJson(res, 400, { error: 'Missing "category", "name", or "scope"' });
      return;
    }
    const validCategories = ['skill', 'mcp', 'command', 'agent', 'workflow', 'rule', 'output-style'];
    if (!validCategories.includes(body.category)) {
      sendJson(res, 400, { error: 'Invalid "category"' });
      return;
    }
    try {
      const index = await buildLibraryIndex(deps.libraries.list());
      await applyUpdate(
        project.path,
        {
          category: body.category as 'skill' | 'mcp' | 'command' | 'agent' | 'workflow' | 'rule' | 'output-style',
          name: body.name,
          scope: body.scope,
          agent: body.agent,
        },
        index,
      );
      sendJson(res, 200, { ok: true, category: body.category, name: body.name, scope: body.scope });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Update failed' });
    }
    return;
  }

  // --- sync all outdated assets ---
  const syncMatch = pathname.match(/^\/projects\/(\d+)\/sync-all$/);
  if (syncMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(syncMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    try {
      const cache = deps.fingerprintCache ?? new FingerprintCache();
      const result = await syncAll(project.path, deps.libraries.list(), cache);
      // 插件同步 additive 追加
      let payload: unknown = result;
      try {
        const knownIds = deps.hookPlugins?.list().map((p) => p.id) ?? [];
        const syncedAt = syncPlugins(project, knownIds, { projects: deps.projects });
        payload = { ...result, pluginSync: { syncedAt } };
      } catch {
        // 失败只丢附加字段，不改资产同步结果（R8）
      }
      sendJson(res, 200, payload);
      // 角标对账：物化落点是 `.claude/` 副本（不动 `.weave/plugins` 源），不会
      // 触发 plugin.reloaded——同步动作自己推一帧绝对值，其他客户端才不用等 hover。
      void deps.updatesRefresher?.refreshNow(true);
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Sync failed' });
    }
    return;
  }

  // --- project weave config（同步范围由 git 分类单点决定，这里只有 lastSyncAt）---
  const configMatch = pathname.match(/^\/projects\/(\d+)\/config$/);
  if (configMatch) {
    const project = deps.projects.getById(Number(configMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, await readProjectConfig(project.path));
      return;
    }
    if (req.method === 'PUT') {
      let body: Partial<ProjectConfig>;
      try {
        body = JSON.parse(await readBody(req)) as Partial<ProjectConfig>;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      const current = await readProjectConfig(project.path);
      const next: ProjectConfig = {
        lastSyncAt: body.lastSyncAt ?? current.lastSyncAt,
      };
      await writeProjectConfig(project.path, next);
      sendJson(res, 200, next);
      return;
    }
  }

  // --- statusline management ---
  // Global default template. Editing it re-renders every following project,
  // which is the per-project auto-sync mechanism.
  if (pathname === '/statusline/global') {
    if (req.method === 'GET') {
      sendJson(res, 200, { config: await readGlobalStatuslineConfig() });
      return;
    }
    if (req.method === 'PUT') {
      let body: StatuslineConfig;
      try {
        body = JSON.parse(await readBody(req)) as StatuslineConfig;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      try {
        await writeGlobalStatuslineConfig(body);
        // Auto-sync: regenerate scripts for every project that follows global.
        for (const p of deps.projects.list()) {
          const eff = await readStatuslineConfig(p.path);
          if (eff.source === 'global') {
            await applyStatuslineConfig(p.path, eff);
          }
        }
        deps.dataBus?.emit({ key: 'statusline' });
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'Global statusline update failed' });
      }
      return;
    }
  }

  // Shipped factory defaults — the panel's 恢复出厂 fetches these, so the
  // reset target always comes from the server (single source of truth).
  if (pathname === '/statusline/default' && req.method === 'GET') {
    sendJson(res, 200, { config: DEFAULT_STATUSLINE_CONFIG });
    return;
  }

  const statuslineMatch = pathname.match(/^\/projects\/(\d+)\/statusline$/);
  if (statuslineMatch) {
    const project = deps.projects.getById(Number(statuslineMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    if (req.method === 'GET') {
      const [config, script, globalConfig] = await Promise.all([
        readStatuslineConfig(project.path),
        readStatuslineScript(project.path),
        readGlobalStatuslineConfig(),
      ]);
      // 渲染脚本已算好的块事实（git 三块）：对话页底条摆同款块，前端不另算
      sendJson(res, 200, {
        config,
        script,
        globalConfig,
        facts: readStatuslineFacts(project.path),
      });
      return;
    }
    if (req.method === 'PUT') {
      let body: StatuslineConfig;
      try {
        body = JSON.parse(await readBody(req)) as StatuslineConfig;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      try {
        await applyStatuslineConfig(project.path, body);
        deps.dataBus?.emit({ key: 'statusline', projectPath: project.path });
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'Statusline update failed' });
      }
      return;
    }
  }

  // /events — Server-Sent Events stream of asset change events.
  if (pathname === '/events' && req.method === 'GET') {
    handleSse(req, res, deps);
    return;
  }

  // /assets?path=<encodedProjectPath> — read cached asset entries for a project.
  if (pathname === '/assets' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path');
    if (!projectPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return;
    }
    if (!deps.watch) {
      sendJson(res, 503, { error: 'Watch service unavailable' });
      return;
    }
    // 仓库标记来自包落盘记录（watch 缓存只知道文件在不在，不知道谁铺的）。
    const namespaces = await projectFileNamespaces(projectPath);
    const assets = deps.watch.getAssets(projectPath).map((a) => {
      const namespace = namespaces.get(a.relPath);
      return namespace ? { ...a, namespace } : a;
    });
    sendJson(res, 200, { projectPath, assets });
    return;
  }

  // /global-file-assets — curated machine-level harness files (~/.claude,
  // ~/.codex) for the global 文件资产 tree. A bounded whitelist walk, never a
  // home-directory scan.
  if (pathname === '/global-file-assets' && req.method === 'GET') {
    sendJson(res, 200, { assets: await listGlobalFileAssets() });
    return;
  }

  if (pathname === '/projects' && req.method === 'GET') {
    sendJson(res, 200, {
      projects: await withProjectHarnesses(deps.projects.list(), deps.harnesses),
    });
    return;
  }

  // GET /projects/archived — 归档面数据（仅基础信息；历史会话已在归档时清空）。
  if (pathname === '/projects/archived' && req.method === 'GET') {
    sendJson(res, 200, {
      projects: await withProjectHarnesses(deps.projects.listArchived(), deps.harnesses),
    });
    return;
  }

  // POST /projects/:id/archive — 归档：清空历史会话（派发→事件→会话行，顺序
  // 保证派发子查询还能圈到行）+ 焚毁管道文件（inbox/mirror/outbox，hook 侧
  // 镜像即刻消失）。项目行只留基础信息（archived_at 标记）；各消费面
  // （watch/mirror/inbox/同步）按「活跃项目」口径自动跳过，无需逐处剔除。
  // watcher 由 watch.reconcile 立即收掉（不等 5s 周期）。
  const archiveMatch = pathname.match(/^\/projects\/(\d+)\/archive$/);
  if (archiveMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(archiveMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    if (project.archivedAt) {
      sendJson(res, 200, {
        project,
        purged: { events: 0, dispatches: 0, sessions: 0, messages: 0 },
      });
      return; // 幂等：重复归档不动已清空的数据
    }
    const dispatches = deps.hookDispatches?.deleteByProject(project.id) ?? 0;
    const events = deps.hookEvents?.deleteByProject(project.id) ?? 0;
    // 事件清完（event_images 级联删）再回收孤儿上传件
    deps.uploads?.pruneUnreferenced();
    // 消息域先于会话行清（内存态按会话→项目归属圈；队列行按会话清）；订阅/序列同形
    // （序列按项目会话集圈「任一步目标」行，同样必须在会话行删除前执行）
    const messages = deps.messageDeliverer?.forgetProject(project.id) ?? 0;
    deps.sessionWatches?.deleteByProject(project.id);
    deps.sessionSequences?.deleteByProject(project.id);
    deps.sideQuestions?.repo.deleteByProject(project.id);
    const sessions = deps.hookSessions?.removeByProject(project.id) ?? 0;
    deps.projects.setArchived(project.id, true);
    purgeProjectPipeline(deps.hooksDir ?? hooksRoot(), project.token);
    deps.watch?.reconcile();
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, {
      project: deps.projects.getById(project.id),
      purged: { events, dispatches, sessions, messages },
    });
    return;
  }

  // POST /projects/:id/restore — 恢复：翻转归档位，重写注入镜像，watcher 由
  // reconcile 立即拉起（会话历史不回来——归档是删除不是暂停）。
  const restoreMatch = pathname.match(/^\/projects\/(\d+)\/restore$/);
  if (restoreMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(restoreMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    if (!project.archivedAt) {
      sendJson(res, 200, { project });
      return; // 幂等：活跃项目的恢复是 no-op
    }
    deps.projects.setArchived(project.id, false);
    deps.hookMirror?.syncProject(project.id);
    deps.watch?.reconcile();
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, { project: deps.projects.getById(project.id) });
    return;
  }

  // PUT /projects/order — dashboard 拖动排序持久化：payload = 完整目标顺序
  // （id 全量列表），repo 事务内全清重排，幂等。
  if (pathname === '/projects/order' && req.method === 'PUT') {
    let body: { ids?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { ids?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    if (!Array.isArray(body.ids) || !body.ids.every((id) => Number.isInteger(id))) {
      sendJson(res, 400, { error: 'Invalid "ids" (integer array expected)' });
      return;
    }
    deps.projects.setOrder(body.ids as number[]);
    deps.dataBus?.emit({ key: 'projects' });
    sendJson(res, 200, { projects: deps.projects.list() });
    return;
  }

  // GET /projects/:id/panes — 项目关终端多选弹窗的数据面：本项目名下可关的 pane
  // （cwd 恰为项目目录；窗口里别的目录的 pane 不进来）。枚举不到却计数说有 = 这个
  // preset 关不了远程 pane（wt 只数不关）→ 如实 409，不给空表装作「没有终端」。
  const panesMatch = pathname.match(/^\/projects\/(\d+)\/panes$/);
  if (panesMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(panesMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const settings = await readDaemonSettings();
    const list = deps.opener?.listPanes ?? defaultProjectOpener.listPanes!;
    try {
      sendJson(res, 200, { projectId: project.id, panes: await list(project.path, settings.terminal) });
    } catch (e) {
      sendJson(res, 409, { error: e instanceof Error ? e.message : 'Cannot list panes' });
    }
    return;
  }

  // GET /projects/:id/terminals — 会话终端「选哪个终端」弹窗的数据面：
  // 按最近活跃排序的可附加目标（窗口内的 tab）。枚举能力归后端——非 enumerable
  // 的 preset 无枚举通道 → 空表。
  const terminalsMatch = pathname.match(/^\/projects\/(\d+)\/terminals$/);
  if (terminalsMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(terminalsMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const settings = await readDaemonSettings();
    const list = deps.opener?.listTerminals ?? defaultProjectOpener.listTerminals!;
    const terminals = terminalBackendFor(settings.terminal).enumerable
      ? await list(project.path, settings.terminal)
      : [];
    sendJson(res, 200, { projectId: project.id, terminals });
    return;
  }

  // GET /terminals/counts — 项目卡「终端」角标：每项目已打开的终端数，单位 =
  // 该后端的可见屏幕（wezterm = tab，与「选哪个终端」弹窗的选项同一口径），
  // 不是分屏 pane、也不是会话数；枚举能力见 countOpenTerminals。
  // 陈旧值先给、后台对账：探测 = 每存活 socket spawn 一次 `wezterm cli`（实测
  // ~200ms），不该让响应等它；增量经 push 帧到达，正常消费方（SSE 客户端）
  // 不需要再打这枪。未接刷新器（测试注入缝）才现探。
  if (pathname === '/terminals/counts' && req.method === 'GET') {
    if (deps.terminalRefresher) {
      sendJson(res, 200, { counts: deps.terminalRefresher.lastSnapshot?.counts ?? {} });
      void deps.terminalRefresher.tick(true);
    } else {
      const opener = deps.opener ?? defaultProjectOpener;
      sendJson(res, 200, { counts: await readTerminalCounts(deps.projects.list(), opener) });
    }
    return;
  }

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

/** Upgrade a response to an SSE stream subscribed to watch + hook event sources. */
function handleSse(req: IncomingMessage, res: ServerResponse, deps: WeaveServerDeps): void {
  if (!deps.watch && !deps.hookBus && !deps.dataBus) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Event stream unavailable' }));
    return;
  }
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
  // （见 web/src/lib/sse.ts）。
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`);
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const unsubscribes: Array<() => void> = [];
  // 帧加 type 判别字段：旧前端忽略未知字段（asset 帧内容不变，向后兼容）。
  if (deps.watch) {
    unsubscribes.push(
      deps.watch.subscribe((e) => {
        res.write(`data: ${JSON.stringify({ type: 'asset', ...e })}\n\n`);
      }),
    );
    // 项目注册表变更（另一进程 weave init/scan 落库 → reconcile 检出）。
    // 帧无 projectPath 之外的资产字段，web 收到后整表重拉。
    unsubscribes.push(
      deps.watch.subscribeProjects((e) => {
        res.write(`data: ${JSON.stringify({ type: 'project', ...e })}\n\n`);
      }),
    );
  }
  if (deps.hookBus) {
    unsubscribes.push(
      deps.hookBus.subscribe((message) => {
        res.write(`data: ${JSON.stringify({ type: 'hook', ...message })}\n\n`);
      }),
    );
  }
  // 数据变更帧：带 payload = 后端已算好（前端直写状态）；不带 = 失效键
  // （前端按 key 调既有 fetcher 重拉）。
  if (deps.dataBus) {
    unsubscribes.push(
      deps.dataBus.subscribe((frame) => {
        const type = frame.payload === undefined ? 'invalidate' : 'push';
        res.write(`data: ${JSON.stringify({ type, ...frame })}\n\n`);
      }),
    );
  }

  // 新客户端补一份在途消息角标快照：推送只在变化时发，首帧不该等到下一次消息事件。
  deps.inflightRefresher?.refreshNow();
  // 终端角标同理：先补上次快照（无则跳过），再后台对一次账补差量——前端零轮询。
  deps.terminalRefresher?.onSubscriberJoin();
  // 项目行更新角标：补一份绝对值快照（含 0），页面一打开即准确，不必等 hover。
  deps.updatesRefresher?.onSubscriberJoin();

  req.on('close', () => {
    clearInterval(heartbeat);
    for (const unsubscribe of unsubscribes) unsubscribe();
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

/**
 * /settings 的对外形状：`ai` 段补派生布尔 `apiKeySet`（地址/模型来自 settings 表，
 * key 来自 `<dataDir>/ai.json`——密钥只写，GET/PUT 一律不回显）。
 */
function withAiStatus(settings: DaemonSettings, aiKeyPath?: string): Record<string, unknown> {
  const ai = settings.ai ?? DEFAULT_AI_SETTINGS;
  return {
    ...settings,
    ai: { baseUrl: ai.baseUrl, model: ai.model, apiKeySet: hasAiKey(aiKeyPath) },
  };
}

/** 落 settings 表前剥掉只写的 `apiKey`（它归 ai.json，不归本表）。 */
function stripAiKey(ai: { apiKey?: string | null } | undefined): Partial<AiSettings> | undefined {
  if (!ai) return undefined;
  const { apiKey: _writeOnly, ...rest } = ai;
  return rest;
}

function mime(filePath: string): string {
  if (filePath.endsWith('.js')) return 'text/javascript';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.html')) return 'text/html';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function clampLimit(raw: string | null): number {
  const n = Number(raw ?? '100');
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(Math.floor(n), 500);
}

interface InstallBody {
  category?: string;
  name?: string;
  sourceDir?: string;
  sourceFile?: string;
  mcpConfig?: McpServerConfig;
  /** 'project' (default) writes into the project; 'user' writes ~/.claude / ~/.codex. */
  scope?: 'project' | 'user';
  /** Which coding agent's surface to target (default: claude). */
  agent?: InstallAgent;
  /** plugin 类别：无 manifest 包合成最小 plugin.json 用（版本/描述）。 */
  version?: string;
  description?: string;
}

/**
 * 这次装卸要不要项目路径：user 档落在 home 下、与项目无关（codex 的 MCP 也住
 * 用户级，插件则只有 user 档）——路由挂在 `/projects/:id/` 下只是形状，全局面
 * 没有项目时不该因为这个 id 先吃一记 404。
 */
function needsProjectPath(body: { category?: string; scope?: string; agent?: string }): boolean {
  if (body.scope === 'user') return false;
  if (body.category === 'plugin') return false;
  // MCP 有没有项目档由 surface 答（codex 只有 user 档）。
  if (body.category === 'mcp') return !!mcpSurfaceOf(body.agent)?.mcpScopes().includes('project');
  return true;
}

/** 本次装卸目标的资产面；未注册的 agent → undefined（路由据此 400，不静默落 claude）。 */
function mcpSurfaceOf(agent: string | undefined) {
  const id = agent ?? 'claude';
  return assetSurfaces().find((s) => s.harness === id);
}

/** Map installer errors to HTTP statuses (409 conflict / 404 missing / 400 bad). */
function sendInstallError(res: ServerResponse, e: unknown): void {
  if (e instanceof InstallConflictError) {
    res.statusCode = 409;
  } else if (e instanceof AssetNotFoundError) {
    res.statusCode = 404;
  } else if (e instanceof ClaudeJsonCorruptError) {
    res.statusCode = 500; // refuse to corrupt ~/.claude.json
  } else if (e instanceof CodexTomlCorruptError) {
    res.statusCode = 500; // refuse to corrupt ~/.codex/config.toml
  } else {
    res.statusCode = 400;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Install failed' }));
}

/**
 * 资源市场清单行（批 9）：libraries 行 + resolve 后有效路径 + 清单元数据 +
 * legacy 外部源标记。repo 读侧已把 path 解析为绝对路径（R11）。
 * dataDir 由调用方传库实例值（生产 = getDataDir()；测试注入临时根）。
 */
async function marketItem(row: LibraryRow, dataDir: string): Promise<Record<string, unknown>> {
  const managed = isInsideDir(row.path, marketDir(dataDir));
  const manifest = managed ? await readManifest(row.path) : null;
  // 内置仓也登记在 libraries 里（落点是链接），但它既不是导入来的、也不能迁入/
  // 删除/查更新——右栏据此不摆那些按钮，别让它显示成「外部源」。
  const builtin = isBuiltinMarketDir(row.path, dataDir);
  return {
    id: row.id,
    kind: row.kind,
    addedAt: row.addedAt,
    path: row.path,
    relPath: isInsideDir(row.path, dataDir) ? toRelPosix(row.path, dataDir) : null,
    resourceId: managed ? path.basename(row.path) : null,
    managed,
    builtin,
    // 仓库 namespace = 资源管理按它分块的那个名字（内置仓 = `weave`）；不在市场
    // 内的 legacy 外部源没有仓库可归。
    namespace: managed ? marketIdOf(row.path, marketDir(dataDir)) : undefined,
    legacy: !manifest && !builtin,
    source: builtin ? 'builtin' : (manifest?.source ?? 'legacy'),
    origin: manifest?.origin ?? null,
    importedAt: manifest?.importedAt ?? null,
    commit: manifest?.commit ?? null,
    // 市场行资产类型 tag（skill/plugin/mods/mcp/…，0 计数不出现）；legacy 行同样扫
    tags: await assetTagsOf(row.path),
  };
}

/**
 * 资产类型 tag 聚合：一次编排四扫描（plugins 先算 → packRoots 排除包内资源，
 * skill 归 plugin 隶属），产出与资源管理文件树同词表的计数（0 计数不出现）。
 */
const FILE_TAG: Record<FileAssetCategory, string> = {
  command: 'command',
  agent: 'agent',
  workflow: 'workflow',
  rule: 'rules',
  'output-style': 'output-style',
};

async function scanAssetTags(libPath: string): Promise<Record<string, number>> {
  const { plugins, skills, mcp, files } = await getLibraryScan(libPath);
  const tags: Record<string, number> = {};
  const add = (tag: string, n: number) => {
    if (n > 0) tags[tag] = (tags[tag] ?? 0) + n;
  };
  add('skill', skills.length);
  add('mcp', mcp.length);
  for (const [cat, list] of Object.entries(files)) add(FILE_TAG[cat as FileAssetCategory] ?? cat, list.length);
  add('plugin', plugins.length);
  // mods ⊂ plugin（双 tag 语义，与 web file-tags mods→[plugin,mods] 一致）
  add('mods', plugins.filter((p) => p.kind === 'mod' || p.components.includes('mod')).length);
  return tags;
}

async function assetTagsOf(dir: string): Promise<Record<string, number>> {
  // legacy 外部源可能已被删除/不可读：降级为空 tag，不让整张清单 500
  try {
    return await scanAssetTags(dir);
  } catch {
    return {};
  }
}

/** Map reader errors to HTTP statuses (403 escape / 413 too large / 404 missing). */
function sendReaderError(res: ServerResponse, e: unknown): void {
  if (e instanceof PathEscapeError) {
    res.statusCode = 403;
  } else if (e instanceof FileTooLargeError) {
    res.statusCode = 413;
  } else if (e instanceof AssetNotFoundError) {
    res.statusCode = 404;
  } else {
    res.statusCode = 400;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'Read failed' }));
}
