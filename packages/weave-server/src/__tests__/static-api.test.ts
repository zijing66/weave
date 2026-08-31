import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { ClaudeCodeAdapter } from '../hooks/adapter.js';
import { createWeaveServer } from '../daemon/server.js';

const DAEMON_TOKEN = 'daemon-token';
const PROJECT_TOKEN = 'ptoken';

describe('daemon server — /api prefix, hooks listing, static hosting', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let staticDir: string;
  let projectId: number;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const row = projects.register({
      path: '/proj',
      name: 'test',
      token: PROJECT_TOKEN,
      source: 'init',
    });
    projectId = row.id;

    const hookEvents = new HookEventRepository(db);
    hookEvents.insert({
      projectId,
      source: 'claude',
      eventType: 'PostToolUse',
      sessionId: 's1',
      payload: '{}',
    });
    hookEvents.insert({
      projectId,
      source: 'claude',
      eventType: 'PreToolUse',
      sessionId: 's1',
      payload: '{}',
    });

    staticDir = mkdtempSync(join(tmpdir(), 'weave-static-'));
    writeFileSync(
      join(staticDir, 'index.html'),
      '<!doctype html><html><body>weave</body></html>',
    );
    mkdirSync(join(staticDir, 'assets'));
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log("app");');

    server = createWeaveServer({
      projects,
      daemonToken: DAEMON_TOKEN,
      port: 0,
      hookEvents,
      adapters: [new ClaudeCodeAdapter()],
      staticDir,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  it('strips the /api prefix so /api/projects works like /projects', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      headers: { authorization: `Bearer ${DAEMON_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { projects: Array<{ path: string }> };
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].path).toBe('/proj');
  });

  it('GET /api/projects/:id/hooks lists hook events for the task view', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/projects/${projectId}/hooks`,
      { headers: { authorization: `Bearer ${DAEMON_TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      events: Array<{ eventType: string; sessionId: string }>;
    };
    expect(data.events).toHaveLength(2);
    expect(data.events.map((e) => e.eventType).sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
    ]);
    expect(data.events.every((e) => e.sessionId === 's1')).toBe(true);
  });

  it('GET /api/projects/:id/hooks requires the daemon token', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/projects/${projectId}/hooks`,
    );
    expect(res.status).toBe(401);
  });

  it('GET /api/projects/:id/hooks honors a limit query param', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/projects/${projectId}/hooks?limit=1`,
      { headers: { authorization: `Bearer ${DAEMON_TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { events: unknown[] };
    expect(data.events).toHaveLength(1);
  });

  it('serves index.html at the root (SPA entrypoint)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('weave');
  });

  it('serves a known static asset with the right mime type', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('console.log');
  });

  it('falls back to index.html for unknown non-api routes (SPA)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/some/spa/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('weave');
  });
});
