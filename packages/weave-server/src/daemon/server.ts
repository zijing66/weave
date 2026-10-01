import http from 'node:http';
import { WEAVE_VERSION } from '../version.js';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ProjectRepository } from '../repositories/projects.js';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { LibraryRepository } from '../repositories/libraries.js';
import type { HookAdapter } from '../hooks/adapter.js';
import type { HookReport } from '../hooks/types.js';
import type { WatchService } from '../watch/watch-service.js';
import { scanLibrarySkills, scanLibraryMcp, scanLibraryFileAssets } from '../install/scanner.js';
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
import { isFileAssetCategory } from '../install/file-assets.js';
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
import { readProjectFile, PathEscapeError, FileTooLargeError } from '../install/reader.js';
import {
  readStatuslineConfig,
  readStatuslineScript,
  applyStatuslineConfig,
  readGlobalStatuslineConfig,
  writeGlobalStatuslineConfig,
} from '../statusline/manager.js';
import type { StatuslineConfig } from '../statusline/config.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { detectUpdates } from '../install/updates.js';
import { extractBearerToken } from './auth.js';
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
  /** Hook adapters keyed by source; required when `hookEvents` is provided. */
  adapters?: HookAdapter[];
  /** Library registry (asset sources) for the install panel; optional. */
  libraries?: LibraryRepository;
  /** Content-fingerprint cache for update detection; created if absent. */
  fingerprintCache?: FingerprintCache;
  /** Directory of the built SPA to statically host; optional. */
  staticDir?: string;
  /** Directory-opening backend for the project context menu; spied in tests. */
  opener?: ProjectOpener;
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
  const sendJson = (status: number, data: unknown): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(data));
  };

  // The SPA calls /api/<route>; strip the prefix so existing routes work for
  // both the CLI (which calls /<route> directly) and the frontend.
  let pathname = url.pathname;
  if (pathname.startsWith('/api/')) pathname = pathname.slice(4);
  else if (pathname === '/api') pathname = '/';

  // /health — unauthenticated; used for port probing and single-instance checks.
  if (pathname === '/health' && req.method === 'GET') {
    sendJson(200, {
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
      sendJson(401, { error: 'Unauthorized' });
      return;
    }
    if (!deps.hookEvents || !deps.adapters) {
      sendJson(503, { error: 'Hook ingestion unavailable' });
      return;
    }
    let report: HookReport;
    try {
      report = JSON.parse(await readBody(req)) as HookReport;
    } catch {
      sendJson(400, { error: 'Invalid JSON body' });
      return;
    }
    if (!report.source || !report.eventType) {
      sendJson(400, { error: 'Missing "source" or "eventType"' });
      return;
    }
    const adapter = deps.adapters.find((a) => a.source === report.source);
    if (!adapter) {
      sendJson(400, { error: `Unknown hook source: ${report.source}` });
      return;
    }
    const input = adapter.normalize(report, project.id);
    const id = deps.hookEvents.insert(input);
    sendJson(201, {
      id,
      projectId: project.id,
      source: input.source,
      eventType: input.eventType,
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
      sendJson(401, { error: 'Unauthorized' });
      return false;
    }
    return true;
  };

  // GET /projects/:id/hooks — hook events for the task view (by session).
  const hooksMatch = pathname.match(/^\/projects\/(\d+)\/hooks$/);
  if (hooksMatch && req.method === 'GET') {
    if (!requireAuth()) return;
    if (!deps.hookEvents) {
      sendJson(503, { error: 'Hook ingestion unavailable' });
      return;
    }
    const projectId = Number(hooksMatch[1]);
    const limit = clampLimit(url.searchParams.get('limit'));
    sendJson(200, { events: deps.hookEvents.listByProject(projectId, limit) });
    return;
  }

  // --- daemon settings (terminal preset for "open in terminal") ---
  if (pathname === '/settings') {
    if (!requireAuth()) return;
    if (req.method === 'GET') {
      sendJson(200, {
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
        sendJson(400, { error: 'Invalid JSON body' });
        return;
      }
      const saved = await writeDaemonSettings(body as DaemonSettings);
      sendJson(200, saved);
      return;
    }
  }

  // --- open a project directory in the file manager or a terminal ---
  const openMatch = pathname.match(/^\/projects\/(\d+)\/open$/);
  if (openMatch && req.method === 'POST') {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(openMatch[1]));
    if (!project) {
      sendJson(404, { error: 'Project not found' });
      return;
    }
    let body: { target?: string };
    try {
      body = JSON.parse(await readBody(req)) as { target?: string };
    } catch {
      sendJson(400, { error: 'Invalid JSON body' });
      return;
    }
    if (body.target !== 'explorer' && body.target !== 'terminal') {
      sendJson(400, { error: 'Invalid "target" (explorer|terminal)' });
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
      sendJson(200, { ok: true, target: body.target, path: project.path });
    } catch (e) {
      sendJson(400, { error: e instanceof Error ? e.message : 'Open failed' });
    }
    return;
  }

  // --- cross-platform directory browsing (powers the web folder picker) ---
  if (pathname === '/fs/roots' && req.method === 'GET') {
    if (!requireAuth()) return;
    const libraryPaths = deps.libraries ? deps.libraries.list().map((l) => l.path) : [];
    const roots = await listBrowseRoots(libraryPaths);
    sendJson(200, { roots });
    return;
  }
  if (pathname === '/fs/children' && req.method === 'GET') {
    if (!requireAuth()) return;
    const dirPath = url.searchParams.get('path');
    if (!dirPath) {
      sendJson(400, { error: 'Missing "path" query parameter' });
      return;
    }
    try {
      const children = await listDirectoryChildren(dirPath);
      sendJson(200, { children });
    } catch (err) {
      sendJson(400, { error: `Cannot list directory: ${String(err)}` });
    }
    return;
  }

  // --- libraries (asset sources for the install panel) ---
  if (pathname === '/libraries' && req.method === 'GET') {
    if (!requireAuth()) return;
    sendJson(200, { libraries: deps.libraries ? deps.libraries.list() : [] });
    return;
  }
  if (pathname === '/libraries' && req.method === 'POST') {
    if (!requireAuth()) return;
    if (!deps.libraries) {
      sendJson(503, { error: 'Libraries unavailable' });
      return;
    }
    let body: { path?: string; kind?: string };
    try {
      body = JSON.parse(await readBody(req)) as { path?: string; kind?: string };
    } catch {
      sendJson(400, { error: 'Invalid JSON body' });
      return;
    }
    if (!body.path || !body.kind) {
      sendJson(400, { error: 'Missing "path" or "kind"' });
      return;
    }
    if (!['skill', 'mcp', 'both'].includes(body.kind)) {
      sendJson(400, { error: 'Invalid "kind" (skill|mcp|both)' });
      return;
    }
    const row = deps.libraries.add({
      path: body.path,
      kind: body.kind as 'skill' | 'mcp' | 'both',
    });
    sendJson(201, row);
    return;
  }
  const libAssetsMatch = pathname.match(/^\/libraries\/(\d+)\/assets$/);
  if (libAssetsMatch && req.method === 'GET') {
    if (!requireAuth()) return;
    if (!deps.libraries) {
      sendJson(503, { error: 'Libraries unavailable' });
      return;
    }
    const lib = deps.libraries.getById(Number(libAssetsMatch[1]));
    if (!lib) {
      sendJson(404, { error: 'Library not found' });
      return;
    }
    const skills = await scanLibrarySkills(lib.path);
    const mcp =
      lib.kind === 'mcp' || lib.kind === 'both' ? await scanLibraryMcp(lib.path) : [];
    const files =
      lib.kind === 'skill' || lib.kind === 'both' ? await scanLibraryFileAssets(lib.path) : null;
    sendJson(200, { library: lib, skills, mcp, files });
    return;
  }
  const libMatch = pathname.match(/^\/libraries\/(\d+)$/);
  if (libMatch && req.method === 'DELETE') {
    if (!requireAuth()) return;
    if (!deps.libraries) {
      sendJson(503, { error: 'Libraries unavailable' });
      return;
    }
    deps.libraries.remove(Number(libMatch[1]));
    sendJson(200, { ok: true });
    return;
  }

  // --- install / uninstall assets (filesystem ops; SSE auto-refreshes the UI) ---
  const installMatch = pathname.match(/^\/projects\/(\d+)\/install$/);
  if (installMatch && req.method === 'POST') {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(installMatch[1]));
    if (!project) {
      sendJson(404, { error: 'Project not found' });
      return;
    }
    let body: InstallBody;
    try {
      body = JSON.parse(await readBody(req)) as InstallBody;
    } catch {
      sendJson(400, { error: 'Invalid JSON body' });
      return;
    }
    try {
      if (body.category === 'skill') {
        if (!body.name || !body.sourceDir) {
          sendJson(400, { error: 'Missing "name" or "sourceDir"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        const target =
          body.scope === 'global'
            ? await installGlobalSkill(body.sourceDir, body.name, agent)
            : await installSkill(project.path, body.sourceDir, body.name, agent);
        sendJson(201, { category: 'skill', name: body.name, scope: body.scope ?? 'project', agent, path: target });
      } else if (body.category && isFileAssetCategory(body.category)) {
        if (!body.name || !body.sourceFile) {
          sendJson(400, { error: 'Missing "name" or "sourceFile"' });
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
        sendJson(201, { category: body.category, name: body.name, scope, agent, path: target });
      } else if (body.category === 'mcp') {
        if (!body.name || !body.mcpConfig) {
          sendJson(400, { error: 'Missing "name" or "mcpConfig"' });
          return;
        }
        if (body.agent === 'codex') {
          // Codex MCP servers live in ~/.codex/config.toml (user-level only)
          if (body.scope === 'project') {
            sendJson(400, { error: 'Codex MCP servers are user-level (~/.codex/config.toml) — use scope "global"' });
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
        sendJson(201, {
          category: 'mcp',
          name: body.name,
          scope: body.agent === 'codex' ? 'global' : (body.scope ?? 'project'),
          agent: body.agent ?? 'claude',
        });
      } else {
        sendJson(400, { error: 'Invalid "category" (skill|mcp|command|agent|workflow|rule|output-style)' });
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
      sendJson(404, { error: 'Project not found' });
      return;
    }
    let body: {
      category?: string;
      name?: string;
      scope?: 'project' | 'global';
      agent?: 'claude' | 'codex';
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(400, { error: 'Invalid JSON body' });
      return;
    }
    try {
      if (body.category === 'skill') {
        if (!body.name) {
          sendJson(400, { error: 'Missing "name"' });
          return;
        }
        const agent = body.agent ?? 'claude';
        if (body.scope === 'global') await uninstallGlobalSkill(body.name, agent);
        else await uninstallSkill(project.path, body.name, agent);
      } else if (body.category && isFileAssetCategory(body.category)) {
        if (!body.name) {
          sendJson(400, { error: 'Missing "name"' });
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
          sendJson(400, { error: 'Missing "name"' });
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
        sendJson(400, { error: 'Invalid "category" (skill|mcp|command|agent|workflow|rule|output-style)' });
        return;
      }
      sendJson(200, { ok: true });
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
      sendJson(404, { error: 'Project not found' });
      return;
    }
    const relPath = url.searchParams.get('path');
    if (!relPath) {
      sendJson(400, { error: 'Missing "path" query parameter' });
      return;
    }
    try {
      const file = await readProjectFile(project.path, relPath);
      sendJson(200, { path: relPath, content: file.content, size: file.size });
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
      sendJson(404, { error: 'Project not found' });
      return;
    }
    const [projectServers, globalServers, codexServers] = await Promise.all([
      readMcpServers(project.path),
      safeReadGlobalMcp(),
      readCodexMcpServers().catch(() => ({})),
    ]);
    sendJson(200, {
      project: projectServers,
      global: globalServers,
      codex: codexServers,
    });
    return;
  }

  // --- global skills (grouped: personal + plugin, Claude + Codex) ---
  const globalSkillsMatch = pathname.match(/^\/projects\/(\d+)\/skills\/global$/);
  if (globalSkillsMatch && req.method === 'GET') {
    if (!requireAuth()) return;
    sendJson(200, { groups: await readGlobalSkillGroups() });
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
      sendJson(400, { error: 'Missing "source" or "name" query parameter' });
      return;
    }
    const dir = await resolveGlobalSkillDir(source, name, pluginKey);
    if (!dir) {
      sendJson(404, { error: 'Skill not found' });
      return;
    }
    sendJson(200, { files: await listGlobalSkillFiles(dir) });
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
      sendJson(400, { error: 'Missing "source", "name" or "path" query parameter' });
      return;
    }
    const dir = await resolveGlobalSkillDir(source, name, pluginKey);
    if (!dir) {
      sendJson(404, { error: 'Skill not found' });
      return;
    }
    try {
      const file = await readGlobalSkillFile(dir, relPath);
      sendJson(200, { path: relPath, content: file.content, size: file.size });
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
      sendJson(200, { claude, codex });
      return;
    }
    if (req.method === 'PUT') {
      let body: { runtime?: string; key?: string; enabled?: boolean };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        sendJson(400, { error: 'Invalid JSON body' });
        return;
      }
      if (
        !body.key ||
        typeof body.enabled !== 'boolean' ||
        (body.runtime !== 'claude' && body.runtime !== 'codex')
      ) {
        sendJson(400, { error: 'Missing or invalid "runtime"/"key"/"enabled"' });
        return;
      }
      if (body.runtime === 'claude') await writeClaudePluginEnabled(body.key, body.enabled);
      else await writeCodexPluginEnabled(body.key, body.enabled);
      sendJson(200, { ok: true });
      return;
    }
  }

  // --- MCP enable/disable overrides (project settings.json) ---
  const mcpEnableMatch = pathname.match(/^\/projects\/(\d+)\/mcp\/enable$/);
  if (mcpEnableMatch) {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(mcpEnableMatch[1]));
    if (!project) {
      sendJson(404, { error: 'Project not found' });
      return;
    }
    if (req.method === 'GET') {
      sendJson(200, await readMcpEnableMap(project.path));
      return;
    }
    if (req.method === 'PUT') {
      let body: { name?: string; state?: string };
      try {
        body = JSON.parse(await readBody(req)) as { name?: string; state?: string };
      } catch {
        sendJson(400, { error: 'Invalid JSON body' });
        return;
      }
      if (!body.name || !body.state) {
        sendJson(400, { error: 'Missing "name" or "state"' });
        return;
      }
      if (!['enabled', 'disabled', 'default'].includes(body.state)) {
        sendJson(400, { error: 'Invalid "state" (enabled|disabled|default)' });
        return;
      }
      await setMcpEnableState(project.path, body.name, body.state as McpEnableState);
      sendJson(200, { ok: true });
      return;
    }
  }

  // --- update detection (installed assets vs library sources) ---
  const updatesMatch = pathname.match(/^\/projects\/(\d+)\/updates$/);
  if (updatesMatch && req.method === 'GET') {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(updatesMatch[1]));
    if (!project) {
      sendJson(404, { error: 'Project not found' });
      return;
    }
    if (!deps.libraries) {
      sendJson(200, { skills: [], mcp: [], files: [], available: 0 });
      return;
    }
    const report = await detectUpdates(
      project.path,
      deps.libraries.list(),
      deps.fingerprintCache ?? new FingerprintCache(),
    );
    sendJson(200, report);
    return;
  }

  // --- apply a single update (overwrite one asset from its source) ---
  const updateMatch = pathname.match(/^\/projects\/(\d+)\/update$/);
  if (updateMatch && req.method === 'POST') {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(updateMatch[1]));
    if (!project) {
      sendJson(404, { error: 'Project not found' });
      return;
    }
    if (!deps.libraries) {
      sendJson(503, { error: 'Libraries unavailable' });
      return;
    }
    let body: {
      category?: string;
      name?: string;
      scope?: 'project' | 'global';
      agent?: 'claude' | 'codex';
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(400, { error: 'Invalid JSON body' });
      return;
    }
    if (!body.category || !body.name || !body.scope) {
      sendJson(400, { error: 'Missing "category", "name", or "scope"' });
      return;
    }
    const validCategories = ['skill', 'mcp', 'command', 'agent', 'workflow', 'rule', 'output-style'];
    if (!validCategories.includes(body.category)) {
      sendJson(400, { error: 'Invalid "category"' });
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
      sendJson(200, { ok: true, category: body.category, name: body.name, scope: body.scope });
    } catch (e) {
      sendJson(400, { error: e instanceof Error ? e.message : 'Update failed' });
    }
    return;
  }

  // --- sync all outdated assets ---
  const syncMatch = pathname.match(/^\/projects\/(\d+)\/sync-all$/);
  if (syncMatch && req.method === 'POST') {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(syncMatch[1]));
    if (!project) {
      sendJson(404, { error: 'Project not found' });
      return;
    }
    if (!deps.libraries) {
      sendJson(503, { error: 'Libraries unavailable' });
      return;
    }
    try {
      const cache = deps.fingerprintCache ?? new FingerprintCache();
      const result = await syncAll(project.path, deps.libraries.list(), cache);
      sendJson(200, result);
    } catch (e) {
      sendJson(400, { error: e instanceof Error ? e.message : 'Sync failed' });
    }
    return;
  }

  // --- project weave config (auto-sync toggle) ---
  const configMatch = pathname.match(/^\/projects\/(\d+)\/config$/);
  if (configMatch) {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(configMatch[1]));
    if (!project) {
      sendJson(404, { error: 'Project not found' });
      return;
    }
    if (req.method === 'GET') {
      sendJson(200, await readProjectConfig(project.path));
      return;
    }
    if (req.method === 'PUT') {
      let body: Partial<ProjectConfig>;
      try {
        body = JSON.parse(await readBody(req)) as Partial<ProjectConfig>;
      } catch {
        sendJson(400, { error: 'Invalid JSON body' });
        return;
      }
      const current = await readProjectConfig(project.path);
      const next: ProjectConfig = {
        autoSync: body.autoSync ?? current.autoSync,
        lastSyncAt: body.lastSyncAt ?? current.lastSyncAt,
      };
      await writeProjectConfig(project.path, next);
      sendJson(200, next);
      return;
    }
  }

  // --- statusline management ---
  // Global default template. Editing it re-renders every following project,
  // which is the per-project auto-sync mechanism.
  if (pathname === '/statusline/global') {
    if (!requireAuth()) return;
    if (req.method === 'GET') {
      sendJson(200, { config: await readGlobalStatuslineConfig() });
      return;
    }
    if (req.method === 'PUT') {
      let body: StatuslineConfig;
      try {
        body = JSON.parse(await readBody(req)) as StatuslineConfig;
      } catch {
        sendJson(400, { error: 'Invalid JSON body' });
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
        sendJson(200, { ok: true });
      } catch (e) {
        sendJson(400, { error: e instanceof Error ? e.message : 'Global statusline update failed' });
      }
      return;
    }
  }

  const statuslineMatch = pathname.match(/^\/projects\/(\d+)\/statusline$/);
  if (statuslineMatch) {
    if (!requireAuth()) return;
    const project = deps.projects.getById(Number(statuslineMatch[1]));
    if (!project) {
      sendJson(404, { error: 'Project not found' });
      return;
    }
    if (req.method === 'GET') {
      const [config, script, globalConfig] = await Promise.all([
        readStatuslineConfig(project.path),
        readStatuslineScript(project.path),
        readGlobalStatuslineConfig(),
      ]);
      sendJson(200, { config, script, globalConfig });
      return;
    }
    if (req.method === 'PUT') {
      let body: StatuslineConfig;
      try {
        body = JSON.parse(await readBody(req)) as StatuslineConfig;
      } catch {
        sendJson(400, { error: 'Invalid JSON body' });
        return;
      }
      try {
        await applyStatuslineConfig(project.path, body);
        sendJson(200, { ok: true });
      } catch (e) {
        sendJson(400, { error: e instanceof Error ? e.message : 'Statusline update failed' });
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
      sendJson(400, { error: 'Missing "path" query parameter' });
      return;
    }
    if (!deps.watch) {
      sendJson(503, { error: 'Watch service unavailable' });
      return;
    }
    sendJson(200, { projectPath, assets: deps.watch.getAssets(projectPath) });
    return;
  }

  if (pathname === '/projects' && req.method === 'GET') {
    if (!requireAuth()) return;
    sendJson(200, { projects: deps.projects.list() });
    return;
  }

  // Static SPA hosting (GET only, unauthenticated). Non-file paths fall back
  // to index.html so client-side routing works on deep links.
  if (req.method === 'GET' && deps.staticDir) {
    serveStatic(res, pathname, deps.staticDir);
    return;
  }

  sendJson(404, { error: 'Not found' });
}

/** Upgrade a response to an SSE stream subscribed to the watch service. */
function handleSse(req: IncomingMessage, res: ServerResponse, deps: WeaveServerDeps): void {
  if (!deps.watch) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Watch service unavailable' }));
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const unsubscribe = deps.watch.subscribe((e) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  });

  req.on('close', () => {
    unsubscribe();
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

/** Collect the request body into a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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
