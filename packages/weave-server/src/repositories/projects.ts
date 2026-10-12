import type { DatabaseSync } from 'node:sqlite';

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
}

export interface RegisterProjectInput {
  path: string;
  name: string;
  token: string;
  source: 'init' | 'scan';
}

export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Register a project. Idempotent on `path`: re-registering refreshes
   * `last_seen_at` but preserves the original token, name, and source.
   */
  register(input: RegisterProjectInput): ProjectRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (path, name, token, source, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(input.path, input.name, input.token, input.source, now, now);
    return this.getByPath(input.path)!;
  }

  getByPath(path: string): ProjectRow | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path);
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

  list(): ProjectRow[] {
    // 排序口径：手动序块在前（sort_order 升序），未手动排序的按注册时间倒序
    // 垫尾——拖过的顺序权威，新注册项目照旧冒头在尾部可见位置。
    return this.db
      .prepare(
        'SELECT * FROM projects ORDER BY sort_order IS NULL, sort_order ASC, registered_at DESC',
      )
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
  };
}
