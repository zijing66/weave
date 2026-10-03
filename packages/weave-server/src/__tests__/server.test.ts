import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';
import type { DatabaseSync } from 'node:sqlite';

const TOKEN = 'daemon-token';

describe('daemon server', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let brokenDir: string;
  let brokenId: number;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projects.register({ path: '/test', name: 'test', token: 'ptoken', source: 'init' });
    // 批 8：一个健康检查必然失败的项目（两个独立指令文件）
    brokenDir = await mkdtemp(path.join(os.tmpdir(), 'weave-hc-'));
    await writeFile(path.join(brokenDir, 'CLAUDE.md'), '# Project\n');
    await writeFile(path.join(brokenDir, 'AGENTS.md'), '# Project\n');
    brokenId = projects.register({ path: brokenDir, name: 'broken', token: 'btoken', source: 'scan' })
      .id;
    server = createWeaveServer({ projects, daemonToken: TOKEN, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    db.close();
    await rm(brokenDir, { recursive: true, force: true });
  });

  it('GET /health is unauthenticated', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { service: string };
    expect(data.service).toBe('weave-daemon');
  });

  it('GET /projects rejects a missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects`);
    expect(res.status).toBe(401);
  });

  it('GET /projects with a valid token returns projects', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { projects: Array<{ path: string }> };
    expect(data.projects.map((p) => p.path)).toContain('/test');
  });

  it('unknown routes return 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('GET /assets returns 503 without a watch service', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets?path=/test`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
  });

  it('GET /assets requires a path query', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });

  it('GET /events returns 503 without a watch service', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
  });

  // --- 批 8：GET /projects/:id/harness-checks（只读健康端点） ---

  it('GET harness-checks rejects a missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/${brokenId}/harness-checks`);
    expect(res.status).toBe(401);
  });

  it('GET harness-checks returns structured check results', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/${brokenId}/harness-checks`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      checks: Array<{ id: string; params: Record<string, unknown>; ok: boolean }>;
    };
    expect(Array.isArray(data.checks)).toBe(true);
    const failed = data.checks.filter((c) => !c.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.map((c) => c.id)).toContain('instruction-files-duplicated');
    const dup = failed.find((c) => c.id === 'instruction-files-duplicated')!;
    expect(dup.params.claude).toBe('CLAUDE.md');
    expect(dup.params.agents).toBe('AGENTS.md');
    // 结构化契约：只回 id/params/ok，不带任何文案字段
    for (const c of data.checks) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.ok).toBe('boolean');
      expect(c.params).toBeTypeOf('object');
      expect(c).not.toHaveProperty('message');
      expect(c).not.toHaveProperty('fix');
    }
  });

  it('GET harness-checks 404s for an unknown project', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/9999/harness-checks`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('POST harness-checks is not allowed', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/${brokenId}/harness-checks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});
