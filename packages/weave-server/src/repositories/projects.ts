import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

export interface ProjectRow {
  id: number;
  path: string;
  name: string;
  token: string;
  source: 'init' | 'scan';
  registeredAt: string;
  lastSeenAt: string | null;
  meta: string | null;
  /** dashboard 手动拖出的位置（NULL = 未手动排序，列表里垫在已排序块之后）。 */
  sortOrder: number | null;
  /** 归档时间（NULL = 活跃）。归档项目不参与 server 任何消费面，仅保留基础信息待恢复。 */
  archivedAt: string | null;
}

export interface RegisterProjectInput {
  path: string;
  name: string;
  token: string;
  source: 'init' | 'scan';
}

/**
 * 项目注册键：绝对化 + 归一分隔符/尾斜杠，落**原生**形态。`D:/a/b` 与 `D:\a\b`
 * 必须同键——否则 `ON CONFLICT(path)` 认不出、重复登记还会另发 token 把 hook 事件
 * 拐到新行上。刻意保留原生分隔符：项目根要拿去和 payload / 请求里的 file_path 做
 * 包含判断（asset 越界闸、crossProjectOnly），折成 posix 会让那些闸把合法路径判越界。
 */
export function projectKey(path: string): string {
  return resolve(path);
}

export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Register a project. Idempotent on `path`: re-registering refreshes
   * `last_seen_at` but preserves the original token, name, and source.
   * 归档态也一并保留——恢复只能走 dashboard 的归档面，`weave init` 不隐式解档。
   */
  register(input: RegisterProjectInput): ProjectRow {
    const now = new Date().toISOString();
    const key = projectKey(input.path);
    this.db
      .prepare(
        `INSERT INTO projects (path, name, token, source, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(key, input.name, input.token, input.source, now, now);
    return this.getByPath(key)!;
  }

  getByPath(path: string): ProjectRow | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(projectKey(path));
    return row ? toProject(row) : undefined;
  }

  getByToken(token: string): ProjectRow | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE token = ?').get(token);
    return row ? toProject(row) : undefined;
  }

  getById(id: number): ProjectRow | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return row ? toProject(row) : undefined;
  }

  /**
   * 活跃项目（归档排除）。这是所有消费面（watch/mirror/inbox 存活集/同步/
   * 终端角标等）的统一口径——归档项目由 `listArchived()` 单独供「查看归档」面。
   * 排序口径：手动序块在前（sort_order 升序），未手动排序的按注册时间倒序
   * 垫尾——拖过的顺序权威，新注册项目照旧冒头在尾部可见位置。
   */
  list(): ProjectRow[] {
    return this.db
      .prepare(
        'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY sort_order IS NULL, sort_order ASC, registered_at DESC',
      )
      .all()
      .map((row) => toProject(row));
  }

  /** 归档项目（仅基础信息，历史会话已在归档时清空），按归档时间倒序。 */
  listArchived(): ProjectRow[] {
    return this.db
      .prepare('SELECT * FROM projects WHERE archived_at IS NOT NULL ORDER BY archived_at DESC')
      .all()
      .map((row) => toProject(row));
  }

  /**
   * dashboard 拖动排序的持久化：payload 即完整目标顺序（id 全量列表）。
   * 幂等自愈——事务内先全清再按位写入，重复同一 payload 落同一状态；
   * 未知 id（并发删除）静默跳过，缺席的 id 回到未排序块。
   */
  setOrder(ids: number[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('UPDATE projects SET sort_order = NULL');
      const stmt = this.db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
      ids.forEach((id, pos) => {
        stmt.run(pos, id);
      });
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  touch(id: number): void {
    this.db.prepare('UPDATE projects SET last_seen_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      id,
    );
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /**
   * 归档/恢复翻转。归档：置 archived_at、清 sort_order（退出活跃排序局，
   * 恢复后垫在未排序块尾部）。恢复：置 NULL，归档期间各消费面按活跃口径自然回归。
   * 行不存在返回 false。
   */
  setArchived(id: number, archived: boolean): boolean {
    const result = archived
      ? this.db
          .prepare('UPDATE projects SET archived_at = ?, sort_order = NULL WHERE id = ?')
          .run(new Date().toISOString(), id)
      : this.db.prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** 读 meta JSON（缺失/损坏返回 null，调用方按需回退默认值）。 */
  getMeta(id: number): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT meta FROM projects WHERE id = ?').get(id) as
      | { meta?: unknown }
      | undefined;
    if (!row || row.meta == null) return null;
    try {
      const parsed: unknown = JSON.parse(String(row.meta));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /** 浅合并写回 meta JSON（保留未触及的顶层键；批 10 toolkit 状态索引入口）。 */
  setMeta(id: number, patch: Record<string, unknown>): void {
    const merged = { ...(this.getMeta(id) ?? {}), ...patch };
    this.db.prepare('UPDATE projects SET meta = ? WHERE id = ?').run(JSON.stringify(merged), id);
  }
}

function toProject(row: Record<string, unknown>): ProjectRow {
  return {
    id: Number(row.id),
    path: String(row.path),
    name: String(row.name),
    token: String(row.token),
    source: row.source as 'init' | 'scan',
    registeredAt: String(row.registered_at),
    lastSeenAt: row.last_seen_at == null ? null : String(row.last_seen_at),
    meta: row.meta == null ? null : String(row.meta),
    sortOrder: row.sort_order == null ? null : Number(row.sort_order),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
  };
}
