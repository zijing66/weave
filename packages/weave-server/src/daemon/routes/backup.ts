import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { getBackupsDir } from '../../db/paths.js';
import { readDaemonSettings, writeDaemonSettings } from '../settings.js';
import { readBody, sendJson } from '../http.js';
import { writePendingRestore } from '../backup.js';
import type { WeaveServerDeps } from '../server.js';

/**
 * 每日自动备份面：状态（含进度/ETA——全屏 loading 数据源）、手动触发、
 * 包列表、还原。引擎缺省不挂 = 503（CLI/测试装配不带备份）。
 */

/** 还原确认词：用户必须在弹窗里原样输入/粘贴它（二次提醒防误触）。 */
export const RESTORE_CONFIRM_TEXT = '恢复备份';

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

  // POST /backup/restore — 还原约单（真覆写在下次启动的 applyPendingRestore）：
  // ① confirm 必须逐字等于确认词（二次提醒）；② 包必须验得出 manifest；
  // ③ 覆写前先打一份安全备份（还原动作本身可回退）；④ 落 pending 后走既有
  // requestShutdown 链优雅停机（WAL 并回），前端提示「daemon 重启中」。
  if (pathname === '/backup/restore' && req.method === 'POST') {
    if (engine.status.running) {
      sendJson(res, 409, { error: 'Backup running, try again after it finishes' });
      return true;
    }
    let body: { file?: unknown; confirm?: unknown } = {};
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      // 空 body 走下面的字段校验报错
    }
    if (body.confirm !== RESTORE_CONFIRM_TEXT) {
      sendJson(res, 400, { error: `confirm text mismatch — type "${RESTORE_CONFIRM_TEXT}" exactly` });
      return true;
    }
    if (typeof body.file !== 'string' || !/^weave-backup-[\d-]+\.tar\.gz$/.test(body.file)) {
      sendJson(res, 400, { error: '"file" must be a weave-backup package name' });
      return true;
    }
    const file = path.join(getBackupsDir(), body.file);
    const manifest = await engine.readManifest(file);
    if (!manifest) {
      sendJson(res, 400, { error: 'Not a valid weave backup package' });
      return true;
    }
    // 覆写前的安全备份（按包自己的口径带不带历史）
    const safety = await engine.run(manifest.includeHistory);
    if (safety == null) {
      sendJson(res, 500, { error: engine.status.lastError ?? 'Safety backup failed' });
      return true;
    }
    try {
      await writePendingRestore({ file, at: new Date().toISOString() });
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : 'cannot schedule restore' });
      return true;
    }
    if (!deps.requestShutdown) {
      // 无停机链（测试装配）：如实说明 pending 已落、要手动重启
      sendJson(res, 200, { ok: true, safetyBackup: safety.file, restarted: false });
      return true;
    }
    sendJson(res, 200, { ok: true, safetyBackup: safety.file, restarted: true });
    // 先把响应写出去，再跑停机链（同 /daemon/shutdown 的时序）
    setTimeout(() => deps.requestShutdown?.(), 0);
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

/** `<cache>/backups/` 包清单（新→旧；只认本引擎命名，迁移 bak 不混入）。 */
async function listPackages(): Promise<Array<{ name: string; bytes: number; at: string }>> {
  let names: string[] = [];
  try {
    names = await readdir(getBackupsDir());
  } catch {
    return [];
  }
  const rows: Array<{ name: string; bytes: number; at: string }> = [];
  for (const name of names) {
    const m = name.match(/^weave-backup-(\d{4}-\d{2}-\d{2}-\d{6})\.tar\.gz$/);
    if (!m) continue;
    try {
      const st = await stat(path.join(getBackupsDir(), name));
      rows.push({ name, bytes: st.size, at: m[1]! });
    } catch {
      // 列表态读不到就略过
    }
  }
  return rows.reverse();
}
