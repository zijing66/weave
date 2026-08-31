import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { LibraryRepository } from '../repositories/libraries.js';
import { createWeaveServer } from '../daemon/server.js';

const DAEMON_TOKEN = 'daemon-token';
const PROJECT_TOKEN = 'ptoken';

describe('daemon server — /updates', () => {
  let server: Server;
  let db: DatabaseSync;
  let port: number;
  let projectDir: string;
  let libDir: string;
  let projectId: number;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const libraries = new LibraryRepository(db);
    projectDir = mkdtempSync(join(tmpdir(), 'weave-upd-proj-'));
    libDir = mkdtempSync(join(tmpdir(), 'weave-upd-lib-'));

    // library source: skill "foo"
    mkdirSync(join(libDir, 'foo'), { recursive: true });
    writeFileSync(join(libDir, 'foo', 'SKILL.md'), '# Foo\n\nbody');
    libraries.add({ path: libDir, kind: 'skill' });

    // project: install foo by copying from library (simulate install)
    mkdirSync(join(projectDir, '.claude/skills/foo'), { recursive: true });
    cpSync(join(libDir, 'foo'), join(projectDir, '.claude/skills/foo'), { recursive: true });

    // project: also a hand-authored skill "custom" (no library source)
    mkdirSync(join(projectDir, '.claude/skills/custom'), { recursive: true });
    writeFileSync(join(projectDir, '.claude/skills/custom/SKILL.md'), '# custom');

    const row = projects.register({
      path: projectDir,
      name: 'proj',
      token: PROJECT_TOKEN,
      source: 'init',
    });
    projectId = row.id;

    server = createWeaveServer({ projects, daemonToken: DAEMON_TOKEN, port: 0, libraries });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(libDir, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${DAEMON_TOKEN}` };
  const base = () => `http://127.0.0.1:${port}`;

  it('reports up-to-date installed skill as not outdated', async () => {
    const res = await fetch(`${base()}/api/projects/${projectId}/updates`, { headers: auth });
    expect(res.status).toBe(200);
    const data = await res.json();
    const foo = data.skills.find((s: { name: string }) => s.name === 'foo');
    expect(foo).toBeDefined();
    expect(foo.outdated).toBe(false);
    expect(foo.custom).toBe(false);
    expect(data.available).toBe(0);
  });

  it('reports custom skill (no source) as custom, not outdated', async () => {
    const res = await fetch(`${base()}/api/projects/${projectId}/updates`, { headers: auth });
    const data = await res.json();
    const custom = data.skills.find((s: { name: string }) => s.name === 'custom');
    expect(custom).toBeDefined();
    expect(custom.custom).toBe(true);
    expect(custom.outdated).toBe(false);
  });

  it('reports outdated after source changes', async () => {
    // mutate the library source
    writeFileSync(join(libDir, 'foo', 'SKILL.md'), '# Foo v2\n\nchanged body');
    const res = await fetch(`${base()}/api/projects/${projectId}/updates`, { headers: auth });
    const data = await res.json();
    const foo = data.skills.find((s: { name: string }) => s.name === 'foo');
    expect(foo.outdated).toBe(true);
    expect(data.available).toBeGreaterThanOrEqual(1);
  });

  it('requires the daemon token', async () => {
    const res = await fetch(`${base()}/api/projects/${projectId}/updates`);
    expect(res.status).toBe(401);
  });

  it('404 for unknown project', async () => {
    const res = await fetch(`${base()}/api/projects/9999/updates`, { headers: auth });
    expect(res.status).toBe(404);
  });
});
