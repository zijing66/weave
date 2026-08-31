import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { LibraryRepository } from '../repositories/libraries.js';
import { createWeaveServer } from '../daemon/server.js';

const DAEMON_TOKEN = 'daemon-token';
const PROJECT_TOKEN = 'ptoken';

describe('daemon server — libraries + install/uninstall', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projectId: number;
  let projectDir: string;
  let libDir: string;
  let libId: number;
  let skillDir: string;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectDir = mkdtempSync(join(tmpdir(), 'weave-install-proj-'));
    const row = projects.register({
      path: projectDir,
      name: 'proj',
      token: PROJECT_TOKEN,
      source: 'init',
    });
    projectId = row.id;

    const libraries = new LibraryRepository(db);
    libDir = mkdtempSync(join(tmpdir(), 'weave-install-lib-'));
    skillDir = join(libDir, 'src-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# src');
    const lib = libraries.add({ path: libDir, kind: 'skill' });
    libId = lib.id;

    server = createWeaveServer({
      projects,
      daemonToken: DAEMON_TOKEN,
      port: 0,
      libraries,
    });
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

  it('GET /libraries returns the registered library', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/libraries`, { headers: auth });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { libraries: Array<{ path: string }> };
    expect(data.libraries).toHaveLength(1);
    expect(data.libraries[0].path).toBe(libDir);
  });

  it('GET /libraries/:id/assets scans skills', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/libraries/${libId}/assets`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { skills: Array<{ name: string }> };
    expect(data.skills.map((s) => s.name)).toEqual(['src-skill']);
  });

  it('POST /projects/:id/install skill copies files into the project', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/install`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'skill', name: 'src', sourceDir: skillDir }),
    });
    expect(res.status).toBe(201);
    expect(existsSync(join(projectDir, '.claude', 'skills', 'src', 'SKILL.md'))).toBe(true);
  });

  it('install skill returns 409 on conflict', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/install`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'skill', name: 'src', sourceDir: skillDir }),
    });
    expect(res.status).toBe(409);
  });

  it('uninstall skill returns 200 then 404', async () => {
    const ok = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/uninstall`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'skill', name: 'src' }),
    });
    expect(ok.status).toBe(200);
    expect(existsSync(join(projectDir, '.claude', 'skills', 'src'))).toBe(false);

    const missing = await fetch(
      `http://127.0.0.1:${port}/api/projects/${projectId}/uninstall`,
      {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'skill', name: 'src' }),
      },
    );
    expect(missing.status).toBe(404);
  });

  it('POST /projects/:id/install mcp adds a .mcp.json entry', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/install`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        category: 'mcp',
        name: 'demo',
        mcpConfig: { command: 'node', args: ['svr.js'] },
      }),
    });
    expect(res.status).toBe(201);
  });

  it('install requires the daemon token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'skill', name: 'x', sourceDir: skillDir }),
    });
    expect(res.status).toBe(401);
  });

  it('install on an unknown project returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/9999/install`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'skill', name: 'x', sourceDir: skillDir }),
    });
    expect(res.status).toBe(404);
  });
});
