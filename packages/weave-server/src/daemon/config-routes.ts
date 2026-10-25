import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { access } from 'node:fs/promises';
import { isHarness, type Harness } from '@weavecode/core';
import type { ConfigFileId, ConfigSurface } from '@weavecode/harness';
import { configSurfaceFor } from '../surfaces.js';
import { applyUpdates, type ConfigUpdate } from '../config/dotted.js';
import {
  createProfile,
  listBackups,
  listProfiles,
  readBackup,
  readSnapshot,
  removeProfile,
  renameProfile,
  pushBackup,
  saveProfile,
  setActive,
} from '../config/profiles.js';
import { readBody, sendJson } from './http.js';
import { getHarnessConfigDir } from '../db/paths.js';
import type { WeaveServerDeps } from './server.js';

const FILE_IDS: readonly ConfigFileId[] = ['user', 'project', 'projectLocal', 'global'];

interface SurfaceCtx {
  projectPath: string | null;
  homedir: string;
}

function asFileId(raw: unknown): ConfigFileId | null {
  return typeof raw === 'string' && (FILE_IDS as readonly string[]).includes(raw) ? (raw as ConfigFileId) : null;
}

/** 值对象 → 活文件原文（格式归 harness：claude=JSON，codex=TOML）。 */
function textOf(surface: ConfigSurface, values: Record<string, unknown>): string {
  return surface.serializeRaw(values);
}

/** 档位 → 实际路径；project 档要项目路径（由 projectId 查库得出，绝不收前端路径）。 */
function pathFor(
  surface: ConfigSurface,
  file: ConfigFileId,
  ctx: SurfaceCtx,
): string {
  const spec = surface.files(ctx).find((f) => f.id === file);
  return spec ? spec.path(ctx) : '';
}

async function readBodyJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readBody(req)) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  if (!target) return false;
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** 一次完整的读：活配置 + 托管键 + 快照/漂移/备份，GET 与各写动作的响应共用。 */
async function snapshotView(
  root: string,
  harness: Harness,
  surface: ConfigSurface,
  file: ConfigFileId,
  ctx: SurfaceCtx,
): Promise<Record<string, unknown>> {
  const target = pathFor(surface, file, ctx);
  const values = await surface.read(file, ctx);
  const liveText = textOf(surface, values);
  const state = await listProfiles(root, harness, file);
  const active = state.activeId ? await readSnapshot(root, harness, file, state.activeId) : null;
  const activeText = active ? textOf(surface, active) : null;
  return {
    harness,
    file,
    path: target,
    exists: await exists(target),
    values,
    managedKeys: surface.managedKeys(values),
    managedEntries: surface.managedEntries(values),
    profiles: state.profiles,
    activeId: state.activeId,
    liveText,
    activeText,
    drifted: activeText !== null && activeText !== liveText,
    backups: await listBackups(root, harness, file),
  };
}

function resolveTarget(
  deps: WeaveServerDeps,
  file: ConfigFileId,
  projectIdRaw: unknown,
): SurfaceCtx | string {
  let projectPath: string | null = null;
  if (file === 'project' || file === 'projectLocal') {
    const projectId = Number(projectIdRaw);
    if (!Number.isInteger(projectId) || projectId <= 0) return '需要 projectId';
    const project = deps.projects.getById(projectId);
    if (!project) return '项目不存在';
    projectPath = project.path;
  }
  return { projectPath, homedir: homedir() };
}

/**
 * 资源管理 · harness 配置面（`/harness-config/*`）。
 *
 * 词表/落点/托管键/模型接口文法全归 harness 的 config 槽；这里只做「取档 → 读改写 →
 * 快照与漂移」的装配。profile 快照落 `local/harness-config/<harness>/`，
 * 写盘一律留备份。
 */
export async function handleConfigRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (!pathname.startsWith('/harness-config')) return false;

  const root = getHarnessConfigDir();

  // --- 词表（按 harness 缓存；无 config 槽 → supported:false，web 渲染占位） ---
  if (pathname === '/harness-config/catalog' && req.method === 'GET') {
    const harness = url.searchParams.get('harness');
    if (!isHarness(harness)) {
      sendJson(res, 400, { error: 'Unknown harness' });
      return true;
    }
    const surface = configSurfaceFor(harness);
    if (!surface) {
      sendJson(res, 200, { supported: false });
      return true;
    }
    const file = asFileId(url.searchParams.get('file')) ?? 'user';
    const ctx: SurfaceCtx = { projectPath: null, homedir: homedir() };
    const catalog = surface.catalog(file);
    sendJson(res, 200, {
      supported: true,
      harness,
      file,
      rawFormat: surface.rawFormat,
      files: surface.files(ctx).map((f) => ({ id: f.id, profiles: f.profiles })),
      groups: catalog.groups,
      keys: catalog.keys,
      envVars: catalog.envVars,
    });
    return true;
  }

  // --- 读一份配置（活文件最新内容 + 快照/漂移） ---
  if (pathname === '/harness-config' && req.method === 'GET') {
    const harness = url.searchParams.get('harness');
    const file = asFileId(url.searchParams.get('file'));
    if (!isHarness(harness) || !file) {
      sendJson(res, 400, { error: 'Unknown harness or file' });
      return true;
    }
    const surface = configSurfaceFor(harness);
    if (!surface) {
      sendJson(res, 400, { error: '配置面未实现' });
      return true;
    }
    const ctx = resolveTarget(deps, file, url.searchParams.get('projectId'));
    if (typeof ctx === 'string') {
      sendJson(res, 400, { error: ctx });
      return true;
    }
    sendJson(res, 200, await snapshotView(root, harness, surface, file, ctx));
    return true;
  }

  // --- 表单批量写（读最新 → 深路径落值 → 备份 → 写盘 → 同步激活快照） ---
  if (pathname === '/harness-config/values' && req.method === 'PUT') {
    const body = await readBodyJson(req);
    if (!body) {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const harness = body['harness'];
    const file = asFileId(body['file']);
    if (!isHarness(harness) || !file) {
      sendJson(res, 400, { error: 'Unknown harness or file' });
      return true;
    }
    const surface = configSurfaceFor(harness);
    if (!surface) {
      sendJson(res, 400, { error: '配置面未实现' });
      return true;
    }
    const ctx = resolveTarget(deps, file, body['projectId']);
    if (typeof ctx === 'string') {
      sendJson(res, 400, { error: ctx });
      return true;
    }
    const updates = Array.isArray(body['updates']) ? (body['updates'] as ConfigUpdate[]) : null;
    if (!updates) {
      sendJson(res, 400, { error: 'Missing "updates"' });
      return true;
    }
    try {
      const current = await surface.read(file, ctx);
      const next = applyUpdates(current, updates);
      await pushBackup(root, harness, file, current);
      await surface.write(file, ctx, next);
      const state = await listProfiles(root, harness, file);
      if (state.activeId) await saveProfile(root, harness, file, state.activeId, next);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return true;
    }
    sendJson(res, 200, await snapshotView(root, harness, surface, file, ctx));
    return true;
  }

  // --- 原始 JSON 整份写（文本即词表内的键；未知键由 surface 原样保留） ---
  if (pathname === '/harness-config/raw' && req.method === 'PUT') {
    const body = await readBodyJson(req);
    if (!body) {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const harness = body['harness'];
    const file = asFileId(body['file']);
    if (!isHarness(harness) || !file) {
      sendJson(res, 400, { error: 'Unknown harness or file' });
      return true;
    }
    const surface = configSurfaceFor(harness);
    if (!surface) {
      sendJson(res, 400, { error: '配置面未实现' });
      return true;
    }
    const ctx = resolveTarget(deps, file, body['projectId']);
    if (typeof ctx === 'string') {
      sendJson(res, 400, { error: ctx });
      return true;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = surface.parseRaw(String(body['text'] ?? ''));
    } catch (err) {
      sendJson(res, 400, { error: `不是合法${surface.rawFormat === 'toml' ? ' TOML' : ' JSON'}：${(err as Error).message}` });
      return true;
    }
    try {
      const current = await surface.read(file, ctx);
      await pushBackup(root, harness, file, current);
      await surface.write(file, ctx, parsed);
      const state = await listProfiles(root, harness, file);
      if (state.activeId) await saveProfile(root, harness, file, state.activeId, await surface.read(file, ctx));
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return true;
    }
    sendJson(res, 200, await snapshotView(root, harness, surface, file, ctx));
    return true;
  }

  // --- profile 生命周期（创建/保存/复制/改名/删/切换/接受漂移/恢复备份） ---
  if (pathname === '/harness-config/profile' && req.method === 'POST') {
    const body = await readBodyJson(req);
    if (!body) {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const harness = body['harness'];
    const file = asFileId(body['file']);
    const action = body['action'];
    if (!isHarness(harness) || !file || typeof action !== 'string') {
      sendJson(res, 400, { error: 'Unknown harness, file or action' });
      return true;
    }
    const surface = configSurfaceFor(harness);
    if (!surface) {
      sendJson(res, 400, { error: '配置面未实现' });
      return true;
    }
    const ctx = resolveTarget(deps, file, body['projectId']);
    if (typeof ctx === 'string') {
      sendJson(res, 400, { error: ctx });
      return true;
    }
    const id = typeof body['id'] === 'string' ? body['id'] : '';
    const name = typeof body['name'] === 'string' ? body['name'].trim() : '';

    switch (action) {
      case 'list': {
        const state = await listProfiles(root, harness, file);
        sendJson(res, 200, state);
        return true;
      }
      case 'create': {
        const state = await listProfiles(root, harness, file);
        const meta = await createProfile(
          root,
          harness,
          file,
          name || `配置 ${state.profiles.length + 1}`,
          await surface.read(file, ctx),
        );
        sendJson(res, 200, { profile: meta, state: await listProfiles(root, harness, file) });
        return true;
      }
      case 'save': {
        const state = await listProfiles(root, harness, file);
        if (!state.profiles.some((p) => p.id === id)) {
          sendJson(res, 404, { error: '配置不存在' });
          return true;
        }
        await saveProfile(root, harness, file, id, await surface.read(file, ctx));
        sendJson(res, 200, await listProfiles(root, harness, file));
        return true;
      }
      case 'duplicate': {
        const values = await readSnapshot(root, harness, file, id);
        if (!values) {
          sendJson(res, 404, { error: '配置不存在' });
          return true;
        }
        const state = await listProfiles(root, harness, file);
        const meta = await createProfile(root, harness, file, name || `配置 ${state.profiles.length + 1}`, values);
        sendJson(res, 200, { profile: meta, state: await listProfiles(root, harness, file) });
        return true;
      }
      case 'rename': {
        if (!name) {
          sendJson(res, 400, { error: '缺少名称' });
          return true;
        }
        await renameProfile(root, harness, file, id, name);
        sendJson(res, 200, await listProfiles(root, harness, file));
        return true;
      }
      case 'remove': {
        await removeProfile(root, harness, file, id);
        sendJson(res, 200, await listProfiles(root, harness, file));
        return true;
      }
      case 'activate': {
        const values = await readSnapshot(root, harness, file, id);
        if (!values) {
          sendJson(res, 404, { error: '配置不存在' });
          return true;
        }
        const live = await surface.read(file, ctx);
        if (body['confirm'] !== true) {
          // 先给两侧文本，由 web 弹 diff modal 交用户确认
          sendJson(res, 200, {
            requiresConfirm: true,
            liveText: textOf(surface, live),
            profileText: textOf(surface, values),
          });
          return true;
        }
        try {
          await pushBackup(root, harness, file, live);
          await surface.write(file, ctx, values);
          await setActive(root, harness, file, id);
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
          return true;
        }
        sendJson(res, 200, await snapshotView(root, harness, surface, file, ctx));
        return true;
      }
      case 'acceptDrift': {
        await saveProfile(root, harness, file, id, await surface.read(file, ctx));
        sendJson(res, 200, await snapshotView(root, harness, surface, file, ctx));
        return true;
      }
      case 'restoreBackup': {
        const backupId = typeof body['backupId'] === 'string' ? body['backupId'] : '';
        const values = await readBackup(root, harness, file, backupId);
        if (!values) {
          sendJson(res, 404, { error: '备份不存在' });
          return true;
        }
        try {
          await pushBackup(root, harness, file, await surface.read(file, ctx));
          await surface.write(file, ctx, values);
          const state = await listProfiles(root, harness, file);
          if (state.activeId) await saveProfile(root, harness, file, state.activeId, values);
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
          return true;
        }
        sendJson(res, 200, await snapshotView(root, harness, surface, file, ctx));
        return true;
      }
      default:
        sendJson(res, 400, { error: `未知动作：${action}` });
        return true;
    }
  }

  // --- 模型列表（凭配置里的 baseUrl + key 调宿主接口） ---
  if (pathname === '/harness-config/models' && req.method === 'POST') {
    const body = await readBodyJson(req);
    if (!body) {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const harness = body['harness'];
    const file = asFileId(body['file']) ?? 'user';
    if (!isHarness(harness)) {
      sendJson(res, 400, { error: 'Unknown harness' });
      return true;
    }
    const surface = configSurfaceFor(harness);
    if (!surface) {
      sendJson(res, 400, { error: '配置面未实现' });
      return true;
    }
    const ctx = resolveTarget(deps, file, body['projectId']);
    if (typeof ctx === 'string') {
      sendJson(res, 400, { error: ctx });
      return true;
    }
    try {
      const values = await surface.read(file, ctx);
      const result = await surface.models({
        values,
        homedir: ctx.homedir,
        baseUrl: typeof body['baseUrl'] === 'string' ? body['baseUrl'] : null,
        apiKey: typeof body['apiKey'] === 'string' ? body['apiKey'] : null,
        authToken: typeof body['authToken'] === 'string' ? body['authToken'] : null,
      });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 502, { error: (err as Error).message });
    }
    return true;
  }

  // --- 待保存预览（不落盘：把 updates 应用在活配置上，回前后两份原文给 web 弹 diff） ---
  if (pathname === '/harness-config/preview' && req.method === 'POST') {
    const body = await readBodyJson(req);
    if (!body) {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const harness = body['harness'];
    const file = asFileId(body['file']);
    if (!isHarness(harness) || !file) {
      sendJson(res, 400, { error: 'Unknown harness or file' });
      return true;
    }
    const surface = configSurfaceFor(harness);
    if (!surface) {
      sendJson(res, 400, { error: '配置面未实现' });
      return true;
    }
    const ctx = resolveTarget(deps, file, body['projectId']);
    if (typeof ctx === 'string') {
      sendJson(res, 400, { error: ctx });
      return true;
    }
    const updates = Array.isArray(body['updates']) ? (body['updates'] as ConfigUpdate[]) : null;
    if (!updates) {
      sendJson(res, 400, { error: 'Missing "updates"' });
      return true;
    }
    try {
      const current = await surface.read(file, ctx);
      const next = applyUpdates(current, updates);
      sendJson(res, 200, { before: textOf(surface, current), after: textOf(surface, next) });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  // 认领了前缀但没命中任何分支：给 404，别掉回主链当静态资源找
  sendJson(res, 404, { error: 'Not found' });
  return true;
}
