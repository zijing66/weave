import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLAUDE_DRIVER, HarnessRegistry, createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings, type TerminalSettings } from '../daemon/settings.js';
import { MessageDeliverer } from '../hooks/message-deliverer.js';
import { SessionRepository } from '../repositories/sessions.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import type { ProjectOpener } from '../daemon/opener.js';

describe('POST /projects/:id/new-session', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projects: ProjectRepository;
  let projectPath: string;
  let projectId: number;
  let runCalls: Array<{ dir: string; argv: string[]; terminal: TerminalSettings }>;
  /** 记录 runInTerminal 调用的假终端（一条 501 用例要另起一个注册表不同的服务）。 */
  let opener: ProjectOpener;
  /** 临时项目目录清单（afterAll 统一清）。 */
  const tmpDirs: string[] = [];
  let hooksTmp: string;

  const post = (url: string, body?: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

  /** 新注册一个项目目录，并把 init 选择结果写进它的 `.weave/config.yaml`。 */
  async function makeProject(name: string, harnesses: string[]): Promise<number> {
    const dir = await mkdtemp(path.join(tmpdir(), `weave-new-session-${name}-`));
    tmpDirs.push(dir);
    await mkdir(path.join(dir, '.weave'), { recursive: true });
    await writeFile(
      path.join(dir, '.weave', 'config.yaml'),
      `initVersion: 0.1.0\nharnesses: ${JSON.stringify(harnesses)}\n`,
      'utf-8',
    );
    return projects.register({ path: dir, name, token: `${name}-token`, source: 'init' }).id;
  }

  beforeAll(async () => {
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    projectPath = await mkdtemp(path.join(tmpdir(), 'weave-new-session-'));
    tmpDirs.push(projectPath);
    projectId = projects.register({
      path: projectPath,
      name: 'new-session-test',
      token: 'nstoken',
      source: 'init',
    }).id;
    runCalls = [];
    opener = {
      openExplorer: async () => {},
      openTerminal: async () => {},
      runInTerminal: async (dir, argv, terminal) => {
        runCalls.push({ dir, argv, terminal });
      },
    };
    setDaemonSettingsDb(db);
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    // 真 deliverer（临时 hooksDir）：起点候选落盘的断言面
    hooksTmp = await mkdtemp(path.join(tmpdir(), 'weave-new-session-hooks-'));
    tmpDirs.push(hooksTmp);
    server = createWeaveServer({
      projects,
      port: 0,
      harnesses: createRuntimeRegistry(),
      opener,
      messageDeliverer: new MessageDeliverer({
        sessions: new SessionRepository(db),
        projects,
        hookEvents: new HookEventRepository(db),
        hooksDir: hooksTmp,
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    db.close();
    setDaemonSettingsDb(null);
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });

  it('用 harness 裸 bin（新会话，不带 resume 参数）落进项目目录', async () => {
    const res = await post(`/projects/${projectId}/new-session`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { command: string }).toMatchObject({
      ok: true,
      command: 'claude',
      cwd: projectPath,
    });
    expect(runCalls).toEqual([
      { dir: projectPath, argv: ['claude'], terminal: { preset: 'auto', customCommand: '' } },
    ]);
  });

  it('本项目一台终端都没开也照样起（落点自决，不是硬闸）', async () => {
    const before = runCalls.length;
    const res = await post(`/projects/${projectId}/new-session`);
    expect(res.status).toBe(200);
    expect(runCalls.slice(before).map((c) => c.argv)).toEqual([['claude']]);
  });

  it('未知项目 404', async () => {
    expect((await post('/projects/9999/new-session')).status).toBe(404);
  });

  it('body 指定已接入的 harness：起它', async () => {
    const id = await makeProject('pick', ['claude', 'codex']);
    runCalls = [];
    const res = await post(`/projects/${id}/new-session`, { harness: 'claude' });
    expect(res.status).toBe(200);
    expect(runCalls.map((c) => c.argv)).toEqual([['claude']]);
  });

  it('未接入的 harness 409（不替用户跨配置起会话）、非法值 400', async () => {
    const id = await makeProject('codex-only', ['codex']);
    const before = runCalls.length;
    const res = await post(`/projects/${id}/new-session`, { harness: 'claude' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('not integrated');
    expect((await post(`/projects/${id}/new-session`, { harness: 'bogus' })).status).toBe(400);
    expect(runCalls).toHaveLength(before);
  });

  it('body 指定 codex：起 codex 裸 bin（与手动 TUI 同一路径，hook 由共享 daemon 代跑）', async () => {
    const id = await makeProject('codex-pick', ['codex']);
    runCalls = [];
    const res = await post(`/projects/${id}/new-session`, { harness: 'codex' });
    expect(res.status).toBe(200);
    expect(runCalls.map((c) => c.argv)).toEqual([['codex']]);
  });

  it('spawn 回执起点：launch 信源的 harness（codex）记起点候选，hook 信源（claude）不记', async () => {
    const codexId = await makeProject('origin-codex', ['codex']);
    const claudeId = await makeProject('origin-claude', ['claude']);
    runCalls = [];
    opener.runInTerminal = async (dir, argv, terminal) => {
      runCalls.push({ dir, argv, terminal });
      return { env: { WEZTERM_PANE: '42', WEZTERM_UNIX_SOCKET: 'D:/sock/gui-sock-9' } };
    };
    await post(`/projects/${codexId}/new-session`, { harness: 'codex' });
    await post(`/projects/${claudeId}/new-session`, { harness: 'claude' });
    // 起点候选落盘（paneEnvSource='launch' 才记；claude 的 pending 永无人认领，不记）
    const origins = JSON.parse(
      await readFile(path.join(hooksTmp, 'pending-origins.json'), 'utf8'),
    ) as Array<{ harness: string; projectId: number; env: Record<string, string> }>;
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({
      harness: 'codex',
      projectId: codexId,
      env: { WEZTERM_PANE: '42' },
    });
  });

  it('引导注入：spec 声明 bootstrapText 且有 spawn 回执 → 延时向起点 pane 贴文本并补 CR', async () => {
    vi.useFakeTimers();
    try {
      const texts: Array<{ paneId: string; text: string }> = [];
      const keys: Array<{ paneId: string; keys: string }> = [];
      const codexId = await makeProject('bootstrap-codex', ['codex']);
      runCalls = [];
      opener.runInTerminal = async (dir, argv, terminal) => {
        runCalls.push({ dir, argv, terminal });
        return { env: { WEZTERM_PANE: '7', WEZTERM_UNIX_SOCKET: 'D:/sock/gui-sock-3' } };
      };
      const terminal = {
        available: () => true,
        listPanes: async () => [],
        locatePane: async (env: Record<string, string>) => env['WEZTERM_PANE'] ?? null,
        sendText: async (paneId: string, text: string) => {
          texts.push({ paneId, text });
        },
        sendKeys: async (paneId: string, sent: string) => {
          keys.push({ paneId, keys: sent });
        },
        closePane: async () => {},
      };
      const alt = createWeaveServer({
        projects,
        port: 0,
        harnesses: createRuntimeRegistry(),
        opener,
        terminal,
      });
      await new Promise<void>((resolve) => alt.listen(0, '127.0.0.1', resolve));
      const altPort = (alt.address() as { port: number }).port;
      const postAlt = (body?: unknown): Promise<Response> =>
        fetch(`http://127.0.0.1:${altPort}/projects/${codexId}/new-session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
      try {
        await postAlt({ harness: 'codex' });
        // T1 前不注入
        expect(texts).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(8_000);
        // T1：/rename <项目名> 贴进起点 pane
        expect(texts).toEqual([{ paneId: '7', text: '/rename bootstrap-codex' }]);
        expect(keys).toHaveLength(0);
        // T2 补 CR、T3 整段重来——定时器在 T1 的 sendText 微任务延续里才注册，
        // 先冲几拍微任务让它挂上，再一把跑完
        for (let i = 0; i < 5; i++) await Promise.resolve();
        await vi.runAllTimersAsync();
        expect(keys).toEqual([{ paneId: '7', keys: '\r' }]);
        expect(texts).toEqual([
          { paneId: '7', text: '/rename bootstrap-codex' },
          { paneId: '7', text: '/rename bootstrap-codex' },
        ]);
      } finally {
        alt.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('引导注入不触发：无 spawn 回执（legacy start）或 harness 未声明 bootstrapText（claude）', async () => {
    vi.useFakeTimers();
    try {
      const texts: string[] = [];
      const terminal = {
        available: () => true,
        listPanes: async () => [],
        locatePane: async () => '9',
        sendText: async (_paneId: string, text: string) => {
          texts.push(text);
        },
        sendKeys: async () => {},
        closePane: async () => {},
      };
      const alt = createWeaveServer({
        projects,
        port: 0,
        harnesses: createRuntimeRegistry(),
        opener,
        terminal,
      });
      await new Promise<void>((resolve) => alt.listen(0, '127.0.0.1', resolve));
      const altPort = (alt.address() as { port: number }).port;
      const postAlt = (id: number, body?: unknown): Promise<Response> =>
        fetch(`http://127.0.0.1:${altPort}/projects/${id}/new-session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
      try {
        // claude：无 bootstrapText（SessionStart 启动即发，无需引导）
        const claudeId = await makeProject('bootstrap-claude', ['claude']);
        opener.runInTerminal = async (dir, argv, terminal) => {
          runCalls.push({ dir, argv, terminal });
          return { env: { WEZTERM_PANE: '8' } };
        };
        await postAlt(claudeId, { harness: 'claude' });
        // codex 但无回执（fake opener 这次不返回 origin）
        const codexId = await makeProject('bootstrap-noorigin', ['codex']);
        opener.runInTerminal = async (dir, argv, terminal) => {
          runCalls.push({ dir, argv, terminal });
        };
        await postAlt(codexId, { harness: 'codex' });
        await vi.advanceTimersByTimeAsync(15_000);
        expect(texts).toEqual([]);
      } finally {
        alt.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('已接入但注册表里没有该 harness（无 resume 槽）→ 501，缺省亦然', async () => {
    const id = await makeProject('no-driver', ['codex']);
    // 只注册 claude 的注册表：codex 在 init 选择结果里，但 weave 手里没有它的驱动。
    const claudeOnly = new HarnessRegistry();
    claudeOnly.register(CLAUDE_DRIVER);
    const alt = createWeaveServer({ projects, port: 0, harnesses: claudeOnly, opener });
    await new Promise<void>((resolve) => alt.listen(0, '127.0.0.1', resolve));
    const altPort = (alt.address() as { port: number }).port;
    const postAlt = (body?: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${altPort}/projects/${id}/new-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    try {
      const before = runCalls.length;
      expect((await postAlt({ harness: 'codex' })).status).toBe(501);
      expect((await postAlt()).status).toBe(501);
      expect(runCalls).toHaveLength(before);
    } finally {
      alt.close();
    }
  });
});
