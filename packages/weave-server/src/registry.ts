import { basename, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openDatabase } from './db/db.js';
import { ProjectRepository } from './repositories/projects.js';
import { generateToken } from './daemon/auth.js';

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
