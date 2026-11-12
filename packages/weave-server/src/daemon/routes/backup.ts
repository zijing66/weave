import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getDataRoot } from '../../db/paths.js';
import { readDaemonSettings, writeDaemonSettings } from '../settings.js';
import { readBody, sendJson } from '../http.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * 每日自动备份面：状态（含进度/ETA——全屏 loading 数据源）、手动触发、
 * 包列表。引擎缺省不挂 = 503（CLI/测试装配不带备份）。
 */

export async function handleBackupRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/backup')) return false;
  const engine = deps.backupEngine;
  if (!engine) {
    sendJson(res, 503, { error: 'Backup engine not configured' });
    return true;
  }

  // GET /backup/status — 运行态 + 进度 + 当前设置（一处取齐，前端免拼）。
  if (pathname === '/backup/status' && req.method === 'GET') {
    const settings = await readDaemonSettings();
    sendJson(res, 200, {
      status: engine.status,
      settings: settings.backup,
      packages: await listPackages(),
    });
    return true;
  }

  // POST /backup/run — 手动触发（includeHistory 从设置带，body 可覆盖）；忙时 409。
  if (pathname === '/backup/run' && req.method === 'POST') {
    if (engine.status.running) {
      sendJson(res, 409, { error: 'Backup already running' });
      return true;
    }
    let body: { includeHistory?: unknown } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      // 空 body 合法（无 Content-Type 的 curl 常态）
    }
    const settings = await readDaemonSettings();
    const includeHistory =
      typeof body.includeHistory === 'boolean'
        ? body.includeHistory
        : (settings.backup?.includeHistory ?? false);
    const result = await engine.run(includeHistory);
    if (result == null) {
      sendJson(res, 500, { error: engine.status.lastError ?? 'Backup failed' });
      return true;
    }
    sendJson(res, 200, { result, packages: await listPackages() });
    return true;
  }

  // PUT /backup/settings — 只改 backup 段（enabled/hour/includeHistory）。
  if (pathname === '/backup/settings' && req.method === 'PUT') {
    let body: { enabled?: unknown; hour?: unknown; includeHistory?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const current = await readDaemonSettings();
    const cur = current.backup ?? { enabled: true, hour: 1, includeHistory: false };
    const saved = await writeDaemonSettings({
      ...current,
      backup: {
        enabled: typeof body.enabled === 'boolean' ? body.enabled : cur.enabled,
        hour: typeof body.hour === 'number' ? body.hour : cur.hour,
        includeHistory:
          typeof body.includeHistory === 'boolean' ? body.includeHistory : cur.includeHistory,
      },
    });
    sendJson(res, 200, { settings: saved.backup });
    return true;
  }

  return false;
}

/** `data/backups/` 包清单（新→旧；只认本引擎命名，迁移 bak 不混入）。 */
async function listPackages(): Promise<Array<{ name: string; bytes: number; at: string }>> {
  let names: string[] = [];
  try {
    names = await readdir(path.join(getDataRoot(), 'backups'));
  } catch {
    return [];
  }
  const rows: Array<{ name: string; bytes: number; at: string }> = [];
  for (const name of names) {
    const m = name.match(/^weave-backup-(\d{4}-\d{2}-\d{2}-\d{6})\.tar\.gz$/);
    if (!m) continue;
    try {
      const st = await stat(path.join(getDataRoot(), 'backups', name));
      rows.push({ name, bytes: st.size, at: m[1]! });
    } catch {
      // 列表态读不到就略过
    }
  }
  return rows.reverse();
}
