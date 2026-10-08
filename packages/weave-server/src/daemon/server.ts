import http from 'node:http';
import { WEAVE_VERSION } from '../version.js';
import type { Harness } from '@weave/core';
import { checkHarness, INJECTABLE_EVENTS } from '@weave/core';
import type { EventSource, HarnessRegistry } from '@weave/harness';
import { frameFacts } from '@weave/harness';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ProjectRepository, ProjectRow } from '../repositories/projects.js';
import type { HookEventRepository, HookEventInput } from '../repositories/hook-events.js';
import type { LibraryRepository, LibraryRow } from '../repositories/libraries.js';
import type { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { HookReport, NormalizedHookPayload } from '../hooks/types.js';
import type { HookRuleRegistry } from '../hooks/registry.js';
import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { HookEventBus } from '../hooks/bus.js';
import type { ResumeRunner } from '../hooks/resume-runner.js';
import type { PluginManager } from '../hooks/plugin-loader.js';
import type { PluginStateRepository } from '../repositories/plugin-states.js';
import { syncPlugins } from '../hooks/plugin-project-state.js';
import type { WatchService } from '../watch/watch-service.js';
import { scanLibrarySkills, scanLibraryMcp, scanLibraryFileAssets, scanLibraryPlugins } from '../install/scanner.js';
import {
  installSkill,
  uninstallSkill,
  installMcp,
  uninstallMcp,
  installFileAsset,
  uninstallFileAsset,
  readMcpServers,
  InstallConflictError,
  AssetNotFoundError,
} from '../install/installer.js';
import type { McpServerConfig, InstallAgent } from '../install/installer.js';
import { isFileAssetCategory, type FileAssetCategory } from '../install/file-assets.js';
import { installCapabilities } from '../install/capabilities.js';
import {
  readGlobalMcpServers,
  writeGlobalMcpServer,
  removeGlobalMcpServer,
  installGlobalSkill,
  uninstallGlobalSkill,
  readGlobalSkillGroups,
  readClaudePluginEnabled,
  writeClaudePluginEnabled,
  readCodexPluginEnabled,
  writeCodexPluginEnabled,
  resolveGlobalSkillDir,
  listGlobalSkillFiles,
  readGlobalSkillFile,
  ClaudeJsonCorruptError,
} from '../install/global-config.js';
import type { GlobalSkillSource } from '../install/global-config.js';
import {
  readCodexMcpServers,
  writeCodexMcpServer,
  removeCodexMcpServer,
  codexMcpExists,
  CodexTomlCorruptError,
} from '../install/codex-toml.js';
import { readMcpEnableMap, setMcpEnableState } from '../install/settings-mcp.js';
import type { McpEnableState } from '../install/settings-mcp.js';
import { readProjectConfig, writeProjectConfig } from '../install/project-config.js';
import type { ProjectConfig } from '../install/project-config.js';
import { applyUpdate, syncAll } from '../install/apply-update.js';
import { buildLibraryIndex } from '../install/library-index.js';
import { importFromDir, importFromGit, importLibraryIntoMarket } from '../market/import.js';
import { marketDir, readManifest } from '../market/manifest.js';
import { isInsideDir, toRelPosix } from '../market/resolve.js';
import { checkMarketUpdates } from '../market/updates.js';
import { refreshMarketItems } from '../market/refresh.js';
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
  applyStatuslineConfig,
  readGlobalStatuslineConfig,
  writeGlobalStatuslineConfig,
} from '../statusline/manager.js';
import { DEFAULT_STATUSLINE_CONFIG, type StatuslineConfig } from '../statusline/config.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { detectUpdates } from '../install/updates.js';
import { extractBearerToken } from './auth.js';
import { readBody, sendJson } from './http.js';
import { handleHooksRoutes } from './hooks-routes.js';
import { handleToolkitRoutes } from './toolkit-routes.js';
import type { ToolkitService } from '../hooks/toolkit.js';
import { listBrowseRoots, listDirectoryChildren } from './fs-browser.js';
import {
  readDaemonSettings,
  writeDaemonSettings,
  terminalPresetsFor,
  type DaemonSettings,
} from './settings.js';
import { defaultProjectOpener, type ProjectOpener } from './opener.js';
import { DAEMON_HOST } from './port.js';

export const DAEMON_VERSION = WEAVE_VERSION;

export interface WeaveServerDeps {
  projects: ProjectRepository;
  daemonToken: string;
  port: number;
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
  /** Directory of the built SPA to statically host; optional. */
  staticDir?: string;
  /** Directory-opening backend for the project context menu; spied in tests. */
  opener?: ProjectOpener;
  // ---- D3 hooks subsystem (all optional so existing tests can omit them) ----
  /** In-memory rule index (match candidates + CRUD facade). */
  hookRegistry?: HookRuleRegistry;
  /** Dispatch (运行态) store. */
  hookDispatches?: HookDispatchRepository;
  /** Session titles (rename 双向). */
  hookSessions?: SessionRepository;
  /** Hook event bus — SSE subscribes alongside the watch service. */
  hookBus?: HookEventBus;
  /** Event dispatcher; when present, POST /hooks runs rules on the response path. */
  hookDispatcher?: HookDispatcher;
  /** 指令池 resume 执行器；POST /hooks/dispatches/:id/run 依赖它。 */
  hookRunner?: ResumeRunner;
  /** 插件管理面；GET /hooks/plugins 与 toggle 依赖它（loader 异步就绪前返回空表）。 */
  hookPlugins?: PluginManager;
  /** D3 插件全局开关行；GET /hooks/plugins?projectId= 的 effective 回落源。 */
  pluginStates?: PluginStateRepository;
  /** 批 10 工具包服务；/projects/:id/toolkit 与 /toolkit/dirs 依赖它。 */
  toolkit?: ToolkitService;
}

/** 该事件能否把注入内容带回响应体（白名单按 harness 分表，与 dispatcher 同源）。 */
function injectableEvent(source: Harness, eventType: string): boolean {
  const allowed = INJECTABLE_EVENTS[source] as readonly string[] | undefined;
  return allowed !== undefined && allowed.includes(eventType);
}

/**
 * 采集事件落库 + 会话 touch + SSE 广播 + 规则分发。响应路径（可注入事件，需要
 * 把 additionalContext/sessionTitle 带回去）与后台路径（不可注入事件）共用。
 */
async function ingestEvent(
  deps: WeaveServerDeps,
  project: ProjectRow,
  input: HookEventInput,
): Promise<{ id: number; outcome: { additionalContext?: string; sessionTitle?: string } }> {
  const id = deps.hookEvents!.insert(input);
  // 会话 upsert：刷新 last_seen_at（rename 双向在 dispatcher/批3 中消费 session_title）。
  if (deps.hookSessions && input.sessionId) {
    deps.hookSessions.touch(input.sessionId, project.id);
  }
  // payload 解析上提：SSE 帧（子 agent 字段）与分发共用，只 parse 一次；
  // 帧字段的 Claude 协议知识在 harness 侧（frameFacts），路由只透传。
  let payload: NormalizedHookPayload | null = null;
  try {
    payload = JSON.parse(input.payload) as NormalizedHookPayload;
  } catch {
    payload = null;
  }
  // 每条采集事件都推 SSE（与规则命中无关）——任务面板靠它实时刷新。
  deps.hookBus?.emit({
    kind: 'event.ingested',
    eventId: id,
    projectId: project.id,
    sessionId: input.sessionId ?? null,
    eventType: input.eventType,
    ...frameFacts(payload),
    at: new Date().toISOString(),
  });
  // D3 分发：命中 inject 时把 additionalContext 放进返回体，由 hook-handler.cjs
  // 输出给会话。失败降级为无动作。
  let outcome: { additionalContext?: string; sessionTitle?: string } = {};
  if (deps.hookDispatcher) {
    outcome = await deps.hookDispatcher.onIngest({
      eventId: id,
      project,
      sessionId: input.sessionId ?? null,
      payload:
        payload ?? {
          eventType: input.eventType,
          toolName: null,
          toolInput: null,
          toolResponse: null,
          cwd: null,
          transcriptPath: null,
          raw: null,
        },
      source: input.source,
    });
  }
  return { id, outcome };
}

/** Create the daemon HTTP server (bound to 127.0.0.1, no TLS). */
export function createWeaveServer(deps: WeaveServerDeps): Server {
  // Ensure a long-lived fingerprint cache so update detection reuses hashes.
  const fingerprintCache = deps.fingerprintCache ?? new FingerprintCache();
  const serverDeps: WeaveServerDeps = { ...deps, fingerprintCache };
  // 批 4b：分派列表优先由 harness registry 派生（图②），回退 deps.adapters
  //（测试/兼容注入）——装配期算一次，不在每请求重建。
  const eventSources: readonly EventSource[] = serverDeps.harnesses
    ? serverDeps.harnesses.byCapability('events').flatMap((d) => d.events ?? [])
    : (serverDeps.adapters ?? []);
  return http.createServer((req, res) => {
    void handleRequest(req, res, serverDeps, eventSources);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  eventSources: readonly EventSource[],
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

  // /hooks — authenticated per-project: the bearer token both authenticates
  // AND identifies the project (projects.getByToken). Independent of the
  // daemon token used by the CLI/dashboard for the routes below.
  if (pathname === '/hooks' && req.method === 'POST') {
    const token = extractBearerToken(req);
    const project = token ? deps.projects.getByToken(token) : undefined;
    if (!project) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (!deps.hookEvents || (!deps.adapters && !deps.harnesses)) {
      sendJson(res, 503, { error: 'Hook ingestion unavailable' });
      return;
    }
    let report: HookReport;
    try {
      report = JSON.parse(await readBody(req)) as HookReport;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    if (!report.source || !report.eventType) {
      sendJson(res, 400, { error: 'Missing "source" or "eventType"' });
      return;
    }
    // 批 4b：查找在装配期派生的 eventSources（harnesses 优先，回退 deps.adapters）。
    const adapter = eventSources.find((a) => a.source === report.source);
    if (!adapter) {
      sendJson(res, 400, { error: `Unknown hook source: ${report.source}` });
      return;
    }
    // EventSource.normalize 返回 unknown（harness 不依赖 server 类型）；
    // 落库行结构由 ClaudeEventSource 保证，同源断言后 insert。
    const input = adapter.normalize(report, project.id) as HookEventInput;
    // 不可注入事件（PreToolUse/Notification 等）：响应体里带不走 additionalContext，
    // 落库/touch/SSE/分发与这次 hook 的返回无关 → 先 ack，后台做完，别把写路径
    // 压在 Claude Code 的同步等待上（hook 是同步模型，响应越短越安全）。
    if (!injectableEvent(input.source, input.eventType)) {
      void ingestEvent(deps, project, input).catch(() => {});
      sendJson(res, 202, {
        accepted: true,
        projectId: project.id,
        source: input.source,
        eventType: input.eventType,
      });
      return;
    }
    const { id, outcome } = await ingestEvent(deps, project, input);
    sendJson(res, 201, {
      id,
      projectId: project.id,
      source: input.source,
      eventType: input.eventType,
      ...outcome,
    });
    return;
  }

  // API routes below require the daemon token. EventSource cannot set headers,
  // so accept the token as a query param too (used by /events). Static SPA
  // assets (served further down) are intentionally unauthenticated — the
  // browser loads index.html and its bundles before any token is available.
  const token = extractBearerToken(req) ?? url.searchParams.get('token');
  const isAuthed = token === deps.daemonToken;
  const requireAuth = (): boolean => {
    if (!isAuthed) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return false;
    }
    return true;
  };

  // D3 hooks 子路由（规则/派发/会话）——未命中返回 false，主链继续。
  if (await handleHooksRoutes(req, res, deps, pathname, url, isAuthed)) return;

  // 批 10 工具包子路由（包清单/开关/外置目录）——未命中返回 false，主链继续。
  if (await handleToolkitRoutes(req, res, deps, pathname, url, isAuthed)) return;

  // GET /projects/:id/hooks — hook events for the task view (by session).
  const hooksMatch = pathname.match(/^\/projects\/(\d+)\/hooks$/);
  if (hooksMatch && req.method === 'GET') {
    if (!requireAuth()) return;
    if (!deps.hookEvents) {
      sendJson(res, 503, { error: 'Hook ingestion unavailable' });
      return;
    }
    const projectId = Number(hooksMatch[1]);
    const limit = clampLimit(url.searchParams.get('limit'));
    const sessionId = url.searchParams.get('sessionId');
    const beforeIdRaw = url.searchParams.get('beforeId');
    const beforeId = beforeIdRaw ? Number(beforeIdRaw) : undefined;
    // sessionId 过滤语义（任务视图按会话画事件链）：projectId 仅作鉴权锚点——
    // 会话可能采集到跨项目事件，双条件过滤会丢事件。
    if (sessionId) {
      sendJson(res, 200, { events: deps.hookEvents.listBySession(sessionId, limit ?? 300, beforeId) });
      return;
    }
    sendJson(res, 200, { events: deps.hookEvents.listByProject(projectId, limit) });
    return;
  }

  // --- daemon settings (terminal preset for "open in terminal") ---
  if (pathname === '/settings') {
    if (!requireAuth()) return;
    if (req.method === 'GET') {
      sendJson(res, 200, {
        settings: await readDaemonSettings(),
        presets: terminalPresetsFor(process.platform),
        platform: process.platform,
      });
      return;
    }
    if (req.method === 'PUT') {
      let body: Partial<DaemonSettings>;
      try {
        body = JSON.parse(await readBody(req)) as Partial<DaemonSettings>;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      const saved = await writeDaemonSettings(body as DaemonSettings);
      // 保留期等事件策略改动即刻生效：重置被动清理天标记，下一条事件写入
      // 就按新配置重扫（否则要等次日跨天）。
      deps.hookEvents?.resetPrune();
      sendJson(res, 200, saved);
      return;
    }
  }

  // --- open a project directory in the file manager or a terminal ---
  const openMatch = pathname.match(/^\/projects\/(\d+)\/open$/);
  if (openMatch && req.method === 'POST') {
    if (!requireAuth()) return;
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
      }
      sendJson(res, 200, { ok: true, target: body.target, path: project.path });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Open failed' });
    }
    return;
  }

  // --- cross-platform directory browsing (powers the web folder picker) ---
  if (pathname === '/fs/roots' && req.method === 'GET') {
    if (!requireAuth()) return;
    const libraryPaths = deps.libraries ? deps.libraries.list().map((l) => l.path) : [];
    const roots = await listBrowseRoots(libraryPaths);
    sendJson(res, 200, { roots });
    return;
  }
  if (pathname === '/fs/children' && req.method === 'GET') {
    if (!requireAuth()) return;
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
    if (!requireAuth()) return;
    sendJson(res, 200, installCapabilities());
    return;
  }

  // --- libraries (asset sources for the install panel) ---
  if (pathname === '/libraries' && req.method === 'GET') {
    if (!requireAuth()) return;
    sendJson(res, 200, { libraries: deps.libraries ? deps.libraries.list() : [] });
    return;
  }
  if (pathname === '/libraries' && req.method === 'POST') {
    if (!requireAuth()) return;
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
    sendJson(res, 201, row);
    return;
  }
  const libAssetsMatch = pathname.match(/^\/libraries\/(\d+)\/assets$/);
  if (libAssetsMatch && req.method === 'GET') {
    if (!requireAuth()) return;
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    const lib = deps.libraries.getById(Number(libAssetsMatch[1]));
    if (!lib) {
      sendJson(res, 404, { error: 'Library not found' });
      return;
    }
    // 先发现插件包：包是原子单元，包内 skill/表面成分/mcp 隶属该包
    // （随包启停，不独立安装）——packRoots 含谓词命中但解析为空的外壳包。
    // packRoots 恒算（与 kind 门控解耦：mcp 库的包内 skill 同样不泄漏）；
    // plugins 展示字段维持 skill|both 门控。
    const { plugins: allPlugins, packRoots } = await scanLibraryPlugins(lib.path);
    const plugins = lib.kind === 'skill' || lib.kind === 'both' ? allPlugins : [];
    const skills = await scanLibrarySkills(lib.path, packRoots);
    const mcp =
      lib.kind === 'mcp' || lib.kind === 'both' ? await scanLibraryMcp(lib.path, packRoots) : [];
    const scanned =
      lib.kind === 'skill' || lib.kind === 'both'
        ? await scanLibraryFileAssets(lib.path, packRoots)
        : null;
    // 扫描结果按分类分组，出参按 web 契约摊平为扁平数组（每项自带 category）
    const files = scanned ? Object.values(scanned).flat() : null;
    sendJson(res, 200, { library: lib, skills, mcp, files, plugins });
    return;
  }
  const libMatch = pathname.match(/^\/libraries\/(\d+)$/);
  if (libMatch && req.method === 'DELETE') {
    if (!requireAuth()) return;
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    deps.libraries.remove(Number(libMatch[1]));
    sendJson(res, 200, { ok: true });
    return;
  }

  // --- 资源市场（批 9）：清单 / 双导入 / 删除 / legacy 外部源迁入 ---
  if (pathname === '/market' && req.method === 'GET') {
    if (!requireAuth()) return;
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
    if (!requireAuth()) return;
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
        clearAssetTagsCache(); // 磁盘已变 → tag 计数缓存失效（响应前清，防回 stale）
        sendJson(res, 201, {
          item: await marketItem(deps.libraries.getById(imported.libraryId)!, deps.libraries.dataDir),
        });
      } else if (body.kind === 'git' && body.url) {
        const imported = await importFromGit(body.url, importDeps);
        if (imported.refreshed) deps.fingerprintCache?.invalidate(imported.dir);
        clearAssetTagsCache();
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
    if (!requireAuth()) return;
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
      .filter((r) => !body.ids?.length || body.ids.includes(r.id));
    const results = await checkMarketUpdates(rows.map((r) => ({ id: r.id, dir: r.path })));
    sendJson(res, 200, { results });
    return;
  }
  // 刷新市场缓存（M4 一键更新）：dir 重拷 / git 重 clone + 回写 commit；body 可空 = 全量。
  if (pathname === '/market/refresh' && req.method === 'POST') {
    if (!requireAuth()) return;
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
    const targets = deps.libraries
      .list()
      .filter((r) => !body.ids?.length || body.ids.includes(r.id))
      .map((r) => ({ id: r.id, dir: r.path }));
    const results = await refreshMarketItems(targets, {
      libraries: deps.libraries,
      dataDir: deps.libraries.dataDir,
    });
    const dirOf = new Map(targets.map((t) => [t.id, t.dir]));
    for (const r of results) {
      if (r.status === 'refreshed') {
        const dir = dirOf.get(r.id);
        if (dir) deps.fingerprintCache?.invalidate(dir);
      }
    }
    if (results.some((r) => r.status === 'refreshed')) clearAssetTagsCache();
    sendJson(res, 200, { results });
    return;
  }
  const marketMatch = pathname.match(/^\/market\/(\d+)$/);
  if (marketMatch && req.method === 'DELETE') {
    if (!requireAuth()) return;
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return;
    }
    const row = deps.libraries.getById(Number(marketMatch[1]));
    if (!row) {
      sendJson(res, 404, { error: 'Library not found' });
      return;
    }
    if (!isInsideDir(row.path, marketDir())) {
      sendJson(res, 400, { error: 'Not a market resource (legacy row — use DELETE /libraries/:id)' });
      return;
    }
    await fs.promises.rm(row.path, { recursive: true, force: true });
    deps.libraries.remove(row.id);
    clearAssetTagsCache();
    // 简化裁决：只删市场目录与 libraries 行；装面副本（链接/复制）不级联卸载。
    sendJson(res, 200, {
      ok: true,
      removed: row.path,
      installedCopiesKept: true,
      note: 'Installed copies are kept; uninstall them from the assets panel if needed.',
    });
    return;
  }
  const migrateMatch = pathname.match(/^\/libraries\/(\d+)\/market-import$/);
  if (migrateMatch && req.method === 'POST') {
    if (!requireAuth()) return;
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
      const imported = await importLibraryIntoMarket(row, {
        libraries: deps.libraries,
        dataDir: deps.libraries.dataDir,
      });
      clearAssetTagsCache(); // 迁入 = 新落盘内容
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
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(installMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    let body: InstallBody;
    try {
      body = JSON.parse(await readBody(req)) as InstallBody;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    try {
      if (body.category === 'skill') {
        if (!body.name || !body.sourceDir) {
          sendJson(res, 400, { error: 'Missing "name" or "sourceDir"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        const target =
          body.scope === 'global'
            ? await installGlobalSkill(body.sourceDir, body.name, agent)
            : await installSkill(project.path, body.sourceDir, body.name, agent);
        sendJson(res, 201, { category: 'skill', name: body.name, scope: body.scope ?? 'project', agent, path: target });
      } else if (body.category && isFileAssetCategory(body.category)) {
        if (!body.name || !body.sourceFile) {
          sendJson(res, 400, { error: 'Missing "name" or "sourceFile"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        const scope = body.scope ?? 'project';
        const target = await installFileAsset(
          project.path,
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
        if (body.agent === 'codex') {
          // Codex MCP servers live in ~/.codex/config.toml (user-level only)
          if (body.scope === 'project') {
            sendJson(res, 400, { error: 'Codex MCP servers are user-level (~/.codex/config.toml) — use scope "global"' });
            return;
          }
          if (await codexMcpExists(body.name)) {
            sendInstallError(res, new InstallConflictError(`MCP server "${body.name}" is already configured in ~/.codex/config.toml`));
            return;
          }
          await writeCodexMcpServer(body.name, body.mcpConfig as McpServerConfig);
        } else if (body.scope === 'global') {
          await writeGlobalMcpServer(body.name, body.mcpConfig as McpServerConfig);
        } else {
          await installMcp(project.path, body.name, body.mcpConfig as McpServerConfig);
        }
        sendJson(res, 201, {
          category: 'mcp',
          name: body.name,
          scope: body.agent === 'codex' ? 'global' : (body.scope ?? 'project'),
          agent: body.agent ?? 'claude',
        });
      } else {
        sendJson(res, 400, { error: 'Invalid "category" (skill|mcp|command|agent|workflow|rule|output-style)' });
      }
    } catch (e) {
      sendInstallError(res, e);
    }
    return;
  }
  const uninstallMatch = pathname.match(/^\/projects\/(\d+)\/uninstall$/);
  if (uninstallMatch && req.method === 'POST') {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(uninstallMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    let body: {
      category?: string;
      name?: string;
      scope?: 'project' | 'global';
      agent?: Harness;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    try {
      if (body.category === 'skill') {
        if (!body.name) {
          sendJson(res, 400, { error: 'Missing "name"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        if (body.scope === 'global') await uninstallGlobalSkill(body.name, agent);
        else await uninstallSkill(project.path, body.name, agent);
      } else if (body.category && isFileAssetCategory(body.category)) {
        if (!body.name) {
          sendJson(res, 400, { error: 'Missing "name"' });
          return;
        }
        await uninstallFileAsset(
          project.path,
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
        if (body.agent === 'codex') {
          if (!(await removeCodexMcpServer(body.name))) {
            sendInstallError(
              res,
              new AssetNotFoundError(`MCP server "${body.name}" is not configured in ~/.codex/config.toml`),
            );
            return;
          }
        } else if (body.scope === 'global') await removeGlobalMcpServer(body.name);
        else await uninstallMcp(project.path, body.name);
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
    if (!requireAuth()) return;
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
    if (!requireAuth()) return;
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

  // --- mcp servers (project .mcp.json + global ~/.claude.json) ---
  const mcpMatch = pathname.match(/^\/projects\/(\d+)\/mcp$/);
  if (mcpMatch && req.method === 'GET') {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(mcpMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const [projectServers, globalServers, codexServers] = await Promise.all([
      readMcpServers(project.path),
      safeReadGlobalMcp(),
      readCodexMcpServers().catch(() => ({})),
    ]);
    sendJson(res, 200, {
      project: projectServers,
      global: globalServers,
      codex: codexServers,
    });
    return;
  }

  // --- harness health checks (read-only, 批 8): structured results from core,
  // rendered by each client's own dictionary ---
  const harnessChecksMatch = pathname.match(/^\/projects\/(\d+)\/harness-checks$/);
  if (harnessChecksMatch && req.method === 'GET') {
    if (!requireAuth()) return;
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
    if (!requireAuth()) return;
    sendJson(res, 200, { groups: await readGlobalSkillGroups() });
    return;
  }

  // --- global skill file listing (resolves symlinks; source/name/pluginKey
  // identify the skill so the client never supplies an arbitrary path) ---
  const globalSkillFilesMatch = pathname.match(/^\/projects\/(\d+)\/skills\/global\/files$/);
  if (globalSkillFilesMatch && req.method === 'GET') {
    if (!requireAuth()) return;
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
    if (!requireAuth()) return;
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

  // --- plugin enable state (Claude settings.json + Codex config.toml) ---
  const pluginEnabledMatch = pathname.match(/^\/projects\/(\d+)\/plugins\/enabled$/);
  if (pluginEnabledMatch) {
    if (!requireAuth()) return;
    if (req.method === 'GET') {
      const [claude, codex] = await Promise.all([
        readClaudePluginEnabled(),
        readCodexPluginEnabled(),
      ]);
      sendJson(res, 200, { claude, codex });
      return;
    }
    if (req.method === 'PUT') {
      let body: { runtime?: string; key?: string; enabled?: boolean };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      if (
        !body.key ||
        typeof body.enabled !== 'boolean' ||
        (body.runtime !== 'claude' && body.runtime !== 'codex')
      ) {
        sendJson(res, 400, { error: 'Missing or invalid "runtime"/"key"/"enabled"' });
        return;
      }
      if (body.runtime === 'claude') await writeClaudePluginEnabled(body.key, body.enabled);
      else await writeCodexPluginEnabled(body.key, body.enabled);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // --- MCP enable/disable overrides (project settings.json) ---
  const mcpEnableMatch = pathname.match(/^\/projects\/(\d+)\/mcp\/enable$/);
  if (mcpEnableMatch) {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(mcpEnableMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, await readMcpEnableMap(project.path));
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
      if (!['enabled', 'disabled', 'default'].includes(body.state)) {
        sendJson(res, 400, { error: 'Invalid "state" (enabled|disabled|default)' });
        return;
      }
      await setMcpEnableState(project.path, body.name, body.state as McpEnableState);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // --- update detection (installed assets vs library sources) ---
  const updatesMatch = pathname.match(/^\/projects\/(\d+)\/updates$/);
  if (updatesMatch && req.method === 'GET') {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(updatesMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    if (!deps.libraries) {
      sendJson(res, 200, { skills: [], mcp: [], files: [], available: 0 });
      return;
    }
    const report = await detectUpdates(
      project.path,
      deps.libraries.list(),
      deps.fingerprintCache ?? new FingerprintCache(),
    );
    sendJson(res, 200, report);
    return;
  }

  // --- apply a single update (overwrite one asset from its source) ---
  const updateMatch = pathname.match(/^\/projects\/(\d+)\/update$/);
  if (updateMatch && req.method === 'POST') {
    if (!requireAuth()) return;
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
      scope?: 'project' | 'global';
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
    if (!requireAuth()) return;
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
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Sync failed' });
    }
    return;
  }

  // --- project weave config (auto-sync toggle) ---
  const configMatch = pathname.match(/^\/projects\/(\d+)\/config$/);
  if (configMatch) {
    if (!requireAuth()) return;
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
        autoSync: body.autoSync ?? current.autoSync,
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
    if (!requireAuth()) return;
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
    if (!requireAuth()) return;
    sendJson(res, 200, { config: DEFAULT_STATUSLINE_CONFIG });
    return;
  }

  const statuslineMatch = pathname.match(/^\/projects\/(\d+)\/statusline$/);
  if (statuslineMatch) {
    if (!requireAuth()) return;
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
      sendJson(res, 200, { config, script, globalConfig });
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
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'Statusline update failed' });
      }
      return;
    }
  }

  // /events — Server-Sent Events stream of asset change events.
  if (pathname === '/events' && req.method === 'GET') {
    if (!requireAuth()) return;
    handleSse(req, res, deps);
    return;
  }

  // /assets?path=<encodedProjectPath> — read cached asset entries for a project.
  if (pathname === '/assets' && req.method === 'GET') {
    if (!requireAuth()) return;
    const projectPath = url.searchParams.get('path');
    if (!projectPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return;
    }
    if (!deps.watch) {
      sendJson(res, 503, { error: 'Watch service unavailable' });
      return;
    }
    sendJson(res, 200, { projectPath, assets: deps.watch.getAssets(projectPath) });
    return;
  }

  // /global-file-assets — curated machine-level harness files (~/.claude,
  // ~/.codex) for the global 文件资产 tree. A bounded whitelist walk, never a
  // home-directory scan.
  if (pathname === '/global-file-assets' && req.method === 'GET') {
    if (!requireAuth()) return;
    sendJson(res, 200, { assets: await listGlobalFileAssets() });
    return;
  }

  if (pathname === '/projects' && req.method === 'GET') {
    if (!requireAuth()) return;
    sendJson(res, 200, { projects: deps.projects.list() });
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

/** Upgrade a response to an SSE stream subscribed to watch + hook event sources. */
function handleSse(req: IncomingMessage, res: ServerResponse, deps: WeaveServerDeps): void {
  if (!deps.watch && !deps.hookBus) {
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

  req.on('close', () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  });
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
      res.end(data);
    });
  });
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
  /** 'project' (default) writes into the project; 'global' writes ~/.claude / ~/.codex. */
  scope?: 'project' | 'global';
  /** Which coding agent's surface to target (default: claude). */
  agent?: InstallAgent;
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
 * Read global MCP servers, tolerating a corrupt ~/.claude.json: return empty
 * rather than throwing, so a broken global config never breaks the whole MCP
 * view (the user can still see+manage project-scope servers).
 */
async function safeReadGlobalMcp(): Promise<Record<string, McpServerConfig>> {
  try {
    return await readGlobalMcpServers();
  } catch {
    return {};
  }
}

/**
 * 资源市场清单行（批 9）：libraries 行 + resolve 后有效路径 + 清单元数据 +
 * legacy 外部源标记。repo 读侧已把 path 解析为绝对路径（R11）。
 * dataDir 由调用方传库实例值（生产 = getDataDir()；测试注入临时根）。
 */
async function marketItem(row: LibraryRow, dataDir: string): Promise<Record<string, unknown>> {
  const managed = isInsideDir(row.path, marketDir(dataDir));
  const manifest = managed ? await readManifest(row.path) : null;
  return {
    id: row.id,
    kind: row.kind,
    addedAt: row.addedAt,
    path: row.path,
    relPath: isInsideDir(row.path, dataDir) ? toRelPosix(row.path, dataDir) : null,
    resourceId: managed ? path.basename(row.path) : null,
    managed,
    legacy: !manifest,
    source: manifest?.source ?? 'legacy',
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
  const { plugins, packRoots } = await scanLibraryPlugins(libPath);
  const [skills, mcp, files] = await Promise.all([
    scanLibrarySkills(libPath, packRoots),
    scanLibraryMcp(libPath, packRoots),
    scanLibraryFileAssets(libPath, packRoots),
  ]);
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

/**
 * tag 计数缓存（四扫描贵、行数少）：导入/刷新/删除/迁入改写磁盘后
 * clear-all 重算；键为库行的绝对路径。
 */
const assetTagsCache = new Map<string, Record<string, number>>();

function clearAssetTagsCache(): void {
  assetTagsCache.clear();
}

async function assetTagsOf(dir: string): Promise<Record<string, number>> {
  const hit = assetTagsCache.get(dir);
  if (hit !== undefined) return hit;
  // legacy 外部源可能已被删除/不可读：降级为空 tag，不让整张清单 500
  let tags: Record<string, number> = {};
  try {
    tags = await scanAssetTags(dir);
  } catch {
    /* 空 tag */
  }
  assetTagsCache.set(dir, tags);
  return tags;
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
