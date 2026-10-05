import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { createClaudePluginSurface, type PluginExecutor } from '@weave/harness';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { PluginStateRepository } from '../repositories/plugin-states.js';
import { createWeaveServer } from '../daemon/server.js';
import { ToolkitService } from '../hooks/toolkit.js';

/**
 * 批 10 HTTP 面：GET /projects/:id/toolkit（清单+启用态+旧副本）、
 * POST .../enable|disable（幂等、后置状态、404/400）、/toolkit/dirs 注册与移除、
 * POST .../legacy-copies/cleanup（批 3 幂等清理）。
 * 路由范式同 /hooks/plugins；无 toolkit 依赖时 503。
 * CC 原生包 enable 走注入的假 CLI surface（home mock 到临时目录），不 spawn claude。
 */

const TOKEN = 'daemon-token';
const BUILTIN_ROOT = fileURLToPath(new URL('../hooks/presets/harness-tools/', import.meta.url));

/** 假 CLI：install 时模拟 CC 写 installed_plugins.json，其余步骤空成功。 */
const makeFakeExec = (home: string): PluginExecutor => async (args) => {
  if (args[1] === 'install') {
    const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    let json: { version: number; plugins: Record<string, unknown[]> } = {
      version: 2,
      plugins: {},
    };
    try {
      json = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      // 首装：从空注册源开始
    }
    json.plugins[args[2]!] = [
      {
        scope: 'user',
        installPath: path.join(home, '.claude', 'plugins', 'cache', args[2]!),
        version: '0.1.0',
      },
    ];
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(json, null, 2));
  }
  return { stdout: '', stderr: '' };
};

describe('daemon /toolkit routes', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projectId: number;
  let base: string;

  const auth = { authorization: `Bearer ${TOKEN}` };

  const makeService = (claudeVersion: () => Promise<string | null>): ToolkitService => {
    const projects = new ProjectRepository(db);
    const states = new PluginStateRepository(db);
    return new ToolkitService({
      projects,
      states,
      builtinRoot: BUILTIN_ROOT,
      sourcesRoot: path.join(base, 'cfg'),
      claudeVersion,
      pluginSurface: createClaudePluginSurface({ exec: makeFakeExec(base) }),
      plugins: { list: () => [], setPluginEnabled: () => true },
    });
  };

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'weave-tk-http-'));
    process.env.HOME = base;
    process.env.USERPROFILE = base;
    const projectDir = path.join(base, 'proj');
    await mkdir(projectDir, { recursive: true });
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectId = projects.register({ path: projectDir, name: 'tk', token: 'tkn', source: 'init' }).id;
    server = createWeaveServer({
      projects,
      daemonToken: TOKEN,
      port: 0,
      toolkit: makeService(async () => '2.1.288'),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    db.close();
    await rm(base, { recursive: true, force: true });
  });

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;

  it('未鉴权 401', async () => {
    const res = await fetch(url(`/projects/${projectId}/toolkit`));
    expect(res.status).toBe(401);
  });

  it('GET /projects/:id/toolkit 返回包清单 + 启用态 + 空外置目录', async () => {
    const res = await fetch(url(`/projects/${projectId}/toolkit`), { headers: auth });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      packs: Array<{ id: string; enabled: boolean; installed: boolean; provenance: string; kind: string }>;
      dirs: string[];
    };
    expect(data.packs.map((p) => p.id).sort()).toEqual([
      'code-review',
      'docs-reminder',
      'file-guard',
      'md-lint',
      'mission-control',
      'project-navigation',
      'refactoring',
      'testing',
    ]);
    expect(data.packs.every((p) => p.provenance === 'builtin')).toBe(true);
    expect(data.packs.every((p) => p.enabled === false)).toBe(true);
    // installed 字段恒在（CC/mod=全局安装态、表面包=落盘记录、weave=装载即源）
    expect(data.packs.every((p) => typeof p.installed === 'boolean')).toBe(true);
    expect(data.packs.find((p) => p.id === 'code-review')!.installed).toBe(false);
    expect(data.packs.find((p) => p.id === 'md-lint')!.installed).toBe(true); // weave 装载即源
    expect(data.dirs).toEqual([]);
  });

  it('GET 未知项目 404', async () => {
    const res = await fetch(url('/projects/99999/toolkit'), { headers: auth });
    expect(res.status).toBe(404);
  });

  it('POST enable→disable：幂等、返回后置状态', async () => {
    const enable = async (): Promise<{ pack: { enabled: boolean; installed: boolean }; warnings: string[] }> => {
      const res = await fetch(url(`/projects/${projectId}/toolkit/docs-reminder/enable`), {
        method: 'POST',
        headers: auth,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { pack: { enabled: boolean; installed: boolean }; warnings: string[] };
    };
    const first = await enable();
    expect(first.pack.enabled).toBe(true);
    expect(first.pack.installed).toBe(true); // enable = 首装（假 CLI 写注册表）
    const second = await enable(); // 幂等：无副作用
    expect(second.pack.enabled).toBe(true);

    const disable = async (): Promise<{ pack: { enabled: boolean; installed: boolean } }> => {
      const res = await fetch(url(`/projects/${projectId}/toolkit/docs-reminder/disable`), {
        method: 'POST',
        headers: auth,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { pack: { enabled: boolean; installed: boolean } };
    };
    expect((await disable()).pack.enabled).toBe(false);
    expect((await disable()).pack.installed).toBe(true); // 停用保留 harness 全局安装
    expect((await disable()).pack.enabled).toBe(false); // 幂等
  });

  it('POST uninstall：200 返回后置状态；未知包 404；未鉴权 401', async () => {
    const res = await fetch(url(`/projects/${projectId}/toolkit/docs-reminder/uninstall`), {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { pack: { enabled: boolean } };
    expect(data.pack.enabled).toBe(false);

    const notFound = await fetch(url(`/projects/${projectId}/toolkit/no-such-pack/uninstall`), {
      method: 'POST',
      headers: auth,
    });
    expect(notFound.status).toBe(404);

    const unauth = await fetch(url(`/projects/${projectId}/toolkit/docs-reminder/uninstall`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(unauth.status).toBe(401);
  });

  it('POST 未知包 404；GET on enable 路径 405', async () => {
    const res = await fetch(url(`/projects/${projectId}/toolkit/no-such-pack/enable`), {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).toBe(404);
    const bad = await fetch(url(`/projects/${projectId}/toolkit/docs-reminder/enable`), {
      headers: auth,
    });
    expect(bad.status).toBe(405);
  });

  it('未知路由返回 false → 主链 404', async () => {
    const res = await fetch(url('/toolkit/nope'), { headers: auth });
    expect(res.status).toBe(404);
  });

  it('/toolkit/dirs 注册与移除', async () => {
    const dir = path.join(base, 'ext');
    await mkdir(dir, { recursive: true });

    const add = await fetch(url('/toolkit/dirs'), {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    expect(add.status).toBe(201);
    expect(((await add.json()) as { dirs: string[] }).dirs).toContain(path.resolve(dir));

    const list = await fetch(url('/toolkit/dirs'), { headers: auth });
    expect(((await list.json()) as { dirs: string[] }).dirs).toContain(path.resolve(dir));

    const remove = await fetch(url('/toolkit/dirs/remove'), {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    expect(remove.status).toBe(200);
    expect(((await remove.json()) as { dirs: string[] }).dirs).not.toContain(path.resolve(dir));
  });

  it('add-dir 指向不存在目录 → 400', async () => {
    const res = await fetch(url('/toolkit/dirs'), {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(base, 'missing-dir') }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/目录不存在/);
  });

  it('legacy-copies：list 报出项目插件位旧副本，POST cleanup 幂等清理', async () => {
    const stale = path.join(base, 'proj', '.claude', 'plugins', 'stale-copy', 'x.txt');
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(stale, 'legacy');

    const list = async (): Promise<{ legacyCopies: string[] }> =>
      (await (await fetch(url(`/projects/${projectId}/toolkit`), { headers: auth })).json()) as {
        legacyCopies: string[];
      };
    expect((await list()).legacyCopies).toEqual(['.claude/plugins/stale-copy']);

    const cleanup = async (): Promise<{ removed: string[] }> =>
      (await (
        await fetch(url(`/projects/${projectId}/toolkit/legacy-copies/cleanup`), {
          method: 'POST',
          headers: auth,
        })
      ).json()) as { removed: string[] };
    expect(await cleanup()).toEqual({ removed: ['.claude/plugins/stale-copy'] });
    expect(await cleanup()).toEqual({ removed: [] }); // 幂等
    expect((await list()).legacyCopies).toEqual([]);

    const getOnCleanup = await fetch(url(`/projects/${projectId}/toolkit/legacy-copies/cleanup`), {
      headers: auth,
    });
    expect(getOnCleanup.status).toBe(405);
  });
});

describe('daemon /toolkit mod 版本闸（低版本不落盘）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projectId: number;
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'weave-tk-http-low-'));
    const projectDir = path.join(base, 'proj');
    await mkdir(projectDir, { recursive: true });
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectId = projects.register({ path: projectDir, name: 'tk', token: 'tkn', source: 'init' }).id;
    server = createWeaveServer({
      projects,
      daemonToken: TOKEN,
      port: 0,
      toolkit: new ToolkitService({
        projects,
        states: new PluginStateRepository(db),
        builtinRoot: BUILTIN_ROOT,
        sourcesRoot: path.join(base, 'cfg'),
        claudeVersion: async () => '2.1.100',
        plugins: { list: () => [], setPluginEnabled: () => true },
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    db.close();
    await rm(base, { recursive: true, force: true });
  });

  it('低版本 enable mod → 400 code=host-version', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/${projectId}/toolkit/mission-control/enable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('host-version');
    expect(body.error).toMatch(/2\.1\.100/);
  });
});

describe('daemon /toolkit 无依赖降级', () => {
  let server: Server;
  let port: number;
  let db: DatabaseSync;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projects.register({ path: '/x', name: 'x', token: 'x', source: 'init' });
    server = createWeaveServer({ projects, daemonToken: TOKEN, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  it('toolkit 缺席 → 503', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/toolkit/dirs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
  });
});
