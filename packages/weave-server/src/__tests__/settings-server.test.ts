import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { AgentInstanceRepository } from '../repositories/agent-instances.js';
import { createWeaveServer } from '../daemon/server.js';
import { setDaemonSettingsDb, type TerminalSettings } from '../daemon/settings.js';
import type { ProjectOpener } from '../daemon/opener.js';

describe('daemon /settings and /projects/:id/open routes', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projectPath: string;
  // 隔离整个 suite 的 settings 存储（注入内存库）——否则第一次 GET 读到
  // 机器真实配置（用户上次选的终端），“defaults”断言变成环境抖动。
  let opener: ProjectOpener & {
    explorerCalls: string[];
    terminalCalls: Array<{ dir: string; terminal: TerminalSettings }>;
    runCalls: Array<{ dir: string; argv: string[]; terminal: TerminalSettings }>;
  };
  // runtimeSupervisor spy：Web 预设下「在终端中打开」走 headless shell 实例。
  let spawnCalls: Array<{ cwd: string; command: string }>;
  // spy：否则 PUT /settings 会真的去注册系统自启动项（默认实现打 reg/launchctl）
  const autoStartCalls: boolean[] = [];
  const autoStart = (enabled: boolean): void => {
    autoStartCalls.push(enabled);
  };

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectPath = await mkdtemp(path.join(tmpdir(), 'weave-open-'));
    projects.register({ path: projectPath, name: 'open-test', token: 'ptoken', source: 'init' });
    opener = {
      explorerCalls: [],
      terminalCalls: [],
      runCalls: [],
      openExplorer: async (dir) => {
        opener.explorerCalls.push(dir);
      },
      openTerminal: async (dir, terminal) => {
        opener.terminalCalls.push({ dir, terminal });
      },
      runInTerminal: async (dir, argv, terminal) => {
        opener.runCalls.push({ dir, argv, terminal });
      },
    };
    setDaemonSettingsDb(db);
    // aiKeyPath / decisionKeyPath 同样隔离：否则 apiKeySet 读机器真实 <dataDir> 下的
    // ai.json / decision.json，断言看环境。
    // runtimeSupervisor spy：Web 预设下「在终端中打开」走 headless shell 实例
    // （外部终端路径的测试不受影响——非 web 预设不碰它）。
    spawnCalls = [];
    server = createWeaveServer({
      projects,
      port: 0,
      opener,
      autoStart,
      aiKeyPath: path.join(projectPath, 'ai.json'),
      decisionKeyPath: path.join(projectPath, 'decision.json'),
      agentInstances: new AgentInstanceRepository(db),
      runtimeSupervisor: {
        spawnInstance: async (payload: { cwd: string; command: string }) => {
          spawnCalls.push({ cwd: payload.cwd, command: payload.command });
        },
      } as unknown as NonNullable<
        Parameters<typeof createWeaveServer>[0]['runtimeSupervisor']
      >,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    db.close();
    setDaemonSettingsDb(null); // back to the machine default for other suites
    await rm(projectPath, { recursive: true, force: true });
  });

  afterEach(() => {
    setDaemonSettingsDb(db); // undo any per-test override
  });

  it('GET /settings returns defaults plus platform presets', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/settings`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      settings: { terminal: { preset: string } };
      presets: Array<{ id: string }>;
      platform: string;
      urls: Array<{ url: string; protocol: string; scope: string }>;
    };
    expect(data.settings.terminal.preset).toBe('web');
    expect(data.presets.some((p) => p.id === 'auto')).toBe(true);
    expect(data.presets.some((p) => p.id === 'custom')).toBe(true);
    expect(typeof data.platform).toBe('string');
    // 访问地址派生面：恒 HTTPS（2026-11-23 HTTP 下线），本机回环在列
    expect(data.urls.some((u) => u.url.startsWith('https://localhost:'))).toBe(true);
    expect(data.urls.every((u) => u.protocol === 'https')).toBe(true);
  });

  it('PUT /settings persists and returns the normalized settings', async () => {
    setDaemonSettingsDb(openDatabase(':memory:'));
    const put = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminal: { preset: 'wt' } }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      terminal: { preset: 'wt', customCommand: '', webShell: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
      events: { retentionDays: 90 }, // 事件日志保留期（归一化补默认）
      sessions: { idleDays: 90, archiveDays: 5 }, // 无操作会话闲置移除窗 + 归档延迟（归一化补默认）
      startup: { launchOnLogin: false }, // 开机自启（归一化补默认，默认关）
      server: { bindHost: '0.0.0.0' }, // 监听绑定（归一化补默认；单端口 HTTPS，无独立 TLS 端口）
      ai: { baseUrl: '', model: '', apiKey: null, apiKeySet: false }, // AI 助手（归一化补默认，默认未配置；key 回显 null）
      decision: { baseUrl: '', model: '', apiKey: null, apiKeySet: false }, // 决策模型（同上）
      htmlExport: { activeId: null, profiles: [] }, // 导出 HTML 的自定义头（默认没有）
      extensions: { staleMs: 600000 }, // 会话扩展点陈旧窗（归一化补默认 10min）
      pet: { enabled: false, petId: 'weave-spider', notifications: true, size: 'small' }, // 桌面宠物（归一化补默认，默认关+小号）
      federation: { discovery: false, enabled: false, autoAccept: false }, // 联邦与发现（归一化补默认，双关——安全红线；autoAccept 邀请自动接受默认关）
      backup: { enabled: true, hour: 1, includeHistory: false, retentionDays: 7 }, // 每日备份（归一化补默认：开、凌晨 1 点、不含历史、留 7 天）
      terminalFocus: { focusOnOpen: true }, // 终端开窗行为（归一化补默认：调起拉回可见）
    });
    // 保存即对账自启动项（spy 记录；缺省 false → 注销）
    expect(autoStartCalls).toEqual([false]);
    // A follow-up GET reads the same value back through the injected dir.
    const get = await fetch(`http://127.0.0.1:${port}/settings`);
    const data = (await get.json()) as { settings: { terminal: { preset: string }; locale: string } };
    expect(data.settings.terminal.preset).toBe('wt');
    expect(data.settings.locale).toBe('zh-CN');
  });

  it('PUT /settings accepts and round-trips a locale change', async () => {
    setDaemonSettingsDb(openDatabase(':memory:'));
    const put = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminal: { preset: 'auto', customCommand: '' }, locale: 'en' }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { locale: string }).locale).toBe('en');
    // An unsupported locale is normalized back to the default, never persisted raw.
    const bad = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        terminal: { preset: 'auto', customCommand: '' },
        locale: 'fr',
        startup: { launchOnLogin: true },
      }),
    });
    expect(((await bad.json()) as { locale: string }).locale).toBe('zh-CN');
    // 自启开关随保存透传给注册器（第一次 PUT 未带 → false）
    expect(autoStartCalls).toEqual([false, false, true]);
  });

  it('PUT /settings persists ai/decision sections through a follow-up GET（落库白名单回归）', async () => {
    setDaemonSettingsDb(openDatabase(':memory:'));
    const put = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ai: { baseUrl: 'https://ai.example.com/v1', model: 'ftm-flash' },
        decision: { baseUrl: 'https://decision.example.com', model: 'decision-model' },
      }),
    });
    expect(put.status).toBe(200);
    // 响应对了不算数——必须再 GET 回来（曾出过「mergeDefaults 有段、KEYS 白名单没键，
    // PUT 响应带值但库里没落」的静默丢弃）。
    const get = await fetch(`http://127.0.0.1:${port}/settings`);
    const data = (await get.json()) as {
      settings: { ai?: { baseUrl: string; model: string }; decision?: { baseUrl: string; model: string } };
    };
    expect(data.settings.ai).toMatchObject({ baseUrl: 'https://ai.example.com/v1', model: 'ftm-flash' });
    expect(data.settings.decision).toMatchObject({
      baseUrl: 'https://decision.example.com',
      model: 'decision-model',
    });
  });

  it('PUT /settings 缺席的段继承现值（旧构建保存不清空 decision/ai）', async () => {
    setDaemonSettingsDb(openDatabase(':memory:'));
    // 先配好两段。
    await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ai: { baseUrl: 'https://ai.example.com/v1', model: 'ftm-flash' },
        decision: { baseUrl: 'https://decision.example.com', model: 'decision-model' },
      }),
    });
    // 只保存 terminal（旧构建的表单里没有 decision 段时的 payload 形状）。
    const put = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminal: { preset: 'wt' } }),
    });
    expect(put.status).toBe(200);
    const get = await fetch(`http://127.0.0.1:${port}/settings`);
    const data = (await get.json()) as {
      settings: { ai?: { baseUrl: string }; decision?: { baseUrl: string } };
    };
    expect(data.settings.ai?.baseUrl).toBe('https://ai.example.com/v1');
    expect(data.settings.decision?.baseUrl).toBe('https://decision.example.com');
  });

  it('POST /projects/:id/open with target=explorer opens the project directory', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/1/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'explorer' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; target: string; path: string };
    expect(data.ok).toBe(true);
    expect(data.target).toBe('explorer');
    expect(data.path).toBe(projectPath);
    expect(opener.explorerCalls).toEqual([projectPath]);
    expect(opener.terminalCalls).toEqual([]);
  });

  it('POST /projects/:id/open with target=terminal passes the configured preset', async () => {
    setDaemonSettingsDb(openDatabase(':memory:'));
    await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminal: { preset: 'custom', customCommand: 'myterm {path}' } }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/projects/1/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'terminal' }),
    });
    expect(res.status).toBe(200);
    expect(opener.terminalCalls).toEqual([
      {
        dir: projectPath,
        terminal: { preset: 'custom', customCommand: 'myterm {path}', webShell: '' },
      },
    ]);
  });

  it('POST /projects/:id/open with target=terminal under web preset spawns a headless shell', async () => {
    setDaemonSettingsDb(openDatabase(':memory:'));
    await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminal: { preset: 'web' } }),
    });
    const terminalsBefore = opener.terminalCalls.length;
    const res = await fetch(`http://127.0.0.1:${port}/projects/1/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'terminal' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; instanceId?: string };
    expect(data.ok).toBe(true);
    expect(data.instanceId).toMatch(/^wvt-/);
    // shell 实例落在项目路径；外部终端不该再被调（web 预设的打开方式就是
    // Runtime Host PTY；数组是跨测试累计的，断言本轮零新增）
    expect(spawnCalls).toEqual([{ cwd: projectPath, command: expect.any(String) }]);
    expect(opener.terminalCalls.length).toBe(terminalsBefore);
  });

  it('web 预设的 shell 可配置（terminal.webShell 生效到 PTY command）', async () => {
    setDaemonSettingsDb(openDatabase(':memory:'));
    await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminal: { preset: 'web', webShell: 'pwsh -NoLogo' } }),
    });
    spawnCalls = [];
    const res = await fetch(`http://127.0.0.1:${port}/projects/1/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'terminal' }),
    });
    expect(res.status).toBe(200);
    expect(spawnCalls).toEqual([{ cwd: projectPath, command: 'pwsh' }]);
  });

  it('POST /projects/:id/open under web preset with a live shell reuses it (no new spawn)', async () => {
    setDaemonSettingsDb(openDatabase(':memory:'));
    await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminal: { preset: 'web' } }),
    });
    const instances = new AgentInstanceRepository(db);
    instances.create({ id: 'wvt-live-1', projectId: 1, harness: 'shell', executionMode: 'headless', workingDirectory: projectPath, command: 'powershell' });
    instances.markStatus('wvt-live-1', 'running');
    spawnCalls = [];
    const res = await fetch(`http://127.0.0.1:${port}/projects/1/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'terminal' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; instanceId?: string; reused?: boolean };
    expect(data).toMatchObject({ ok: true, instanceId: 'wvt-live-1', reused: true });
    expect(spawnCalls).toEqual([]); // 接回，不再起第二个 shell
  });

  it('POST /projects/:id/open under web preset without a runtime host fails explicitly (501)', async () => {
    setDaemonSettingsDb(openDatabase(':memory:'));
    await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ terminal: { preset: 'web' } }),
    });
    // 用一个没有 runtimeSupervisor 的 server 实例模拟旧 daemon：临时关掉
    // ——createWeaveServer 的 deps 是装配期定死的，这里另起一个最小 server。
    const alt = createWeaveServer({
      projects: new ProjectRepository(db),
      port: 0,
      opener,
      autoStart,
      aiKeyPath: path.join(projectPath, 'ai.json'),
      decisionKeyPath: path.join(projectPath, 'decision.json'),
      // 独立的实例表：共享 db 里上一条用例留了活 shell，接回它会走 200 分支。
      agentInstances: new AgentInstanceRepository(openDatabase(':memory:')),
    });
    await new Promise<void>((resolve) => alt.listen(0, '127.0.0.1', resolve));
    const altPort = (alt.address() as { port: number }).port;
    const terminalsBefore = opener.terminalCalls.length;
    try {
      const res = await fetch(`http://127.0.0.1:${altPort}/projects/1/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'terminal' }),
      });
      expect(res.status).toBe(501);
      const data = (await res.json()) as { error?: string };
      expect(data.error).toMatch(/Runtime host/);
      // 明确失败：外部终端不该被静默调起（web 预设的口径就是 headless）。
      expect(opener.terminalCalls.length).toBe(terminalsBefore);
    } finally {
      alt.close();
    }
  });

  it('POST /open rejects an invalid target', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/1/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'vscode' }),
    });
    expect(res.status).toBe(400);
    expect(opener.explorerCalls).toHaveLength(1);
    expect(opener.terminalCalls).toHaveLength(1);
  });

  it('POST /open returns 404 for an unknown project', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/999/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'explorer' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /open returns 400 when the registered path no longer exists', async () => {
    db.exec('delete from projects');
    const projects2 = new ProjectRepository(db);
    projects2.register({ path: path.join(tmpdir(), 'weave-gone-xyz'), name: 'gone', token: 't2', source: 'init' });
    const id = projects2.list()[0].id;
    const res = await fetch(`http://127.0.0.1:${port}/projects/${id}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'explorer' }),
    });
    expect(res.status).toBe(400);
  });
});
