import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { WatchService } from '../watch/watch-service.js';
import { DataBus } from '../daemon/data-bus.js';
import { createWeaveServer } from '../daemon/server.js';

vi.setConfig({ testTimeout: 20000 });

describe('daemon server watch endpoints', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let watch: WatchService;
  let dataBus: DataBus;
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
    dataBus = new DataBus();
    server = createWeaveServer({ projects, port: 0, watch, dataBus });
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
    const res = await fetch(`http://127.0.0.1:${port}/assets`);
    expect(res.status).toBe(400);
  });

  it('GET /assets for an unknown project returns an empty list', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/assets?path=${encodeURIComponent('/nonexistent')}`,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { assets: unknown[] };
    expect(data.assets).toHaveLength(0);
  });

  it('GET /events upgrades to an SSE stream and greets', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('connected');
    await reader.cancel();
  });

  it('数据变更帧走同一条流：带 payload → push，不带 → invalidate', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ': connected' 问候帧（此时订阅已挂上）

    dataBus.emit({ key: 'terminalTopology', payload: { counts: { 1: 2 }, terminals: {} } });
    dataBus.emit({ key: 'assets', projectPath: projectDir });

    let buffer = '';
    while (!buffer.includes('"type":"invalidate"')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
    }
    expect(buffer).toContain('"type":"push"');
    expect(buffer).toContain('"key":"terminalTopology"');
    expect(buffer).toContain('"counts":{"1":2}');
    expect(buffer).toContain('"type":"invalidate"');
    expect(buffer).toContain('"key":"assets"');
    await reader.cancel();
  });

  it('断流重连带 since 回来：只补漏掉的帧；纪元对不上则要求整页重来', async () => {
    const base = `http://127.0.0.1:${port}/events`;
    const decoder = new TextDecoder();
    const readUntil = async (res: Response, marker: string): Promise<string> => {
      const reader = res.body!.getReader();
      let buffer = '';
      while (!buffer.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
      }
      await reader.cancel();
      return buffer;
    };

    const first = await fetch(base);
    const reader = first.body!.getReader();
    await reader.read(); // ': connected'（订阅已挂上）
    dataBus.emit({ key: 'projects' });
    let head = '';
    while (!head.includes('"key":"projects"')) {
      const { value, done } = await reader.read();
      if (done) break;
      head += decoder.decode(value);
    }
    const lastId = /id: (\S+)\ndata: /.exec(head)?.[1];
    expect(lastId).toBeTruthy();
    await reader.cancel(); // 断流

    dataBus.emit({ key: 'settings' }); // 断流期间发生的变更

    const resumed = await fetch(`${base}?since=${encodeURIComponent(lastId!)}`);
    const body = await readUntil(resumed, '"key":"settings"');
    expect(body).toContain('"key":"settings"');
    expect(body).not.toContain('"type":"resync"');

    const stale = await fetch(`${base}?since=deadbeef-1`); // 上一次 daemon 的序号
    expect(await readUntil(stale, '"type":"resync"')).toContain('"type":"resync"');
  });

  it('写操作落定即推 invalidate 帧（写→推的点到点验证）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ': connected'（订阅已挂上）

    const listRes = await fetch(`http://127.0.0.1:${port}/projects`);
    const { projects } = (await listRes.json()) as { projects: Array<{ id: number }> };
    const ordered = await fetch(`http://127.0.0.1:${port}/projects/order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: projects.map((p) => p.id).reverse() }),
    });
    expect(ordered.status).toBe(200);

    let buffer = '';
    while (!buffer.includes('"key":"projects"')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
    }
    expect(buffer).toContain('"type":"invalidate"');
    expect(buffer).toContain('"key":"projects"');
    await reader.cancel();
  });
});
