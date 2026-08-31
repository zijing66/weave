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
    return this.db
      .prepare('SELECT * FROM projects ORDER BY registered_at DESC')
      .all()
      .map((row) => toProject(row));
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
  };
}
