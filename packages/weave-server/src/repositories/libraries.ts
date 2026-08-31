import type { DatabaseSync } from 'node:sqlite';

export interface LibraryRow {
  id: number;
  path: string;
  kind: 'skill' | 'mcp' | 'both';
  addedAt: string;
}

export class LibraryRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Add a library path. Idempotent on `path` (INSERT OR IGNORE). */
  add(input: { path: string; kind: 'skill' | 'mcp' | 'both' }): LibraryRow {
    this.db
      .prepare('INSERT OR IGNORE INTO libraries (path, kind, added_at) VALUES (?, ?, ?)')
      .run(input.path, input.kind, new Date().toISOString());
    return this.getByPath(input.path)!;
  }

  getByPath(path: string): LibraryRow | undefined {
    const row = this.db.prepare('SELECT * FROM libraries WHERE path = ?').get(path);
    return row ? toLibrary(row) : undefined;
  }

  getById(id: number): LibraryRow | undefined {
    const row = this.db.prepare('SELECT * FROM libraries WHERE id = ?').get(id);
    return row ? toLibrary(row) : undefined;
  }

  list(): LibraryRow[] {
    return this.db
      .prepare('SELECT * FROM libraries ORDER BY added_at DESC')
      .all()
      .map((row) => toLibrary(row));
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM libraries WHERE id = ?').run(id);
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
