import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createClaudePluginSurface, type PluginExecutor } from '@weavecode/harness';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';

/**
 * 资源三层模型 · 层 2 卸载面：POST /projects/:id/plugins/uninstall。
 * 市场副本删除后 ToolkitSection 不再列出该包，这里是 harness 注册表
 * （installed_plugins.json）的唯一卸载口。surface 注入假 exec，不 spawn claude。
 */

describe('daemon /plugins/uninstall route', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projectId: number;
  let base: string;
  let calls: string[][];

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'weave-pk-un-'));
    process.env.HOME = base;
    process.env.USERPROFILE = base;
    calls = [];
    const exec: PluginExecutor = async (args) => {
      calls.push([...args]);
      return { stdout: '', stderr: '' };
    };
    const projectDir = path.join(base, 'proj');
    await mkdir(projectDir, { recursive: true });
    await mkdir(path.join(base, '.claude', 'plugins'), { recursive: true });
    await writeFile(
      path.join(base, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'demo@weave': [{ scope: 'user', installPath: path.join(base, 'cache', 'demo'), version: '0.1.0' }],
        },
      }),
    );
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectId = projects.register({ path: projectDir, name: 'pk', token: 'tkn', source: 'init' }).id;
    server = createWeaveServer({
      projects,
      port: 0,
      pluginSurface: createClaudePluginSurface({ exec }),
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
  const post = (body: unknown): Promise<Response> =>
    fetch(url(`/projects/${projectId}/plugins/uninstall`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const uninstallCalls = (): string[][] =>
    calls.filter((a) => a[1] === 'uninstall');

  it('按注册键逐 scope 卸载（键形拆解走 surface，不自拼）', async () => {
    const res = await post({ runtime: 'claude', key: 'demo@weave' });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true });
    expect(uninstallCalls()).toEqual([
      ['plugin', 'uninstall', 'demo@weave', '--scope', 'user', '--json'],
    ]);
  });

  it('未安装的键幂等：200 且不发 CLI', async () => {
    const res = await post({ runtime: 'claude', key: 'ghost@weave' });
    expect(res.status).toBe(200);
    expect(uninstallCalls().some((a) => a.includes('ghost@weave'))).toBe(false);
  });

  it('runtime 非 claude（codex）走 registry 的 codex 面：未装幂等 200', async () => {
    // codex 已接 plugins 槽（a49e145）；本测试只注入 claude 假面，codex 走
    // registry 真面——HOME 隔离下缓存目录为空 → 幂等返回，不发 CLI（claude
    // 假面的调用数不增长；codex 面的 `plugin remove` 走真 spawn，不计入）。
    const before = uninstallCalls().length;
    const res = await post({ runtime: 'codex', key: 'demo@weave' });
    expect(res.status).toBe(200);
    expect(uninstallCalls()).toHaveLength(before);
  });

  it('缺 key / 坏 JSON → 400', async () => {
    expect((await post({ runtime: 'claude' })).status).toBe(400);
    expect((await post('not-json')).status).toBe(400);
  });
});
