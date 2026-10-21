import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { ClaudeCodeAdapter } from '../hooks/adapter.js';
import { createWeaveServer } from '../daemon/server.js';

const PROJECT_TOKEN = 'ptoken';

describe('daemon server — /api prefix, hooks listing, static hosting', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let staticDir: string;
  let projectId: number;
  let hookEvents: HookEventRepository;

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

    hookEvents = new HookEventRepository(db);
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
    rmSync(staticDir, { recursive: true, force: true });
  });

  it('strips the /api prefix so /api/projects works like /projects', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { projects: Array<{ path: string }> };
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0].path).toBe(resolve('/proj'));
  });

  it('GET /api/projects/:id/hooks lists hook events for the task view', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/hooks`);
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

  it('GET /api/projects/:id/hooks honors a limit query param', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/projects/${projectId}/hooks?limit=1`,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { events: unknown[] };
    expect(data.events).toHaveLength(1);
  });

  it('GET /projects/:id/hooks?sessionId= 按会话过滤（任务视图事件链），projectId 仅作鉴权锚点', async () => {
    // s2 的事件带不同 projectId 语义也应返回——sessionId-only 过滤
    hookEvents.insert({
      projectId,
      source: 'claude',
      eventType: 'Stop',
      sessionId: 's2',
      payload: '{}',
    });

    const s1 = await fetch(
      `http://127.0.0.1:${port}/projects/${projectId}/hooks?sessionId=s1`,
    );
    const s1Data = (await s1.json()) as { events: Array<{ sessionId: string; eventType: string }> };
    expect(s1Data.events).toHaveLength(2);
    expect(s1Data.events.every((e) => e.sessionId === 's1')).toBe(true);
    // 时间升序（事件链保序）
    expect(s1Data.events.map((e) => e.eventType)).toEqual(['PostToolUse', 'PreToolUse']);

    const s2 = await fetch(
      `http://127.0.0.1:${port}/projects/${projectId}/hooks?sessionId=s2`,
    );
    const s2Data = (await s2.json()) as { events: Array<{ eventType: string }> };
    expect(s2Data.events).toHaveLength(1);
    expect(s2Data.events[0]!.eventType).toBe('Stop');

    const missing = await fetch(
      `http://127.0.0.1:${port}/projects/${projectId}/hooks?sessionId=nope`,
    );
    expect(((await missing.json()) as { events: unknown[] }).events).toHaveLength(0);
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
