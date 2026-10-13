import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';

/**
 * 路由面：GET/PUT /projects/:id/plugins/state（工具对象模型——PluginEnabledMap
 * 的替换面）。HOME 隔离控 claude/codex 的 user 档文件，项目档用注册的临时项目。
 */
let db: DatabaseSync;
let server: Server;
let port: number;
let projectId: number;
let projectDir: string;
let fakeHome: string;
let origHome: string | undefined;
let origProfile: string | undefined;

beforeAll(async () => {
  origHome = process.env.HOME;
  origProfile = process.env.USERPROFILE;
  fakeHome = mkdtempSync(join(tmpdir(), 'weave-plugstate-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'weave-plugstate-proj-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  writeFileSync(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'a@weave': true } }),
  );
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(
    join(projectDir, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'b@weave': false } }),
  );

  db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  const row = projects.register({ path: projectDir, name: 'p', token: 't', source: 'init' });
  projectId = row.id;
  server = createWeaveServer({ projects, port: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
  db.close();
  process.env.HOME = origHome;
  process.env.USERPROFILE = origProfile;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const url = (p: string): string => `http://127.0.0.1:${port}/api${p}`;

const put = (body: unknown): Promise<Response> =>
  fetch(url(`/projects/${projectId}/plugins/state`), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('daemon /projects/:id/plugins/state', () => {
  it('GET 出行：a@weave 三档行（user on，链无覆写全 inherit）', async () => {
    const res = await fetch(url(`/projects/${projectId}/plugins/state`));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      rows: Array<{ key: string; scope: string; enable: string; effective: boolean }>;
    };
    const a = data.rows.find((r) => r.key === 'a@weave');
    expect(a).toMatchObject({ scope: 'user', enable: 'on', effective: true });
    expect(data.rows.filter((r) => r.key === 'a@weave')).toHaveLength(3);
    const b = data.rows.find((r) => r.key === 'b@weave' && r.scope === 'project');
    expect(b).toMatchObject({ enable: 'off', effective: false });
  });

  it('PUT claude：user 档 off 落盘；local 档 on 建文件且压过 user', async () => {
    const res = await put({ runtime: 'claude', key: 'a@weave', scope: 'user', state: 'off' });
    expect(res.status).toBe(200);
    const settings = JSON.parse(
      await readFile(join(fakeHome, '.claude', 'settings.json'), 'utf8'),
    ) as { enabledPlugins: Record<string, boolean> };
    expect(settings.enabledPlugins['a@weave']).toBe(false);

    const local = await put({ runtime: 'claude', key: 'a@weave', scope: 'local', state: 'on' });
    expect(local.status).toBe(200);
    const localJson = JSON.parse(
      await readFile(join(projectDir, '.claude', 'settings.local.json'), 'utf8'),
    ) as { enabledPlugins: Record<string, boolean> };
    expect(localJson.enabledPlugins['a@weave']).toBe(true);
    const data = (await (await fetch(url(`/projects/${projectId}/plugins/state`))).json()) as {
      rows: Array<{ key: string; scope: string; effective: boolean }>;
    };
    expect(
      data.rows.find((r) => r.key === 'a@weave' && r.scope === 'local')?.effective,
    ).toBe(true);
  });

  it('PUT inherit = 删档位键（回落下一档）', async () => {
    const res = await put({ runtime: 'claude', key: 'b@weave', scope: 'project', state: 'inherit' });
    expect(res.status).toBe(200);
    const settings = JSON.parse(
      await readFile(join(projectDir, '.claude', 'settings.json'), 'utf8'),
    ) as { enabledPlugins: Record<string, boolean> };
    expect(settings.enabledPlugins['b@weave']).toBeUndefined();
  });

  it('PUT codex（仅启用面）：user on/off 可写，inherit / 非 user 档 400', async () => {
    const on = await put({ runtime: 'codex', key: 'cx@weave', scope: 'user', state: 'on' });
    expect(on.status).toBe(200);
    const toml = await readFile(join(fakeHome, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('[plugins."cx@weave"]');

    const inherit = await put({ runtime: 'codex', key: 'cx@weave', scope: 'user', state: 'inherit' });
    expect(inherit.status).toBe(400);
    const projectScope = await put({ runtime: 'codex', key: 'cx@weave', scope: 'project', state: 'on' });
    expect(projectScope.status).toBe(400);
  });

  it('PUT 参数校验：非法 scope/state → 400', async () => {
    expect((await put({ runtime: 'claude', key: 'a@weave', scope: 'team', state: 'on' })).status).toBe(400);
    expect((await put({ runtime: 'claude', key: 'a@weave', scope: 'user', state: 'enabled' })).status).toBe(400);
  });

  it('GET 未知项目 404', async () => {
    const res = await fetch(url('/projects/9999/plugins/state'));
    expect(res.status).toBe(404);
  });
});
