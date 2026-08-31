import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { WatchService } from '../watch/watch-service.js';
import { createWeaveServer } from '../daemon/server.js';

vi.setConfig({ testTimeout: 20000 });

const TOKEN = 'daemon-token';

describe('daemon server watch endpoints', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let watch: WatchService;
  let projectDir: string;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectDir = mkdtempSync(path.join(tmpdir(), 'weave-watch-srv-'));
    mkdirSync(path.join(projectDir, '.claude', 'skills', 'foo'), { recursive: true });
    writeFileSync(path.join(projectDir, '.claude', 'skills', 'foo', 'SKILL.md'), '# Foo');
    writeFileSync(path.join(projectDir, '.mcp.json'), '{}');
    projects.register({ path: projectDir, name: 'test', token: 'ptoken', source: 'init' });

    watch = new WatchService(projects, { debounceMs: 30, reconcileMs: 60_000 });
    watch.start();
    server = createWeaveServer({ projects, daemonToken: TOKEN, port: 0, watch });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    // Wait for the initial scan to populate the cache before querying.
    await vi.waitFor(() => expect(watch.getAssets(projectDir).length).toBeGreaterThanOrEqual(2), {
      timeout: 5000,
    });
  });

  afterAll(() => {
    watch.stop();
    server.close();
    db.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('GET /assets returns cached entries for a project', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/assets?path=${encodeURIComponent(projectDir)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      projectPath: string;
      assets: Array<{ category: string; relPath: string }>;
    };
    expect(data.projectPath).toBe(projectDir);
    expect(data.assets.some((a) => a.relPath === '.mcp.json' && a.category === 'mcp')).toBe(true);
    expect(
      data.assets.some((a) => a.relPath === '.claude/skills/foo/SKILL.md' && a.category === 'skill'),
    ).toBe(true);
  });

  it('GET /assets requires a path query', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });

  it('GET /assets for an unknown project returns an empty list', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/assets?path=${encodeURIComponent('/nonexistent')}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { assets: unknown[] };
    expect(data.assets).toHaveLength(0);
  });

  it('GET /events rejects a missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    expect(res.status).toBe(401);
  });

  it('GET /events upgrades to an SSE stream and greets', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('connected');
    await reader.cancel();
  });
});
