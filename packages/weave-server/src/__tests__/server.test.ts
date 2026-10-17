import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../daemon/settings.js';
import type { ProjectOpener } from '../daemon/opener.js';
import type { DatabaseSync } from 'node:sqlite';

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
    server = createWeaveServer({ projects, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    db.close();
    await rm(brokenDir, { recursive: true, force: true });
  });

  it('GET /health returns service info', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { service: string };
    expect(data.service).toBe('weave-daemon');
  });

  it('GET /projects returns projects', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { projects: Array<{ path: string }> };
    expect(data.projects.map((p) => p.path)).toContain(path.resolve('/test'));
  });

  it('GET /capabilities 返回安装属性矩阵', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/capabilities`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      categories: Record<string, { surfaces: Array<{ harness: string; scopes: string[] }> }>;
    };
    // workflow 仅项目（无 userDir）；mcp × codex 强制 user
    expect(data.categories.workflow.surfaces).toEqual([
      { harness: 'claude', scopes: ['project'] },
    ]);
    expect(
      data.categories.mcp.surfaces.find((s) => s.harness === 'codex')?.scopes,
    ).toEqual(['user']);
    // skill 面由资产面派生（加 harness 自动跟随），不写死闭式计数
    expect(
      data.categories.skill.surfaces.find((s) => s.harness === 'claude')?.scopes,
    ).toEqual(['project', 'user']);
    expect(data.categories.skill.surfaces.length).toBeGreaterThanOrEqual(2);
  });

  it('unknown routes return 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it('GET /assets returns 503 without a watch service', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets?path=/test`);
    expect(res.status).toBe(503);
  });

  it('GET /assets requires a path query', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets`);
    expect(res.status).toBe(400);
  });

  it('GET /events returns 503 without a watch service', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    expect(res.status).toBe(503);
  });

  // --- 批 8：GET /projects/:id/harness-checks（只读健康端点） ---

  it('GET harness-checks returns structured check results', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/${brokenId}/harness-checks`);
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
    const res = await fetch(`http://127.0.0.1:${port}/projects/9999/harness-checks`);
    expect(res.status).toBe(404);
  });

  it('POST harness-checks is not allowed', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/${brokenId}/harness-checks`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});

describe('daemon server PUT /projects/order（拖动排序持久化）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let p1: number;
  let p2: number;
  let p3: number;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    p1 = projects.register({ path: '/ord-a', name: 'a', token: 't1', source: 'init' }).id;
    p2 = projects.register({ path: '/ord-b', name: 'b', token: 't2', source: 'init' }).id;
    p3 = projects.register({ path: '/ord-c', name: 'c', token: 't3', source: 'init' }).id;
    server = createWeaveServer({ projects, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  const putOrder = (ids: unknown) =>
    fetch(`http://127.0.0.1:${port}/projects/order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });

  const listedIds = async (): Promise<number[]> => {
    const res = await fetch(`http://127.0.0.1:${port}/projects`);
    return ((await res.json()) as { projects: Array<{ id: number }> }).projects.map((p) => p.id);
  };

  it('全量 payload 落定新序；未排入的项目垫尾；重复写幂等', async () => {
    expect((await putOrder([p3, p1])).status).toBe(200);
    expect(await listedIds()).toEqual([p3, p1, p2]); // p2 未排序 → 垫尾
    expect((await putOrder([p3, p1])).status).toBe(200);
    expect(await listedIds()).toEqual([p3, p1, p2]); // 幂等
    expect((await putOrder([p2, p3])).status).toBe(200);
    expect(await listedIds()).toEqual([p2, p3, p1]); // 重排覆盖，p1 回落尾部
  });

  it('未知 id 静默跳过（并发删除安全）；坏 body 400', async () => {
    expect((await putOrder([9999, p2])).status).toBe(200);
    expect((await listedIds())[0]).toBe(p2);
    expect((await putOrder(['x'])).status).toBe(400);
    expect((await putOrder('not-array')).status).toBe(400);
  });
});

describe('daemon server GET /terminals/counts（项目卡终端角标）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let ids: number[];
  /** spy opener：测试机可能真跑着 wezterm，计数必须走注入缝、不进真探测。 */
  const openedByPath = new Map<string, number>();

  beforeAll(async () => {
    db = openDatabase(':memory:');
    setDaemonSettingsDb(db);
    await writeDaemonSettings({
      terminal: { preset: 'wezterm', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    const projects = new ProjectRepository(db);
    ids = [
      projects.register({ path: '/term-a', name: 'a', token: 'ta', source: 'init' }).id,
      projects.register({ path: '/term-b', name: 'b', token: 'tb', source: 'init' }).id,
    ];
    const opener: ProjectOpener = {
      openExplorer: async () => {},
      openTerminal: async () => {},
      runInTerminal: async () => {},
      countTerminals: async (dirs) => new Map(dirs.map((d) => [d, openedByPath.get(d) ?? 0])),
      listTerminals: async (dir) => [
        { id: 'deadbeef:1:2', windowId: 1, tabId: 2, title: dir, matchCount: 2, paneCount: 3, active: true },
      ],
    };
    server = createWeaveServer({ projects, port: 0, opener });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    setDaemonSettingsDb(null);
    db.close();
  });

  it('projectId → 已开终端窗口数', async () => {
    openedByPath.set(path.resolve('/term-a'), 3);
    const res = await fetch(`http://127.0.0.1:${port}/terminals/counts`);
    expect(res.status).toBe(200);
    const { counts } = (await res.json()) as { counts: Record<string, number> };
    expect(counts[ids[0]!]).toBe(3);
    expect(counts[ids[1]!]).toBe(0); // 无终端 → 0（角标不显示）
  });

  it('GET /projects/:id/terminals 返回可附加目标（wezterm preset 才枚举）；未知项目 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/${ids[0]!}/terminals`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projectId: number;
      terminals: Array<{ id: string; matchCount: number; active: boolean }>;
    };
    expect(body.projectId).toBe(ids[0]);
    expect(body.terminals).toHaveLength(1);
    expect(body.terminals[0]).toMatchObject({ id: 'deadbeef:1:2', matchCount: 2, active: true });
    expect(
      (await fetch(`http://127.0.0.1:${port}/projects/9999/terminals`)).status,
    ).toBe(404);
  });
});

describe('daemon server 项目关终端（多选：/panes 列表 + /close-terminal 只关清单）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let ids: number[];
  /** spy opener：测试机可能真跑着 wezterm，枚举/关闭必须走注入缝、不进真探测。 */
  let closedByPath: Array<{ dir: string; paneIds: readonly string[] }> = [];
  let listPanesError: string | null = null;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    setDaemonSettingsDb(db);
    await writeDaemonSettings({
      terminal: { preset: 'wezterm', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    const projects = new ProjectRepository(db);
    ids = [
      projects.register({ path: '/close-a', name: 'a', token: 'ca', source: 'init' }).id,
      projects.register({ path: '/close-b', name: 'b', token: 'cb', source: 'init' }).id,
    ];
    const opener: ProjectOpener = {
      openExplorer: async () => {},
      openTerminal: async () => {},
      runInTerminal: async () => {},
      listPanes: async (dir) => {
        if (listPanesError) throw new Error(listPanesError);
        return [
          { id: 'm:11', title: 'pane one', cwd: dir },
          { id: 'm:12', title: null, cwd: '/elsewhere' },
        ];
      },
      closeTerminals: async (dir, _terminal, paneIds) => {
        closedByPath.push({ dir, paneIds });
        return paneIds.length;
      },
    };
    server = createWeaveServer({ projects, port: 0, opener });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    setDaemonSettingsDb(null);
    db.close();
  });

  it('GET /projects/:id/panes 回本项目名下的 pane；未知项目 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/${ids[0]!}/panes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projectId: number;
      panes: Array<{ id: string; title: string | null; cwd: string | null }>;
    };
    expect(body.projectId).toBe(ids[0]);
    expect(body.panes.map((p) => p.id)).toEqual(['m:11', 'm:12']);
    expect((await fetch(`http://127.0.0.1:${port}/projects/9999/panes`)).status).toBe(404);
  });

  it('枚举抛（该 preset 关不了远程 pane）→ 409 带原文，不给空表装作没终端', async () => {
    listPanesError = 'Terminal preset "wt" cannot close open panes remotely — pick wezterm in settings';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/projects/${ids[0]!}/panes`);
      expect(res.status).toBe(409);
      expect((await res.json()) as { error: string }).toEqual({ error: listPanesError });
    } finally {
      listPanesError = null;
    }
  });

  it('POST /close-terminal 只关 body.paneIds 清单里的（不提供一口气全关）', async () => {
    closedByPath = [];
    const res = await fetch(`http://127.0.0.1:${port}/projects/${ids[0]!}/close-terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paneIds: ['m:11', 'm:99'] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; closed: number }).toMatchObject({ ok: true });
    expect(closedByPath).toEqual([{ dir: path.resolve('/close-a'), paneIds: ['m:11', 'm:99'] }]);
  });

  it('paneIds 缺失 / 空 / 非字符串一律 400（「全关」这条路整个没有）', async () => {
    closedByPath = [];
    for (const body of [{}, { paneIds: [] }, { paneIds: ['ok', 7] }, { paneIds: 'm:11' }]) {
      const res = await fetch(`http://127.0.0.1:${port}/projects/${ids[0]!}/close-terminal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(closedByPath).toEqual([]);
    expect(
      (await fetch(`http://127.0.0.1:${port}/projects/9999/close-terminal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paneIds: ['m:11'] }),
      })).status,
    ).toBe(404);
  });
});
