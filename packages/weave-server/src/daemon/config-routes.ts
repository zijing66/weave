import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { access } from 'node:fs/promises';
import { isHarness, type Harness } from '@weavecode/core';
import type { ConfigFileId, ConfigSurface } from '@weavecode/harness';
import { configSurfaceFor } from '../surfaces.js';
import {
  baselineSnapshot,
  createProfile,
  LASTSEEN_ID,
  listBackups,
  listProfiles,
  profileKeyOf,
  readBackup,
  readSnapshot,
  removeProfile,
  renameProfile,
  pushBackup,
  saveProfile,
  setActive,
  syncBaseline,
  writeSnapshot,
} from '../config/profiles.js';
import { readBody, sendJson } from './http.js';
import { getHarnessConfigDir } from '../db/paths.js';
import type { WeaveServerDeps } from './server.js';

const FILE_IDS: readonly ConfigFileId[] = ['user', 'project', 'projectLocal', 'global'];

interface SurfaceCtx {
  projectPath: string | null;
  /** project/projectLocal 档的快照/备份/基线按它隔离（profileKeyOf）。 */
  projectId: number | null;
  homedir: string;
}

/** 快照存储键：project/projectLocal 档带项目后缀，user/global 原样。 */
function scopeOf(file: ConfigFileId, ctx: SurfaceCtx): string {
  return profileKeyOf(file, ctx.projectId);
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
  const key = scopeOf(file, ctx);
  const target = pathFor(surface, file, ctx);
  const values = await surface.read(file, ctx);
  const liveText = textOf(surface, values);
  const state = await listProfiles(root, harness, key);
  // 漂移基线：活跃快照优先；没有活跃快照（project 档 / 还没建快照）落自动基线，
  // 首次查看立基线——否则这些档位的外部改动永远判不出漂移
  const baseline = await baselineSnapshot(root, harness, key, state);
  if (!baseline) await writeSnapshot(root, harness, key, LASTSEEN_ID, values);
  const baselineText = baseline ? textOf(surface, baseline) : textOf(surface, values);
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
    activeText: baselineText,
    drifted: baselineText !== liveText,
    backups: await listBackups(root, harness, key),
  };
}

function resolveTarget(
  deps: WeaveServerDeps,
  file: ConfigFileId,
  projectIdRaw: unknown,
): SurfaceCtx | string {
  let projectPath: string | null = null;
  let projectId: number | null = null;
  if (file === 'project' || file === 'projectLocal') {
    const id = Number(projectIdRaw);
    if (!Number.isInteger(id) || id <= 0) return '需要 projectId';
    const project = deps.projects.getById(id);
    if (!project) return '项目不存在';
    projectPath = project.path;
    projectId = id;
  }
  return { projectPath, projectId, homedir: homedir() };
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
    const ctx: SurfaceCtx = { projectPath: null, projectId: null, homedir: homedir() };
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

  // --- 表单保存（整份草稿写盘：备份 → 写 → 同步基线） ---
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
    const values = body['values'];
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      sendJson(res, 400, { error: 'Missing "values"' });
      return true;
    }
    try {
      const current = await surface.read(file, ctx);
      await pushBackup(root, harness, scopeOf(file, ctx), current);
      await surface.write(file, ctx, values as Record<string, unknown>);
      const state = await listProfiles(root, harness, scopeOf(file, ctx));
      await syncBaseline(root, harness, scopeOf(file, ctx), state, await surface.read(file, ctx));
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
      await pushBackup(root, harness, scopeOf(file, ctx), current);
      await surface.write(file, ctx, parsed);
      const state = await listProfiles(root, harness, scopeOf(file, ctx));
      await syncBaseline(root, harness, scopeOf(file, ctx), state, await surface.read(file, ctx));
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
    // 表单值（create/save 用）：不传 = 沿用旧行为读磁盘
    const formValues = typeof body['values'] === 'object' && body['values'] !== null && !Array.isArray(body['values'])
      ? (body['values'] as Record<string, unknown>)
      : null;

    switch (action) {
      case 'list': {
        const state = await listProfiles(root, harness, scopeOf(file, ctx));
        sendJson(res, 200, state);
        return true;
      }
      case 'create': {
        const state = await listProfiles(root, harness, scopeOf(file, ctx));
        const meta = await createProfile(
          root,
          harness,
          scopeOf(file, ctx),
          name || `配置 ${state.profiles.length + 1}`,
          formValues ?? (await surface.read(file, ctx)),
        );
        sendJson(res, 200, { profile: meta, state: await listProfiles(root, harness, scopeOf(file, ctx)) });
        return true;
      }
      case 'save': {
        const state = await listProfiles(root, harness, scopeOf(file, ctx));
        if (!state.profiles.some((p) => p.id === id)) {
          sendJson(res, 404, { error: '配置不存在' });
          return true;
        }
        await saveProfile(root, harness, scopeOf(file, ctx), id, formValues ?? (await surface.read(file, ctx)));
        sendJson(res, 200, await listProfiles(root, harness, scopeOf(file, ctx)));
        return true;
      }
      case 'compare': {
        // 对比页取目标原文：profile=快照 / backup=备份 / live=磁盘
        const target = body['target'];
        if (target === 'live') {
          sendJson(res, 200, { text: textOf(surface, await surface.read(file, ctx)) });
          return true;
        }
        if (target === 'backup') {
          const backupId = typeof body['backupId'] === 'string' ? body['backupId'] : '';
          const values = await readBackup(root, harness, scopeOf(file, ctx), backupId);
          if (!values) {
            sendJson(res, 404, { error: '备份不存在' });
            return true;
          }
          sendJson(res, 200, { text: textOf(surface, values) });
          return true;
        }
        const values = await readSnapshot(root, harness, scopeOf(file, ctx), id);
        if (!values) {
          sendJson(res, 404, { error: '配置不存在' });
          return true;
        }
        sendJson(res, 200, { text: textOf(surface, values) });
        return true;
      }
      case 'duplicate': {
        const values = await readSnapshot(root, harness, scopeOf(file, ctx), id);
        if (!values) {
          sendJson(res, 404, { error: '配置不存在' });
          return true;
        }
        const state = await listProfiles(root, harness, scopeOf(file, ctx));
        const meta = await createProfile(root, harness, scopeOf(file, ctx), name || `配置 ${state.profiles.length + 1}`, values);
        sendJson(res, 200, { profile: meta, state: await listProfiles(root, harness, scopeOf(file, ctx)) });
        return true;
      }
      case 'rename': {
        if (!name) {
          sendJson(res, 400, { error: '缺少名称' });
          return true;
        }
        await renameProfile(root, harness, scopeOf(file, ctx), id, name);
        sendJson(res, 200, await listProfiles(root, harness, scopeOf(file, ctx)));
        return true;
      }
      case 'remove': {
        await removeProfile(root, harness, scopeOf(file, ctx), id);
        sendJson(res, 200, await listProfiles(root, harness, scopeOf(file, ctx)));
        return true;
      }
      case 'activate': {
        const values = await readSnapshot(root, harness, scopeOf(file, ctx), id);
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
          await pushBackup(root, harness, scopeOf(file, ctx), live);
          await surface.write(file, ctx, values);
          await setActive(root, harness, scopeOf(file, ctx), id);
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
          return true;
        }
        sendJson(res, 200, await snapshotView(root, harness, surface, file, ctx));
        return true;
      }
      case 'acceptDrift': {
        // 覆盖存档前把原基线留一份进备份——误点后还能从备份找回
        const state = await listProfiles(root, harness, scopeOf(file, ctx));
        const prev = await baselineSnapshot(root, harness, scopeOf(file, ctx), state);
        if (prev) await pushBackup(root, harness, scopeOf(file, ctx), prev);
        await syncBaseline(root, harness, scopeOf(file, ctx), state, await surface.read(file, ctx));
        sendJson(res, 200, await snapshotView(root, harness, surface, file, ctx));
        return true;
      }
      case 'restoreBaseline': {
        // 漂移的反向出口：把基线（活跃快照或自动基线）写回文件，恢复到差异之前
        const state = await listProfiles(root, harness, scopeOf(file, ctx));
        const baseline = await baselineSnapshot(root, harness, scopeOf(file, ctx), state);
        if (!baseline) {
          sendJson(res, 404, { error: '没有可恢复的基线' });
          return true;
        }
        const live = await surface.read(file, ctx);
        if (body['confirm'] !== true) {
          sendJson(res, 200, {
            requiresConfirm: true,
            liveText: textOf(surface, live),
            baselineText: textOf(surface, baseline),
          });
          return true;
        }
        try {
          await pushBackup(root, harness, scopeOf(file, ctx), live);
          await surface.write(file, ctx, baseline);
          await syncBaseline(root, harness, scopeOf(file, ctx), state, baseline);
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
          return true;
        }
        sendJson(res, 200, await snapshotView(root, harness, surface, file, ctx));
        return true;
      }
      case 'restoreBackup': {
        const backupId = typeof body['backupId'] === 'string' ? body['backupId'] : '';
        const values = await readBackup(root, harness, scopeOf(file, ctx), backupId);
        if (!values) {
          sendJson(res, 404, { error: '备份不存在' });
          return true;
        }
        const live = await surface.read(file, ctx);
        if (body['confirm'] !== true) {
          // 先给两侧文本，由 web 弹 diff modal 交用户确认（此拍不落盘）
          sendJson(res, 200, {
            requiresConfirm: true,
            liveText: textOf(surface, live),
            backupText: textOf(surface, values),
          });
          return true;
        }
        try {
          await pushBackup(root, harness, scopeOf(file, ctx), live);
          await surface.write(file, ctx, values);
          const state = await listProfiles(root, harness, scopeOf(file, ctx));
          await syncBaseline(root, harness, scopeOf(file, ctx), state, values);
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
        file,
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

  // --- 对比预览（不落盘：草稿 vs 目标原文，两侧文本给 web 弹 diff） ---
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
    const values = body['values'];
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      sendJson(res, 400, { error: 'Missing "values"' });
      return true;
    }
    try {
      const current = await surface.read(file, ctx);
      sendJson(res, 200, {
        before: textOf(surface, current),
        after: textOf(surface, values as Record<string, unknown>),
      });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  // 认领了前缀但没命中任何分支：给 404，别掉回主链当静态资源找
  sendJson(res, 404, { error: 'Not found' });
  return true;
}
