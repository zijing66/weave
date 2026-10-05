import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { getDataDir } from '../db/paths.js';
import { isInsideDir, resolveLibraryPath, toRelPosix } from '../market/resolve.js';

export interface LibraryRow {
  id: number;
  path: string;
  kind: 'skill' | 'mcp' | 'both';
  addedAt: string;
}

export class LibraryRepository {
  constructor(
    private readonly db: DatabaseSync,
    /** 该库实例绑定的 dataDir（市场路由的 import/refresh 须与读侧同根）。 */
    readonly dataDir: string = getDataDir(),
  ) {}

  /** Add a library path. Idempotent on `path` (INSERT OR IGNORE). */
  add(input: { path: string; kind: 'skill' | 'mcp' | 'both' }): LibraryRow {
    // 批 9（R11）：dataDir 内的绝对路径以相对 posix 形入库（与读侧惰性改写同向，
    // 两种写法幂等）；dataDir 外的 legacy 绝对路径原样入库（POST /libraries 原行为）。
    const existing = this.getByPath(input.path);
    if (existing) return existing;
    this.db
      .prepare('INSERT OR IGNORE INTO libraries (path, kind, added_at) VALUES (?, ?, ?)')
      .run(this.writeForm(input.path), input.kind, new Date().toISOString());
    return this.getByPath(input.path)!;
  }

  getByPath(path: string): LibraryRow | undefined {
    for (const key of new Set([path, this.writeForm(path)])) {
      const row = this.db.prepare('SELECT * FROM libraries WHERE path = ?').get(key);
      if (row) return this.resolveRow(toLibrary(row));
    }
    return undefined;
  }

  getById(id: number): LibraryRow | undefined {
    const row = this.db.prepare('SELECT * FROM libraries WHERE id = ?').get(id);
    return row ? this.resolveRow(toLibrary(row)) : undefined;
  }

  list(): LibraryRow[] {
    return this.db
      .prepare('SELECT * FROM libraries ORDER BY added_at DESC')
      .all()
      .map((row) => this.resolveRow(toLibrary(row)));
  }

  /** 改写存储 path（迁入市场时把 legacy 外部源换成相对形）。 */
  setPath(id: number, nextPath: string): void {
    this.db.prepare('UPDATE libraries SET path = ? WHERE id = ?').run(this.writeForm(nextPath), id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
  }

  /** 绝对且在 dataDir 内 → 相对 posix 形；其余原样（legacy 外部绝对路径不动）。 */
  private writeForm(p: string): string {
    if (!path.isAbsolute(p)) return p;
    return isInsideDir(p, this.dataDir) ? toRelPosix(p, this.dataDir) : p;
  }

  /**
   * 读侧 resolve 单点（批 9，R11）：返回值一律是可直接使用的绝对路径；
   * 存储形为 dataDir 内绝对路径的旧行在此惰性 UPDATE 为相对形（仅 dataDir 内）。
   */
  private resolveRow(row: LibraryRow): LibraryRow {
    if (!path.isAbsolute(row.path)) {
      return { ...row, path: resolveLibraryPath(row, this.dataDir) };
    }
    const abs = path.resolve(row.path);
    if (isInsideDir(abs, this.dataDir)) {
      this.db
        .prepare('UPDATE libraries SET path = ? WHERE id = ?')
        .run(toRelPosix(abs, this.dataDir), row.id);
      return { ...row, path: abs };
    }
    return row;
  }
}

function toLibrary(row: Record<string, unknown>): LibraryRow {
  return {
    id: Number(row.id),
    path: String(row.path),
    kind: row.kind as 'skill' | 'mcp' | 'both',
    addedAt: String(row.added_at),
  };
}
