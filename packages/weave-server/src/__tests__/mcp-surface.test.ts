import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '@weavecode/harness';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';
import { assetSurfaceFor } from '../surfaces.js';

/**
 * R3 的验收口径：server 的 MCP 装卸只认 `AssetSurface` 的 `mcpScopes` / `mcpRead`
 * / `mcpWrite` / `mcpRemove`，不认 harness 名字。这里把 codex 面**改造成第三种
 * 形状**（多出一个它本来没有的 project 档、内存实现），三条路由照样通——若还有
 * 残留的 `agent === 'codex'` 分支，project 档会在 400 / 404 上露馅。
 */
describe('MCP 装卸按 AssetSurface 走（第三种形状也不改 server）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projectId: number;
  let projectDir: string;
  let originals: {
    mcpScopes: () => Array<'project' | 'user'>;
    mcpRead: (typeof CODEX)['mcpRead'];
    mcpWrite: (typeof CODEX)['mcpWrite'];
    mcpRemove: (typeof CODEX)['mcpRemove'];
  };
  /** 假 surface 的项目档存储。 */
  const store = new Map<string, McpServerConfig>();
  const CODEX = assetSurfaceFor('codex');

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectDir = mkdtempSync(join(tmpdir(), 'weave-mcpface-proj-'));
    projectId = projects.register({
      path: projectDir,
      name: 'proj',
      token: 'ptoken',
      source: 'init',
    }).id;

    originals = {
      mcpScopes: CODEX.mcpScopes,
      mcpRead: CODEX.mcpRead,
      mcpWrite: CODEX.mcpWrite,
      mcpRemove: CODEX.mcpRemove,
    };
    CODEX.mcpScopes = () => ['project', 'user'];
    CODEX.mcpRead = async (scope) => (scope === 'project' ? Object.fromEntries(store) : {});
    CODEX.mcpWrite = async (scope, _projectPath, _homedir, name, config) => {
      if (scope === 'project') store.set(name, config);
    };
    CODEX.mcpRemove = async (scope, _projectPath, _homedir, name) =>
      scope === 'project' && store.delete(name);

    server = createWeaveServer({ projects, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    Object.assign(CODEX, originals);
    server.close();
    db.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  const post = (verb: 'install' | 'uninstall', body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/${verb}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('项目档装卸走 surface：写进它、读回它、删掉它', async () => {
    const installed = await post('install', {
      category: 'mcp',
      name: 'fake',
      mcpConfig: { command: 'npx', args: ['-y', 'fake'] },
      scope: 'project',
      agent: 'codex',
    });
    expect(installed.status).toBe(201);
    expect(await installed.json()).toMatchObject({ scope: 'project', agent: 'codex' });
    expect(store.get('fake')).toEqual({ command: 'npx', args: ['-y', 'fake'] });

    const rows = (await (
      await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/mcp`)
    ).json()) as {
      rows: Array<{ key: string; harness: string; scope: string; installScopes: string[] }>;
    };
    const row = rows.rows.find((r) => r.harness === 'codex' && r.key === 'fake');
    expect(row).toMatchObject({ scope: 'project', installScopes: ['project', 'user'] });

    expect((await post('uninstall', { category: 'mcp', name: 'fake', scope: 'project', agent: 'codex' })).status).toBe(200);
    expect(store.size).toBe(0);
    // 已不在 → 404（与 claude 项目档同口径）
    expect((await post('uninstall', { category: 'mcp', name: 'fake', scope: 'project', agent: 'codex' })).status).toBe(404);
  });

  it('重复安装 409、不支持的 scope 400，都由表判定', async () => {
    store.set('dup', { command: 'x' });
    const conflict = await post('install', {
      category: 'mcp',
      name: 'dup',
      mcpConfig: { command: 'x' },
      scope: 'project',
      agent: 'codex',
    });
    expect(conflict.status).toBe(409);
    store.clear();

    const bad = await post('install', {
      category: 'mcp',
      name: 'x',
      mcpConfig: { command: 'x' },
      scope: 'project',
      agent: 'claude-none',
    });
    // 未注册的 agent 不再静默落到 claude
    expect(bad.status).toBe(400);
  });
});
