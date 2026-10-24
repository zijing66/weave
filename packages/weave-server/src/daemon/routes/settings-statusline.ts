import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WeaveServerDeps } from '../server.js';
import { readBody, sendJson } from '../http.js';
import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_DECISION_SETTINGS,
  readDaemonSettings,
  writeDaemonSettings,
  terminalPresetsFor,
  type DaemonSettings,
} from '../settings.js';
import { readAiKey, writeAiKey } from '../ai-config.js';
import { readDecisionKey, writeDecisionKey } from '../decision-config.js';
import { accessUrls } from '../tls.js';
import { applyLaunchOnLogin } from '../auto-start.js';
import { readProjectConfig, writeProjectConfig } from '../../install/project-config.js';
import type { ProjectConfig } from '../../install/project-config.js';
import {
  readStatuslineConfig,
  readStatuslineScript,
  readStatuslineFacts,
  applyStatuslineConfig,
  readGlobalStatuslineConfig,
  writeGlobalStatuslineConfig,
} from '../../statusline/manager.js';
import { DEFAULT_STATUSLINE_CONFIG, type StatuslineConfig } from '../../statusline/config.js';
import { listBrowseRoots, listDirectoryChildren } from '../fs-browser.js';
import { projectFileNamespaces } from '../../hooks/toolkit.js';
import { listGlobalFileAssets } from '../../install/global-file-assets.js';

/**
 * /settings 的对外形状：`ai` / `decision` 段各补 `apiKey`（回显，设置页掩码展示）
 * 与派生布尔 `apiKeySet`（地址/模型来自 settings 表，key 来自 `<local>/ai.json`
 * 与 `<local>/decision.json`——0600 本机文件，dashboard 有认证门，回显给已登录的本机管理面）。
 */
function withApiKeyStatus(
  settings: DaemonSettings,
  aiKeyPath?: string,
  decisionKeyPath?: string,
): Record<string, unknown> {
  const ai = settings.ai ?? DEFAULT_AI_SETTINGS;
  const decision = settings.decision ?? DEFAULT_DECISION_SETTINGS;
  const aiKey = readAiKey(aiKeyPath);
  const decisionKey = readDecisionKey(decisionKeyPath);
  return {
    ...settings,
    ai: { baseUrl: ai.baseUrl, model: ai.model, apiKey: aiKey, apiKeySet: aiKey !== null },
    decision: {
      baseUrl: decision.baseUrl,
      model: decision.model,
      apiKey: decisionKey,
      apiKeySet: decisionKey !== null,
    },
  };
}

/** 落 settings 表前剥掉只写的 `apiKey`（它归 ai.json / decision.json，不归本表）。 */
function stripApiKey<T extends { apiKey?: string | null }>(
  section: T | undefined,
): Omit<T, 'apiKey'> | undefined {
  if (!section) return undefined;
  const { apiKey: _writeOnly, ...rest } = section;
  return rest;
}

/**
 * 设置/状态栏域路由：daemon settings（含 AI/决策 key 只写面）、目录浏览、
 * project weave config、statusline 管理、assets/global-file-assets 只读面。
 * 返回 true = 本路由认领；false = 未命中，主链继续。
 */
export async function handleSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  // --- daemon settings (terminal preset for "open in terminal") ---
  if (pathname === '/settings') {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        settings: withApiKeyStatus(await readDaemonSettings(), deps.aiKeyPath, deps.decisionKeyPath),
        presets: terminalPresetsFor(process.platform),
        platform: process.platform,
        // 对外访问地址（设置页展示面）：全部局域网 IP × 已开协议。
        urls: accessUrls(deps.port, deps.tlsPort ?? 0),
      });
      return true;
    }
    if (req.method === 'PUT') {
      let body: Partial<DaemonSettings> & {
        ai?: { apiKey?: string | null };
        decision?: { apiKey?: string | null };
      };
      try {
        body = JSON.parse(await readBody(req)) as Partial<DaemonSettings> & {
          ai?: { apiKey?: string | null };
        };
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      // `ai.apiKey` / `decision.apiKey` 是**只写**字段：拆出来落 <local>/ai.json 与
      // <local>/decision.json（0600），不进 settings 表；响应与 GET 都只回派生布尔
      // apiKeySet——密钥永不回显。
      const apiKey = body.ai?.apiKey;
      if (apiKey !== undefined) {
        writeAiKey(typeof apiKey === 'string' ? apiKey : null, deps.aiKeyPath);
      }
      const decisionKey = body.decision?.apiKey;
      if (decisionKey !== undefined) {
        writeDecisionKey(typeof decisionKey === 'string' ? decisionKey : null, deps.decisionKeyPath);
      }
      // 段级合并：请求里**缺席的段继承现值**（整体覆盖语义下，旧构建的设置页保存
      // 其它设置时会把没进表单的段——如 decision——静默清空，实测清过一次）。
      // 显式给出的段照常覆盖（用户清空某字段 ≠ 段缺席）。
      const current = await readDaemonSettings();
      const saved = await writeDaemonSettings({
        ...current,
        ...body,
        ai: body.ai ? stripApiKey(body.ai) : current.ai,
        decision: body.decision ? stripApiKey(body.decision) : current.decision,
      } as DaemonSettings);
      // 保留期等事件策略改动即刻生效：重置被动清理天标记，下一条事件写入
      // 就按新配置重扫（否则要等次日跨天）。
      deps.hookEvents?.resetPrune();
      // 开机自启即刻注册/注销（内部吞错，不阻塞保存响应）。
      (deps.autoStart ?? applyLaunchOnLogin)(saved.startup?.launchOnLogin ?? false);
      deps.dataBus?.emit({ key: 'settings' });
      sendJson(res, 200, withApiKeyStatus(saved, deps.aiKeyPath, deps.decisionKeyPath));
      return true;
    }
  }

  // --- cross-platform directory browsing (powers the web folder picker) ---
  if (pathname === '/fs/roots' && req.method === 'GET') {
    const libraryPaths = deps.libraries ? deps.libraries.list().map((l) => l.path) : [];
    const roots = await listBrowseRoots(libraryPaths);
    sendJson(res, 200, { roots });
    return true;
  }
  if (pathname === '/fs/children' && req.method === 'GET') {
    const dirPath = url.searchParams.get('path');
    if (!dirPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return true;
    }
    try {
      const children = await listDirectoryChildren(dirPath);
      sendJson(res, 200, { children });
    } catch (err) {
      sendJson(res, 400, { error: `Cannot list directory: ${String(err)}` });
    }
    return true;
  }

  // --- project weave config（同步范围由 git 分类单点决定，这里只有 lastSyncAt）---
  const configMatch = pathname.match(/^\/projects\/(\d+)\/config$/);
  if (configMatch) {
    const project = deps.projects.getById(Number(configMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, await readProjectConfig(project.path));
      return true;
    }
    if (req.method === 'PUT') {
      let body: Partial<ProjectConfig>;
      try {
        body = JSON.parse(await readBody(req)) as Partial<ProjectConfig>;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      const current = await readProjectConfig(project.path);
      const next: ProjectConfig = {
        lastSyncAt: body.lastSyncAt ?? current.lastSyncAt,
      };
      await writeProjectConfig(project.path, next);
      sendJson(res, 200, next);
      return true;
    }
  }

  // --- statusline management ---
  // Global default template. Editing it re-renders every following project,
  // which is the per-project auto-sync mechanism.
  if (pathname === '/statusline/global') {
    if (req.method === 'GET') {
      sendJson(res, 200, { config: await readGlobalStatuslineConfig() });
      return true;
    }
    if (req.method === 'PUT') {
      let body: StatuslineConfig;
      try {
        body = JSON.parse(await readBody(req)) as StatuslineConfig;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
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
      return true;
    }
  }

  // Shipped factory defaults — the panel's 恢复出厂 fetches these, so the
  // reset target always comes from the server (single source of truth).
  if (pathname === '/statusline/default' && req.method === 'GET') {
    sendJson(res, 200, { config: DEFAULT_STATUSLINE_CONFIG });
    return true;
  }

  const statuslineMatch = pathname.match(/^\/projects\/(\d+)\/statusline$/);
  if (statuslineMatch) {
    const project = deps.projects.getById(Number(statuslineMatch[1]));
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return true;
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
      return true;
    }
    if (req.method === 'PUT') {
      let body: StatuslineConfig;
      try {
        body = JSON.parse(await readBody(req)) as StatuslineConfig;
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return true;
      }
      try {
        await applyStatuslineConfig(project.path, body);
        deps.dataBus?.emit({ key: 'statusline', projectPath: project.path });
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : 'Statusline update failed' });
      }
      return true;
    }
  }

  // /assets?path=<encodedProjectPath> — read cached asset entries for a project.
  if (pathname === '/assets' && req.method === 'GET') {
    const projectPath = url.searchParams.get('path');
    if (!projectPath) {
      sendJson(res, 400, { error: 'Missing "path" query parameter' });
      return true;
    }
    if (!deps.watch) {
      sendJson(res, 503, { error: 'Watch service unavailable' });
      return true;
    }
    // 仓库标记来自包落盘记录（watch 缓存只知道文件在不在，不知道谁铺的）。
    const namespaces = await projectFileNamespaces(projectPath);
    const assets = deps.watch.getAssets(projectPath).map((a) => {
      const namespace = namespaces.get(a.relPath);
      return namespace ? { ...a, namespace } : a;
    });
    sendJson(res, 200, { projectPath, assets });
    return true;
  }

  // /global-file-assets — curated machine-level harness files (~/.claude,
  // ~/.codex) for the global 文件资产 tree. A bounded whitelist walk, never a
  // home-directory scan.
  if (pathname === '/global-file-assets' && req.method === 'GET') {
    sendJson(res, 200, { assets: await listGlobalFileAssets() });
    return true;
  }

  return false;
}
