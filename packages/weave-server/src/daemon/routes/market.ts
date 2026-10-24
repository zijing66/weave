import { homedir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkHarness, isHarness, type Harness } from '@weavecode/core';
import type { WeaveServerDeps } from '../server.js';
import { readBody, sendJson } from '../http.js';
import { FingerprintCache } from '../../install/fingerprint.js';
import {
  installSkill,
  uninstallSkill,
  installFileAsset,
  uninstallFileAsset,
  InstallConflictError,
  AssetNotFoundError,
} from '../../install/installer.js';
import type { McpServerConfig, InstallAgent } from '../../install/installer.js';
import { isFileAssetCategory, type FileAssetCategory } from '../../install/file-assets.js';
import {
  installGlobalSkill,
  uninstallGlobalSkill,
  readGlobalSkillGroups,
  resolveGlobalSkillDir,
  listGlobalSkillFiles,
  readGlobalSkillFile,
  ClaudeJsonCorruptError,
} from '../../install/global-config.js';
import type { GlobalSkillSource } from '../../install/global-config.js';
import { CodexTomlCorruptError } from '../../install/codex-toml.js';
import { forgetInstalled, recordInstalled } from '../../install/install-ledger.js';
import { readProjectFile, readGlobalFile, PathEscapeError, FileTooLargeError } from '../../install/reader.js';
import { readMcpRows } from '../../install/mcp-rows.js';
import { setMcpEnableOverride } from '../../install/settings-mcp.js';
import { applyUpdate, syncAll } from '../../install/apply-update.js';
import { buildLibraryIndex } from '../../install/library-index.js';
import { detectUpdates } from '../../install/updates.js';
import { detectPluginTemplateUpdates } from '../../install/plugin-templates.js';
import { detectInitFileUpdates, needsInit } from '../../install/init-files.js';
import { getLibraryScan, invalidateScan } from '../../install/scan-cache.js';
import { installCapabilities } from '../../install/capabilities.js';
import { BUILTIN_MCP_SERVERS } from '../../install/builtin-mcp.js';
import { readPluginRows } from '../../install/plugin-rows.js';
import { installPluginPack } from '../../install/plugin-install.js';
import { importFromDir, importFromGit, importLibraryIntoMarket } from '../../market/import.js';
import { marketDir, readManifest } from '../../market/manifest.js';
import { marketIdOf } from '../../market/identity.js';
import { isInsideDir, toRelPosix } from '../../market/resolve.js';
import { checkMarketUpdates } from '../../market/updates.js';
import { refreshMarketItems, type RefreshResult } from '../../market/refresh.js';
import { ensureBuiltinMarket, isBuiltinMarketDir } from '../../market/builtin.js';
import { removeInstalled } from '../../market/install-link.js';
import { syncPlugins } from '../../hooks/plugin-project-state.js';
import { assetSurfaces, pluginStateSurfaces, pluginSurfaces, pluginSurfaceFor } from '../../surfaces.js';

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

/**
 * 资源市场清单行（批 9）：libraries 行 + resolve 后有效路径 + 清单元数据 +
 * legacy 外部源标记。repo 读侧已把 path 解析为绝对路径（R11）。
 * dataRoot 由调用方传库实例值（生产 = `<dataDir>/data`；测试注入临时根）。
 */
async function marketItem(row: LibraryRowLike, dataRoot: string): Promise<Record<string, unknown>> {
  const managed = isInsideDir(row.path, marketDir(dataRoot));
  const manifest = managed ? await readManifest(row.path) : null;
  // 内置仓也登记在 libraries 里（落点是链接），但它既不是导入来的、也不能迁入/
  // 删除/查更新——右栏据此不摆那些按钮，别让它显示成「外部源」。
  const builtin = isBuiltinMarketDir(row.path, dataRoot);
  return {
    id: row.id,
    kind: row.kind,
    addedAt: row.addedAt,
    path: row.path,
    relPath: isInsideDir(row.path, dataRoot) ? toRelPosix(row.path, dataRoot) : null,
    resourceId: managed ? path.basename(row.path) : null,
    managed,
    builtin,
    // 仓库 namespace = 资源管理按它分块的那个名字（内置仓 = `weave`）；不在市场
    // 内的 legacy 外部源没有仓库可归。
    namespace: managed ? marketIdOf(row.path, marketDir(dataRoot)) : undefined,
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

/** marketItem 的入参形状（LibraryRow 的结构子集，测试注入同形对象）。 */
interface LibraryRowLike {
  id: number;
  kind: string;
  addedAt: string;
  path: string;
}

/**
 * 资源/安装域路由：libraries CRUD、市场（清单/双导入/删除/迁入/查更新/刷新）、
 * install/uninstall、内置 MCP 安装、MCP 行与启停、更新检测/单项更新/全量同步、
 * 项目文件读取、全局 skill、插件行与卸载。返回 true = 本路由认领；false = 未命中。
 */
export async function handleMarketRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  // --- 安装属性矩阵（harness 适配 × 安装范围；web 拖拽/点击禁用共用） ---
  if (pathname === '/capabilities' && req.method === 'GET') {
    sendJson(res, 200, installCapabilities());
    return true;
  }

  // --- libraries (asset sources for the install panel) ---
  if (pathname === '/libraries' && req.method === 'GET') {
    sendJson(res, 200, { libraries: deps.libraries ? deps.libraries.list() : [] });
    return true;
  }
  if (pathname === '/libraries' && req.method === 'POST') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return true;
    }
    let body: { path?: string; kind?: string };
    try {
      body = JSON.parse(await readBody(req)) as { path?: string; kind?: string };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (!body.path || !body.kind) {
      sendJson(res, 400, { error: 'Missing "path" or "kind"' });
      return true;
    }
    if (!['skill', 'mcp', 'both'].includes(body.kind)) {
      sendJson(res, 400, { error: 'Invalid "kind" (skill|mcp|both)' });
      return true;
    }
    const row = deps.libraries.add({
      path: body.path,
      kind: body.kind as 'skill' | 'mcp' | 'both',
    });
    deps.dataBus?.emit({ key: 'libraries' });
    sendJson(res, 201, row);
    return true;
  }
  const libAssetsMatch = pathname.match(/^\/libraries\/(\d+)\/assets$/);
  if (libAssetsMatch && req.method === 'GET') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return true;
    }
    const lib = deps.libraries.getById(Number(libAssetsMatch[1]));
    if (!lib) {
      sendJson(res, 404, { error: 'Library not found' });
      return true;
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
    return true;
  }
  const libMatch = pathname.match(/^\/libraries\/(\d+)$/);
  if (libMatch && req.method === 'DELETE') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return true;
    }
    const libId = Number(libMatch[1]);
    const libRow = deps.libraries.getById(libId);
    if (libRow) await invalidateScan(libRow.path); // 外部目录不删库不删目录，清掉缓存文件
    deps.libraries.remove(libId);
    deps.dataBus?.emit({ key: 'libraries' });
    deps.dataBus?.emit({ key: 'market' });
    sendJson(res, 200, { ok: true });
    return true;
  }

  // --- 资源市场（批 9）：清单 / 双导入 / 删除 / legacy 外部源迁入 ---
  if (pathname === '/market' && req.method === 'GET') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return true;
    }
    const items = await Promise.all(
      deps.libraries.list().map((row) => marketItem(row, deps.libraries!.dataRoot)),
    );
    sendJson(res, 200, { items });
    return true;
  }
  if (pathname === '/market' && req.method === 'POST') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return true;
    }
    let body: { kind?: string; path?: string; url?: string };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    // dataRoot 跟随库实例（生产 = `<dataDir>/data`；测试可注入临时根，读写两侧同根）
    const importDeps = { libraries: deps.libraries, dataRoot: deps.libraries.dataRoot };
    try {
      if (body.kind === 'dir' && body.path) {
        const imported = await importFromDir(body.path, importDeps);
        if (imported.refreshed) deps.fingerprintCache?.invalidate(imported.dir); // 覆盖重导 → 指纹失效
        await invalidateScan(imported.dir); // 源目录可能带旧 scans.json，导入后一律作废重扫
        deps.dataBus?.emit({ key: 'market' });
        sendJson(res, 201, {
          item: await marketItem(deps.libraries.getById(imported.libraryId)!, deps.libraries.dataRoot),
        });
      } else if (body.kind === 'git' && body.url) {
        const imported = await importFromGit(body.url, importDeps);
        if (imported.refreshed) deps.fingerprintCache?.invalidate(imported.dir);
        await invalidateScan(imported.dir);
        deps.dataBus?.emit({ key: 'market' });
        sendJson(res, 201, {
          item: await marketItem(deps.libraries.getById(imported.libraryId)!, deps.libraries.dataRoot),
        });
      } else {
        sendJson(res, 400, { error: 'Invalid body (kind: "dir" + path | "git" + url)' });
      }
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Import failed' });
    }
    return true;
  }
  // 批量检查市场缓存更新（M4）：比对 origin，只读不落库；body 可空 = 全量。
  if (pathname === '/market/check-updates' && req.method === 'POST') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return true;
    }
    let body: { ids?: number[] } = {};
    const raw = (await readBody(req)).trim();
    if (raw) {
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
    }
    const rows = deps.libraries
      .list()
      // 内置仓无远程源：不进批量检查（否则只会在 UI 上显示成 unknown 徽标）。
      .filter((r) => !isBuiltinMarketDir(r.path, deps.libraries!.dataRoot))
      .filter((r) => !body.ids?.length || body.ids.includes(r.id));
    for (const r of rows) await invalidateScan(r.path); // 检查即重扫事件：之后同路径取新结果
    const results = await checkMarketUpdates(rows.map((r) => ({ id: r.id, dir: r.path })));
    deps.dataBus?.emit({ key: 'market' });
    sendJson(res, 200, { results });
    return true;
  }
  // 刷新市场缓存（M4 一键更新）：dir 重拷 / git 重 clone + 回写 commit；body 可空 = 全量。
  if (pathname === '/market/refresh' && req.method === 'POST') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return true;
    }
    let body: { ids?: number[] } = {};
    const raw = (await readBody(req)).trim();
    if (raw) {
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
    }
    const selected = deps.libraries
      .list()
      .filter((r) => !body.ids?.length || body.ids.includes(r.id));
    // 内置仓的「刷新」= 重新从包内落地：它不是导入来的，没有可回拷的 origin；
    // 重铺同时会把此前因链接不可用而落成副本的落点改回链接。
    const builtinResults: RefreshResult[] = [];
    for (const row of selected.filter((r) => isBuiltinMarketDir(r.path, deps.libraries!.dataRoot))) {
      const r = await ensureBuiltinMarket({ libraries: deps.libraries });
      builtinResults.push({ id: row.id, status: r.error ? 'failed' : 'refreshed' });
    }
    const targets = selected
      .filter((r) => !isBuiltinMarketDir(r.path, deps.libraries!.dataRoot))
      .map((r) => ({ id: r.id, dir: r.path }));
    const results = [
      ...(await refreshMarketItems(targets, {
        libraries: deps.libraries,
        dataRoot: deps.libraries.dataRoot,
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
    return true;
  }
  const marketMatch = pathname.match(/^\/market\/(\d+)$/);
  if (marketMatch && req.method === 'DELETE') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return true;
    }
    const row = deps.libraries.getById(Number(marketMatch[1]));
    if (!row) {
      sendJson(res, 404, { error: 'Library not found' });
      return true;
    }
    if (isBuiltinMarketDir(row.path, deps.libraries.dataRoot)) {
      sendJson(res, 409, {
        error: 'Built-in market is owned by weave and cannot be deleted',
        note: 'It is re-materialized from @weavecode/templates on every daemon start.',
      });
      return true;
    }
    if (!isInsideDir(row.path, marketDir(deps.libraries.dataRoot))) {
      sendJson(res, 400, { error: 'Not a market resource (legacy row — use DELETE /libraries/:id)' });
      return true;
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
    return true;
  }
  const migrateMatch = pathname.match(/^\/libraries\/(\d+)\/market-import$/);
  if (migrateMatch && req.method === 'POST') {
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return true;
    }
    const row = deps.libraries.getById(Number(migrateMatch[1]));
    if (!row) {
      sendJson(res, 404, { error: 'Library not found' });
      return true;
    }
    try {
      const oldPath = row.path;
      const imported = await importLibraryIntoMarket(row, {
        libraries: deps.libraries,
        dataRoot: deps.libraries.dataRoot,
      });
      await invalidateScan(oldPath); // 外部源残留的 scans.json 清掉
      await invalidateScan(imported.dir); // 拷贝可能带进旧 scans.json，不作数
      sendJson(res, 200, {
        item: await marketItem(deps.libraries.getById(imported.libraryId)!, deps.libraries.dataRoot),
      });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Import failed' });
    }
    return true;
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
      return true;
    }
    if (!project && needsProjectPath(body)) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    const projectPath = project?.path ?? '';
    try {
      if (body.category === 'skill') {
        if (!body.name || !body.sourceDir) {
          sendJson(res, 400, { error: 'Missing "name" or "sourceDir"' });
          return true;
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
          return true;
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
          return true;
        }
        const agent = body.agent ?? 'claude';
        const surface = mcpSurfaceOf(agent);
        if (!surface) {
          sendJson(res, 400, { error: `Unsupported agent: ${agent}` });
          return true;
        }
        const scopes = surface.mcpScopes();
        // 显式给了该 harness 没有的 scope → 400（没给 = 取它唯一的那个）。
        const scope = body.scope ?? scopes[0];
        if (!scope || !scopes.includes(scope)) {
          sendJson(res, 400, {
            error: `MCP servers for ${agent} are ${scopes.join('/')}-level only — scope "${body.scope}" is not available`,
          });
          return true;
        }
        if (body.name in (await surface.mcpRead(scope, projectPath, homedir()))) {
          sendInstallError(res, new InstallConflictError(`MCP server "${body.name}" is already configured`));
          return true;
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
          return true;
        }
        if (body.scope && body.scope !== 'user') {
          sendJson(res, 400, { error: 'Plugin install currently only supports scope "user"' });
          return true;
        }
        const agent = body.agent ?? 'claude';
        const installFace = pluginSurfaces().find((p) => p.harness === agent);
        if (!installFace) {
          sendJson(res, 400, { error: `No plugin install surface for runtime: ${agent}` });
          return true;
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
    return true;
  }
  // POST /projects/:id/mcp/builtin —— 安装 daemon 托管的内置 MCP。
  // **只允许 user 档**（配置里带本机令牌，项目档会跟着仓库走）；令牌只写不回显。
  const builtinMcpMatch = pathname.match(/^\/projects\/(\d+)\/mcp\/builtin$/);
  if (builtinMcpMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(builtinMcpMatch[1]));
    let body: { name?: string; agent?: string };
    try {
      body = JSON.parse(await readBody(req)) as { name?: string; agent?: string };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const builtin = BUILTIN_MCP_SERVERS.find((b) => b.name === body.name);
    if (!builtin) {
      sendJson(res, 404, { error: `Unknown built-in MCP server: ${body.name ?? ''}` });
      return true;
    }
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    const agent = body.agent ?? 'claude';
    const surface = mcpSurfaceOf(agent);
    if (!surface || !surface.mcpScopes().includes('user')) {
      sendJson(res, 400, { error: `MCP servers for ${agent} have no user scope` });
      return true;
    }
    const token = deps.auth?.getLocalToken() ?? '';
    const config: McpServerConfig = {
      type: 'http',
      url: `http://127.0.0.1:${deps.port}${builtin.path}`,
      ...(token ? { headers: { 'x-weave-local': token } } : {}),
    };
    try {
      await surface.mcpWrite('user', project.path, homedir(), builtin.name, config);
      sendJson(res, 201, { category: 'mcp', name: builtin.name, scope: 'user', agent });
    } catch (e) {
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Install failed' });
    }
    return true;
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
      return true;
    }
    if (!project && needsProjectPath(body)) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    const projectPath = project?.path ?? '';
    try {
      if (body.category === 'skill') {
        if (!body.name) {
          sendJson(res, 400, { error: 'Missing "name"' });
          return true;
        }
        const agent = body.agent ?? 'claude';
        if (body.scope === 'user') await uninstallGlobalSkill(body.name, agent);
        else await uninstallSkill(projectPath, body.name, agent);
      } else if (body.category && isFileAssetCategory(body.category)) {
        if (!body.name) {
          sendJson(res, 400, { error: 'Missing "name"' });
          return true;
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
          return true;
        }
        const agent = body.agent ?? 'claude';
        const surface = mcpSurfaceOf(agent);
        if (!surface) {
          sendJson(res, 400, { error: `Unsupported agent: ${agent}` });
          return true;
        }
        const scopes = surface.mcpScopes();
        const scope = body.scope ?? scopes[0];
        if (!scope || !scopes.includes(scope)) {
          sendJson(res, 400, {
            error: `MCP servers for ${agent} are ${scopes.join('/')}-level only — scope "${body.scope}" is not available`,
          });
          return true;
        }
        if (!(await surface.mcpRemove(scope, projectPath, homedir(), body.name))) {
          sendInstallError(res, new AssetNotFoundError(`MCP server "${body.name}" is not configured`));
          return true;
        }
        if (scope === 'project') {
          await forgetInstalled(projectPath, { category: 'mcp', name: body.name, agent });
        }
      } else {
        sendJson(res, 400, { error: 'Invalid "category" (skill|mcp|command|agent|workflow|rule|output-style)' });
        return true;
      }
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendInstallError(res, e);
    }
    return true;
  }

  // --- project file reader (e.g. a skill's SKILL.md) ---
  const fileMatch = pathname.match(/^\/projects\/(\d+)\/file$/);
  if (fileMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(fileMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    const relPath = url.searchParams.get('path');
    if (!relPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return true;
    }
    try {
      const file = await readProjectFile(project.path, relPath);
      sendJson(res, 200, { path: relPath, content: file.content, size: file.size });
    } catch (e) {
      sendReaderError(res, e);
    }
    return true;
  }

  // --- machine-level file reader (~/.claude/…, ~/.codex/…) for the global tree ---
  if (pathname === '/global-file' && req.method === 'GET') {
    const relPath = url.searchParams.get('path');
    if (!relPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return true;
    }
    try {
      const file = await readGlobalFile(relPath);
      sendJson(res, 200, { path: relPath, content: file.content, size: file.size });
    } catch (e) {
      sendReaderError(res, e);
    }
    return true;
  }

  // --- mcp servers (工具行：claude 项目 .mcp.json / user ~/.claude.json + codex user config.toml) ---
  const mcpMatch = pathname.match(/^\/projects\/(\d+)\/mcp$/);
  if (mcpMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(mcpMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    sendJson(res, 200, { rows: await readMcpRows(project.path) });
    return true;
  }

  // --- harness health checks (read-only, 批 8): structured results from core,
  // rendered by each client's own dictionary ---
  const harnessChecksMatch = pathname.match(/^\/projects\/(\d+)\/harness-checks$/);
  if (harnessChecksMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(harnessChecksMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    sendJson(res, 200, { checks: await checkHarness(project.path) });
    return true;
  }

  // --- global skills (grouped: personal + plugin, Claude + Codex) ---
  const globalSkillsMatch = pathname.match(/^\/projects\/(\d+)\/skills\/global$/);
  if (globalSkillsMatch && req.method === 'GET') {
    sendJson(res, 200, { groups: await readGlobalSkillGroups() });
    return true;
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
      return true;
    }
    const dir = await resolveGlobalSkillDir(source, name, pluginKey);
    if (!dir) {
      sendJson(res, 404, { error: 'Skill not found' });
      return true;
    }
    sendJson(res, 200, { files: await listGlobalSkillFiles(dir) });
    return true;
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
      return true;
    }
    const dir = await resolveGlobalSkillDir(source, name, pluginKey);
    if (!dir) {
      sendJson(res, 404, { error: 'Skill not found' });
      return true;
    }
    try {
      const file = await readGlobalSkillFile(dir, relPath);
      sendJson(res, 200, { path: relPath, content: file.content, size: file.size });
    } catch (e) {
      sendReaderError(res, e);
    }
    return true;
  }

  // --- plugin tool rows (工具对象模型：每键 × 每可装档一行；effective 服务端
  //     唯一解析，PluginEnabledMap 的替换面) ---
  const pluginStateMatch = pathname.match(/^\/projects\/(\d+)\/plugins\/state$/);
  if (pluginStateMatch) {
    const project = deps.projects.getById(Number(pluginStateMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { rows: await readPluginRows(project.path) });
      return true;
    }
    if (req.method === 'PUT') {
      let body: { runtime?: string; key?: string; scope?: string; state?: string };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
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
        return true;
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
            return true;
          }
          await stateFace.state.writeGlobalEnabled(body.key, state === 'on');
        }
        // 插件启停域变化 → 包视图（ToolkitSection）与行消费方（SkillGrid 徽标）重拉。
        deps.dataBus?.emit({ key: 'toolkit' });
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'Plugin state write failed' });
      }
      return true;
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
      return true;
    }
    if (!isHarness(body.runtime) || !body.key) {
      sendJson(res, 400, { error: 'Missing or invalid "runtime"/"key"' });
      return true;
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
    return true;
  }

  // --- MCP enable/disable overrides (project settings.json；词表 = 工具对象模型) ---
  const mcpEnableMatch = pathname.match(/^\/projects\/(\d+)\/mcp\/enable$/);
  if (mcpEnableMatch) {
    const project = deps.projects.getById(Number(mcpEnableMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    if (req.method === 'PUT') {
      let body: { name?: string; state?: string };
      try {
        body = JSON.parse(await readBody(req)) as { name?: string; state?: string };
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      if (!body.name || !body.state) {
        sendJson(res, 400, { error: 'Missing "name" or "state"' });
        return true;
      }
      if (!['on', 'off', 'inherit'].includes(body.state)) {
        sendJson(res, 400, { error: 'Invalid "state" (on|off|inherit)' });
        return true;
      }
      await setMcpEnableOverride(
        project.path,
        body.name,
        body.state as 'on' | 'off' | 'inherit',
      );
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  // --- update detection (installed assets vs library sources) ---
  const updatesMatch = pathname.match(/^\/projects\/(\d+)\/updates$/);
  if (updatesMatch && req.method === 'GET') {
    const project = deps.projects.getById(Number(updatesMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
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
      return true;
    }
    const report = await detectUpdates(project.path, deps.libraries.list(), cache);
    sendJson(res, 200, report);
    return true;
  }

  // --- apply a single update (overwrite one asset from its source) ---
  const updateMatch = pathname.match(/^\/projects\/(\d+)\/update$/);
  if (updateMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(updateMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return true;
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
      return true;
    }
    if (!body.category || !body.name || !body.scope) {
      sendJson(res, 400, { error: 'Missing "category", "name", or "scope"' });
      return true;
    }
    const validCategories = ['skill', 'mcp', 'command', 'agent', 'workflow', 'rule', 'output-style'];
    if (!validCategories.includes(body.category)) {
      sendJson(res, 400, { error: 'Invalid "category"' });
      return true;
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
    return true;
  }

  // --- sync all outdated assets ---
  const syncMatch = pathname.match(/^\/projects\/(\d+)\/sync-all$/);
  if (syncMatch && req.method === 'POST') {
    const project = deps.projects.getById(Number(syncMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    if (!deps.libraries) {
      sendJson(res, 503, { error: 'Libraries unavailable' });
      return true;
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
    return true;
  }

  return false;
}
