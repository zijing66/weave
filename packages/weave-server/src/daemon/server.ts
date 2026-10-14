import http from 'node:http';
import { WEAVE_VERSION } from '../version.js';
import type { Harness } from '@weavecode/core';
import { checkHarness, isHarness } from '@weavecode/core';
import type { EventSource, HarnessRegistry, PluginSurface } from '@weavecode/harness';
import fs from 'node:fs';
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
import type { TerminalCountsRefresher } from './terminal-counts-refresher.js';
import type { ResumeRunner } from '../hooks/resume-runner.js';
import type { MessageDeliverer } from '../hooks/message-deliverer.js';
import type { WatchEngine } from '../hooks/watch-engine.js';
import type { SessionMessageRepository } from '../repositories/session-messages.js';
import type { SessionWatchRepository } from '../repositories/session-watches.js';
import type { PluginManager } from '../hooks/plugin-loader.js';
import type { PluginStateRepository } from '../repositories/plugin-states.js';
import { syncPlugins } from '../hooks/plugin-project-state.js';
import type { WatchService } from '../watch/watch-service.js';
import { getLibraryScan, invalidateScan } from '../install/scan-cache.js';
import {
  installSkill,
  uninstallSkill,
  installMcp,
  uninstallMcp,
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
  writeGlobalMcpServer,
  removeGlobalMcpServer,
  installGlobalSkill,
  uninstallGlobalSkill,
  readGlobalSkillGroups,
  resolveGlobalSkillDir,
  listGlobalSkillFiles,
  readGlobalSkillFile,
  ClaudeJsonCorruptError,
} from '../install/global-config.js';
import type { GlobalSkillSource } from '../install/global-config.js';
import {
  writeCodexMcpServer,
  removeCodexMcpServer,
  codexMcpExists,
  CodexTomlCorruptError,
} from '../install/codex-toml.js';
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
  applyStatuslineConfig,
  readGlobalStatuslineConfig,
  writeGlobalStatuslineConfig,
} from '../statusline/manager.js';
import { DEFAULT_STATUSLINE_CONFIG, type StatuslineConfig } from '../statusline/config.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { detectUpdates } from '../install/updates.js';
import { readBody, sendJson } from './http.js';
import { handleHooksRoutes } from './hooks-routes.js';
import { handleToolkitRoutes } from './toolkit-routes.js';
import { handleCaptureRoutes } from './capture-routes.js';
import { purgeProjectPipeline } from './hook-pipeline.js';
import { projectFileNamespaces, type ToolkitService } from '../hooks/toolkit.js';
import { listBrowseRoots, listDirectoryChildren } from './fs-browser.js';
import {
  readDaemonSettings,
  writeDaemonSettings,
  terminalPresetsFor,
  type DaemonSettings,
} from './settings.js';
import {
  defaultProjectOpener,
  readTerminalCounts,
  terminalBackendFor,
  type ProjectOpener,
} from './opener.js';
import { applyLaunchOnLogin } from './auto-start.js';
import { DAEMON_HOST } from './port.js';
import { pluginStateSurfaces, pluginSurfaces, pluginSurfaceFor } from '../surfaces.js';
import { readPluginRows } from '../install/plugin-rows.js';
import { installPluginPack } from '../install/plugin-install.js';

export const DAEMON_VERSION = WEAVE_VERSION;

export interface WeaveServerDeps {
  projects: ProjectRepository;
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
  /** 终端角标的后端隐藏刷新器；缺省则该角标只能靠前端自拉（兼容旧装配）。 */
  terminalRefresher?: TerminalCountsRefresher;
  /** Event dispatcher; hook 文件化后由 inbox 消费线程（inbox-worker）驱动。 */
  hookDispatcher?: HookDispatcher;
  /** 指令池 resume 执行器；POST /hooks/dispatches/:id/run 依赖它。 */
  hookRunner?: ResumeRunner;
  /** session-orchestration 批 1：点对点消息存储；GET /sessions/:id/messages 依赖它。 */
  sessionMessages?: SessionMessageRepository;
  /** 消息投递器（裁决表 + 双通道）；POST /sessions/:id/messages 依赖它。 */
  messageDeliverer?: MessageDeliverer;
  /** 空闲订阅存储（批 2）；POST/DELETE /sessions/:id/watch 与 GET /messaging/watches 依赖它。 */
  sessionWatches?: SessionWatchRepository;
  /** 空闲订阅引擎（批 2）；创建即空闲段的 fire 依赖它。 */
  watchEngine?: Pick<WatchEngine, 'created'>;
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
}

/** Create the daemon HTTP server (bound to 127.0.0.1, no TLS). */
export function createWeaveServer(deps: WeaveServerDeps): Server {
  // Ensure a long-lived fingerprint cache so update detection reuses hashes.
  const fingerprintCache = deps.fingerprintCache ?? new FingerprintCache();
  const serverDeps: WeaveServerDeps = { ...deps, fingerprintCache };
  return http.createServer((req, res) => {
    void handleRequest(req, res, serverDeps);
  });
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

  // 无 daemon token：daemon 只绑 127.0.0.1（port.ts DAEMON_HOST），本机即边界。
  // 项目级鉴权（hooks 采集 ptoken）在各自的采集链路里，与此处无关。

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
      // 开机自启即刻注册/注销（内部吞错，不阻塞保存响应）。
      (deps.autoStart ?? applyLaunchOnLogin)(saved.startup?.launchOnLogin ?? false);
      deps.dataBus?.emit({ key: 'settings' });
      sendJson(res, 200, saved);
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
        // 角标立刻对账，不等隐藏刷新的下一个周期
        void deps.terminalRefresher?.refreshNow();
      }
      sendJson(res, 200, { ok: true, target: body.target, path: project.path });
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
          body.scope === 'user'
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
            sendJson(res, 400, { error: 'Codex MCP servers are user-level (~/.codex/config.toml) — use scope "user"' });
            return;
          }
          if (await codexMcpExists(body.name)) {
            sendInstallError(res, new InstallConflictError(`MCP server "${body.name}" is already configured in ~/.codex/config.toml`));
            return;
          }
          await writeCodexMcpServer(body.name, body.mcpConfig as McpServerConfig);
        } else if (body.scope === 'user') {
          await writeGlobalMcpServer(body.name, body.mcpConfig as McpServerConfig);
        } else {
          await installMcp(project.path, body.name, body.mcpConfig as McpServerConfig);
        }
        sendJson(res, 201, {
          category: 'mcp',
          name: body.name,
          scope: body.agent === 'codex' ? 'user' : (body.scope ?? 'project'),
          agent: body.agent ?? 'claude',
        });
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
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
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
    try {
      if (body.category === 'skill') {
        if (!body.name) {
          sendJson(res, 400, { error: 'Missing "name"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        if (body.scope === 'user') await uninstallGlobalSkill(body.name, agent);
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
        } else if (body.scope === 'user') await removeGlobalMcpServer(body.name);
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
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Sync failed' });
    }
    return;
  }

  // --- project weave config (auto-sync toggle) ---
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
    sendJson(res, 200, { projects: deps.projects.list() });
    return;
  }

  // GET /projects/archived — 归档面数据（仅基础信息；历史会话已在归档时清空）。
  if (pathname === '/projects/archived' && req.method === 'GET') {
    sendJson(res, 200, { projects: deps.projects.listArchived() });
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
    // 消息域先于会话行清（双端 sessionId 都靠 sessions 子查询圈行）；订阅同形
    const messages = deps.sessionMessages?.deleteByProject(project.id) ?? 0;
    deps.sessionWatches?.deleteByProject(project.id);
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

  // GET /terminals/counts — 项目卡「终端」角标：每项目已打开的终端**窗口**数
  // （窗口级口径，不是分屏 pane、也不是会话数；枚举能力见 countOpenTerminals）。
  if (pathname === '/terminals/counts' && req.method === 'GET') {
    const opener = deps.opener ?? defaultProjectOpener;
    sendJson(res, 200, { counts: await readTerminalCounts(deps.projects.list(), opener) });
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
  /** 'project' (default) writes into the project; 'user' writes ~/.claude / ~/.codex. */
  scope?: 'project' | 'user';
  /** Which coding agent's surface to target (default: claude). */
  agent?: InstallAgent;
  /** plugin 类别：无 manifest 包合成最小 plugin.json 用（版本/描述）。 */
  version?: string;
  description?: string;
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
