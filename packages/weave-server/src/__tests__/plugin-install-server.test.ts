import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudePluginSurface, type PluginExecutor } from '@weavecode/harness';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';

/**
 * 路由面：POST /projects/:id/install 的 plugin 类别（user 档安装管理面，拍板
 * 7-6 方案 A）。HOME/APPDATA 全指向临时根 → dataDir = <root>/weave（市场根判据
 * 同源）；CLI 经 deps.pluginSurface 注入假执行器（两步链不真跑）。
 */
let db: DatabaseSync;
let server: Server;
let port: number;
let projectId: number;
let projectDir: string;
let base: string;
const envBak: Record<string, string | undefined> = {};
let execCalls: string[][] = [];
let marketPackDir: string;

const fakeExec: PluginExecutor = async (args) => {
  execCalls.push(args);
  // 模拟 claude plugin install 落 installed_plugins.json（真实 CLI 行为）
  if (args[1] === 'install') {
    const key = args[2]!;
    const file = join(base, '.claude', 'plugins', 'installed_plugins.json');
    let json: { plugins: Record<string, unknown[]> } = { plugins: {} };
    try {
      json = JSON.parse(await readFile(file, 'utf8')) as typeof json;
    } catch {
      /* 未装本就无文件 */
    }
    json.plugins[key] = [
      { scope: 'user', installPath: join(base, '.claude', 'plugins', 'cache', key), version: '0.1.0' },
    ];
    mkdirSync(join(base, '.claude', 'plugins'), { recursive: true });
    writeFileSync(file, JSON.stringify(json, null, 2));
  }
  return { stdout: '', stderr: '' };
};

beforeAll(async () => {
  for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME']) {
    envBak[k] = process.env[k];
  }
  base = mkdtempSync(join(tmpdir(), 'weave-pluginst-home-'));
  // dataDir 落 base/weave → 市场根 = base/weave/market（marketIdOf 判据同源）
  process.env.HOME = base;
  process.env.USERPROFILE = base;
  process.env.APPDATA = base;
  process.env.XDG_CONFIG_HOME = base;

  // 外部市场包：<dataDir>/market/ext-mkt/plugins/pack-a（带 CC manifest）
  marketPackDir = join(base, 'weave', 'market', 'ext-mkt', 'plugins', 'pack-a');
  mkdirSync(join(marketPackDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(marketPackDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'pack-a', version: '1.0.0' }),
  );

  projectDir = mkdtempSync(join(tmpdir(), 'weave-pluginst-proj-'));

  db = openDatabase(':memory:');
  const projects = new ProjectRepository(db);
  const row = projects.register({ path: projectDir, name: 'p', token: 't', source: 'init' });
  projectId = row.id;
  server = createWeaveServer({
    projects,
    port: 0,
    pluginSurface: createClaudePluginSurface({ exec: fakeExec }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
  db.close();
  for (const [k, v] of Object.entries(envBak)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const url = (p: string): string => `http://127.0.0.1:${port}/api${p}`;

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const installedKeys = async (): Promise<string[]> => {
  try {
    const json = JSON.parse(
      await readFile(join(base, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
    ) as { plugins?: Record<string, unknown> };
    return Object.keys(json.plugins ?? {});
  } catch {
    return [];
  }
};

describe('daemon POST /projects/:id/install (category: plugin)', () => {
  it('外部市场包按市场身份装到 user 档：键 pack-a@ext-mkt、两步 CLI、清单就地维护', async () => {
    const res = await post(`/projects/${projectId}/install`, {
      category: 'plugin',
      name: 'pack-a',
      sourceDir: marketPackDir,
      scope: 'user',
      agent: 'claude',
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { key: string; scope: string; alreadyInstalled: boolean };
    expect(data).toMatchObject({ key: 'pack-a@ext-mkt', scope: 'user', alreadyInstalled: false });
    // 两步 CLI：marketplace add <数据目录市场> + install <注册键> --scope user
    expect(execCalls.some((a) => a.join(' ').startsWith('plugin marketplace add'))).toBe(true);
    expect(
      execCalls.some(
        (a) =>
          a[1] === 'install' && a[2] === 'pack-a@ext-mkt' && a.includes('--scope') && a.includes('user'),
      ),
    ).toBe(true);
    // 市场清单就地 upsert（外部市场：文件留在数据目录，不拷进 weave 自建市场）
    const mkt = JSON.parse(
      await readFile(join(base, 'weave', 'market', 'ext-mkt', '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { name: string; plugins: Array<{ name: string; source: string }> };
    expect(mkt).toMatchObject({ name: 'ext-mkt' });
    expect(mkt.plugins).toContainEqual({ name: 'pack-a', source: './plugins/pack-a' });
    expect(await installedKeys()).toContain('pack-a@ext-mkt');
  });

  it('幂等：已装直接返回 alreadyInstalled（不再跑安装链）', async () => {
    const before = execCalls.length;
    const res = await post(`/projects/${projectId}/install`, {
      category: 'plugin',
      name: 'pack-a',
      sourceDir: marketPackDir,
      scope: 'user',
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { key: string; alreadyInstalled: boolean };
    expect(data).toMatchObject({ key: 'pack-a@ext-mkt', alreadyInstalled: true });
    expect(execCalls.length).toBe(before);
  });

  it('scope 非 user 拒绝（project/local 安装待拍板 7-6 后续开）；codex 无安装面拒绝', async () => {
    const project = await post(`/projects/${projectId}/install`, {
      category: 'plugin',
      name: 'pack-a',
      sourceDir: marketPackDir,
      scope: 'project',
    });
    expect(project.status).toBe(400);
    const codex = await post(`/projects/${projectId}/install`, {
      category: 'plugin',
      name: 'pack-a',
      sourceDir: marketPackDir,
      scope: 'user',
      agent: 'codex',
    });
    expect(codex.status).toBe(400);
  });

  it('非市场包走 weave 自建市场：键 name@weave、marketplace add 自建目录源', async () => {
    // 数据目录外的散包（手加目录）：marketIdOf 无市场归属 → 自建市场链
    const looseDir = join(base, 'loose-pack');
    mkdirSync(join(looseDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(looseDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'pack-b' }),
    );
    const res = await post(`/projects/${projectId}/install`, {
      category: 'plugin',
      name: 'pack-b',
      sourceDir: looseDir,
      scope: 'user',
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { key: string; alreadyInstalled: boolean };
    expect(data).toMatchObject({ key: 'pack-b@weave', alreadyInstalled: false });
    expect(
      execCalls.some((a) => a[1] === 'install' && a[2] === 'pack-b@weave'),
    ).toBe(true);
    // 自建市场清单：包铺进 ~/.claude/weave-marketplace/plugins/ + 条目 upsert
    const mkt = JSON.parse(
      await readFile(
        join(base, '.claude', 'weave-marketplace', '.claude-plugin', 'marketplace.json'),
        'utf8',
      ),
    ) as { name: string; plugins: Array<{ name: string; source: string }> };
    expect(mkt).toMatchObject({ name: 'weave' });
    expect(mkt.plugins).toContainEqual({ name: 'pack-b', source: './plugins/pack-b' });
    expect(await installedKeys()).toContain('pack-b@weave');
  });

  it('缺 name/sourceDir 拒绝；未知项目只对要项目锚点的类别 404', async () => {
    const missing = await post(`/projects/${projectId}/install`, {
      category: 'plugin',
      sourceDir: marketPackDir,
    });
    expect(missing.status).toBe(400);
    // 插件只有 user 档、与项目无关 → 未知项目 id 不挡（路由挂在 /projects/:id 下只是形状）
    const pluginNoAnchor = await post('/projects/9999/install', {
      category: 'plugin',
      name: 'x',
      sourceDir: marketPackDir,
    });
    expect(pluginNoAnchor.status).toBe(201);
    // 要项目锚点的类别（项目档 skill）照旧 404
    const notFound = await post('/projects/9999/install', {
      category: 'skill',
      name: 'x',
      sourceDir: marketPackDir,
    });
    expect(notFound.status).toBe(404);
  });
});
