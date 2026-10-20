import { basename, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openDatabase } from './db/db.js';
import { ProjectRepository } from './repositories/projects.js';
import { HookDispatchRepository } from './repositories/hook-dispatches.js';
import { HookEventRepository } from './repositories/hook-events.js';
import { SessionRepository } from './repositories/sessions.js';
import { SessionWatchRepository } from './repositories/session-watches.js';
import { OrchestrationRepository, OrchestrationRunRepository } from './repositories/orchestrations.js';
import { SideQuestionRepository } from './repositories/side-questions.js';
import { generateToken } from './daemon/auth.js';
import { purgeProjectPipeline } from './daemon/hook-pipeline.js';
import { hooksRoot } from './hooks/mirror.js';

export interface RegisterResult {
  id: number;
  token: string;
  path: string;
}

/**
 * Register a project in the global registry and persist its per-project token
 * into `<project>/.weave/token` (consumed by hook scripts in a later phase).
 *
 * Idempotent: re-registering an existing path reuses its original token.
 */
export function registerProject(targetDir: string, source: 'init' | 'scan', dbPath?: string): RegisterResult {
  const db = openDatabase(dbPath);
  try {
    const projects = new ProjectRepository(db);
    const existing = projects.getByPath(targetDir);
    const token = existing?.token ?? generateToken();
    const row = projects.register({ path: targetDir, name: basename(targetDir), token, source });

    mkdirSync(join(targetDir, '.weave'), { recursive: true });
    writeFileSync(join(targetDir, '.weave', 'token'), token + '\n', 'utf-8');

    return { id: row.id, token, path: row.path };
  } finally {
    db.close();
  }
}

export interface UnregisterResult {
  id: number;
  name: string;
  path: string;
  purged: { events: number; dispatches: number; sessions: number };
}

/**
 * `registerProject` 的逆：把项目从全局注册表整行删除（含归档行）。先按
 * 归档路由同一套顺序清运行数据（派发 → 事件 → 会话），焚毁 daemon 侧
 * 管道文件（inbox/mirror/outbox），再删行——运行中的 daemon 由 watch
 * reconcile ≤5s 内自然收掉 watcher 并广播 project:removed。
 *
 * 未注册返回 null；不触碰项目目录本身（本地生成物归 uninstall 流程管）。
 */
export function unregisterProject(
  targetDir: string,
  dbPath?: string,
  hooksDir?: string,
): UnregisterResult | null {
  const db = openDatabase(dbPath);
  try {
    const projects = new ProjectRepository(db);
    const row = projects.getByPath(targetDir);
    if (!row) return null;
    const dispatches = new HookDispatchRepository(db).deleteByProject(row.id);
    const events = new HookEventRepository(db).deleteByProject(row.id);
    // 订阅/编排按项目会话集圈行——必须在会话行删除之前（同归档路由的顺序）
    new SessionWatchRepository(db).deleteByProject(row.id);
    new OrchestrationRepository(db).deleteByProject(row.id);
    new SideQuestionRepository(db).deleteByProject(row.id);
    // 项目没了，它的编排运行日志一并清（日志归项目）
    new OrchestrationRunRepository(db).clear('all', row.id);
    const sessions = new SessionRepository(db).removeByProject(row.id);
    purgeProjectPipeline(hooksDir ?? hooksRoot(), row.token);
    projects.remove(row.id);
    return { id: row.id, name: row.name, path: row.path, purged: { events, dispatches, sessions } };
  } finally {
    db.close();
  }
}
