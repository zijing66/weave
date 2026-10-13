import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { HookRuleRepository } from '../repositories/hook-rules.js';
import { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import { PluginStateRepository } from '../repositories/plugin-states.js';
import { SessionRepository } from '../repositories/sessions.js';
import { ClaudeCodeAdapter } from '../hooks/adapter.js';
import { HookRuleRegistry } from '../hooks/registry.js';
import { HookDispatcher } from '../hooks/dispatcher.js';
import { HookEventBus } from '../hooks/bus.js';
import { WeavePluginLoader } from '../hooks/plugin-loader.js';
import { handleIngestedRecords, type InboxRecord } from '../hooks/inbox-worker.js';
import { createWeaveServer } from '../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../daemon/settings.js';

const PROJECT_TOKEN = 'ptoken';

describe('daemon server hooks rules/dispatch/sessions API', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let registry: HookRuleRegistry;
  let dispatches: HookDispatchRepository;
  let sessions: SessionRepository;
  let hookEvents: HookEventRepository;
  let projects: ProjectRepository;
  let bus: HookEventBus;
  let dispatcher: HookDispatcher;
  let hooksDir: string;
  let projectId: number;

  const auth = { 'content-type': 'application/json' };
  const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: auth });
  const post = (p: string, body: unknown, method = 'POST') =>
    fetch(`http://127.0.0.1:${port}${p}`, { method, headers: auth, body: JSON.stringify(body) });

  /** 采集链路的落库端（与 inbox worker 入库同形），供 API 用例造数据。 */
  const seed = (sessionId: string, eventType: string): InboxRecord => {
    const input = {
      projectId,
      source: 'claude' as const,
      eventType,
      sessionId,
      payload: JSON.stringify({ eventType, raw: {} }),
    };
    const eventId = hookEvents.insert(input);
    sessions.touch(sessionId, projectId);
    return { eventId, projectId, input };
  };

  beforeAll(async () => {
    setDaemonSettingsDb(openDatabase(':memory:'));
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    projectId = projects.register({ path: '/api-proj', name: 'p', token: PROJECT_TOKEN, source: 'init' }).id;
    hookEvents = new HookEventRepository(db);
    registry = new HookRuleRegistry(new HookRuleRepository(db));
    dispatches = new HookDispatchRepository(db);
    sessions = new SessionRepository(db);
    bus = new HookEventBus();
    hooksDir = await mkdtemp(path.join(tmpdir(), 'weave-hooks-api-'));
    dispatcher = new HookDispatcher({
      registry,
      dispatches,
      bus,
      projects,
      sessions,
    });
    server = createWeaveServer({
      projects,
      port: 0,
      hookEvents,
      adapters: [new ClaudeCodeAdapter()],
      hookRegistry: registry,
      hookDispatches: dispatches,
      hookSessions: sessions,
      hookBus: bus,
      hookDispatcher: dispatcher,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
    setDaemonSettingsDb(null);
    void rm(hooksDir, { recursive: true, force: true });
  });

  it('规则 CRUD + toggle 全流程', async () => {
    // create（inject 合法事件）
    const created = await post('/hooks/rules', {
      name: '文档更新',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      filter: { pathGlobs: ['**/*.md'] },
      handler: { type: 'inject', template: '更新文档 {file}' },
    });
    expect(created.status).toBe(201);
    const { rule } = (await created.json()) as { rule: { id: string; enabled: boolean } };
    expect(rule.enabled).toBe(true);

    // create（inject 非法事件 → 400）
    const bad = await post('/hooks/rules', {
      name: 'bad',
      projectId: null,
      source: { kind: 'claude-event', event: 'PreToolUse' },
      handler: { type: 'inject', template: 'x' },
    });
    expect(bad.status).toBe(400);

    // list（带 projectId 附带全局规则）
    const list = (await (await get(`/hooks/rules?projectId=${projectId}`)).json()) as {
      rules: Array<{ id: string }>;
    };
    expect(list.rules.map((r) => r.id)).toContain(rule.id);

    // update
    const updated = await post(`/hooks/rules/${rule.id}`, { name: '文档更新检查' }, 'PUT');
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { rule: { name: string } }).rule.name).toBe('文档更新检查');

    // toggle off/on
    const toggled = await post(`/hooks/rules/${rule.id}/toggle`, { enabled: false });
    expect(toggled.status).toBe(200);
    expect(((await toggled.json()) as { rule: { enabled: boolean } }).rule.enabled).toBe(false);
    await post(`/hooks/rules/${rule.id}/toggle`, { enabled: true });

    // delete + 404
    const del = await post(`/hooks/rules/${rule.id}`, null, 'DELETE');
    expect(del.status).toBe(200);
    expect((await post(`/hooks/rules/${rule.id}`, null, 'DELETE')).status).toBe(404);
  });

  it('ingest 记录驱动规则：inject 命中时落 injected 派发行（镜像外规则进 outbox）', async () => {
    const created = await post('/hooks/rules', {
      name: 'inject-in-ingest',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'inject', template: 'do {event}' },
    });
    const { rule } = (await created.json()) as { rule: { id: string } };

    const record = seed('sess-api', 'PostToolUse');
    handleIngestedRecords({ projects, hooksDir, dispatcher }, [record]);
    await new Promise((r) => setTimeout(r, 50));

    // 派发记录可查
    const list = (await (await get(`/hooks/dispatches?ruleId=${rule.id}`)).json()) as {
      dispatches: Array<{ status: string; sessionId: string }>;
    };
    expect(list.dispatches).toHaveLength(1);
    expect(list.dispatches[0]).toMatchObject({ status: 'injected', sessionId: 'sess-api' });

    // sessionId 过滤（任务视图按会话查派发）
    const bySession = (await (await get('/hooks/dispatches?sessionId=sess-api')).json()) as {
      dispatches: unknown[];
    };
    expect(bySession.dispatches).toHaveLength(1);
    const missSession = (await (await get('/hooks/dispatches?sessionId=nope')).json()) as {
      dispatches: unknown[];
    };
    expect(missSession.dispatches).toHaveLength(0);

    await post(`/hooks/rules/${rule.id}`, null, 'DELETE');
  });

  it('每条采集记录都经 SSE 推出 event.ingested 帧（任务面板实时刷新源）', async () => {
    const ctrl = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events`, {
        signal: ctrl.signal,
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // 流建立后再推记录（先连后发，避免帧早于订阅丢失）
      const record = seed('sse-sess', 'PostToolUse');
      handleIngestedRecords({ projects, hooksDir, bus }, [record]);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let found = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !found) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        found = buffered.includes('"kind":"event.ingested"');
      }
      expect(found).toBe(true);
      expect(buffered).toContain('"type":"hook"');
      expect(buffered).toContain('"sessionId":"sse-sess"');
    } finally {
      ctrl.abort();
    }
  });

  it('会话列表随事件出现；PATCH 改名挂 pending_title；未知会话 404', async () => {
    seed('sess-rename', 'Stop');

    const list = (await (await get('/sessions')).json()) as {
      sessions: Array<{
        sessionId: string;
        pendingTitle: string | null;
        eventCount?: number;
        turnOpen?: boolean;
        lastEventType?: string | null;
      }>;
    };
    const row = list.sessions.find((s) => s.sessionId === 'sess-rename');
    expect(row).toBeDefined();
    expect(row!.pendingTitle).toBeNull();
    // 事件计数（任务视图左栏，LEFT JOIN 一次查出）
    expect(row!.eventCount).toBe(1);
    // 回合开合基线：只有 Stop（无 UPS）→ 回合已关
    expect(row!.turnOpen).toBe(false);
    // 最新事件类型（web 状态总线判「关闭」用）
    expect(row!.lastEventType).toBe('Stop');

    // 再来一条 UserPromptSubmit → 基线翻为回合开着（最后 UPS 晚于最后 Stop）
    seed('sess-rename', 'UserPromptSubmit');
    const list2 = (await (await get('/sessions')).json()) as {
      sessions: Array<{ sessionId: string; turnOpen?: boolean; lastEventType?: string | null }>;
    };
    const row2 = list2.sessions.find((s) => s.sessionId === 'sess-rename')!;
    expect(row2.turnOpen).toBe(true);
    expect(row2.lastEventType).toBe('UserPromptSubmit');

    const renamed = await post('/sessions/sess-rename', { title: '新标题' }, 'PATCH');
    expect(renamed.status).toBe(200);
    expect(
      ((await renamed.json()) as { session: { pendingTitle: string; title: string } }).session,
    ).toMatchObject({ pendingTitle: '新标题', title: '新标题' }); // display 名立即落

    expect((await post('/sessions/nope', { title: 'x' }, 'PATCH')).status).toBe(404);
    expect((await post('/sessions/sess-rename', { title: '' }, 'PATCH')).status).toBe(400);
  });

  it('DELETE /sessions/:id 清会话行 + 事件 + 派发；重复删 404', async () => {
    seed('sess-del', 'SessionStart');
    seed('sess-del', 'UserPromptSubmit');

    const before = (await (await get('/sessions')).json()) as {
      sessions: Array<{ sessionId: string; eventCount?: number }>;
    };
    expect(before.sessions.find((s) => s.sessionId === 'sess-del')?.eventCount).toBe(2);

    const del = (method = 'DELETE') =>
      fetch(`http://127.0.0.1:${port}/sessions/sess-del`, { method, headers: auth });
    const res = await del();
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; events: number }).toMatchObject({
      ok: true,
      events: 2,
    });

    const after = (await (await get('/sessions')).json()) as {
      sessions: Array<{ sessionId: string }>;
    };
    expect(after.sessions.some((s) => s.sessionId === 'sess-del')).toBe(false);
    expect((await del()).status).toBe(404);
  });
});

describe('daemon server /hooks/plugins API', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let root: string;
  let loader: WeavePluginLoader;

  const auth = { 'content-type': 'application/json' };
  const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: auth });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'weave-plugins-api-'));
    const dir = path.join(root, 'demo-plugin');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'prompts'), { recursive: true });
    await writeFile(
      path.join(dir, 'weave-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: 'demo-plugin',
        name: '演示插件',
        version: '1.0.0',
        rules: ['rules.json'],
      }),
    );
    await writeFile(
      path.join(dir, 'rules.json'),
      JSON.stringify([
        {
          name: '演示规则',
          source: { kind: 'claude-event', event: 'PostToolUse' },
          handler: { type: 'inject', template: '演示 {file}' },
        },
      ]),
    );

    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projects.register({ path: '/plug-proj', name: 'p', token: PROJECT_TOKEN, source: 'init' });
    const rules = new HookRuleRepository(db);
    const registry = new HookRuleRegistry(rules);
    loader = new WeavePluginLoader({
      rules,
      registry,
      states: new PluginStateRepository(db),
    });
    await loader.loadRoot(root, 'user', null);

    server = createWeaveServer({
      projects,
      port: 0,
      hookRegistry: registry,
      hookPlugins: loader,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
    void rm(root, { recursive: true, force: true });
  });

  it('GET /hooks/plugins 列出 SPI 加载结果', async () => {
    const res = await get('/hooks/plugins');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { plugins: Array<{ id: string; status: string; ruleCount: number }> };
    expect(data.plugins).toHaveLength(1);
    expect(data.plugins[0]).toMatchObject({ id: "demo-plugin", status: "active", ruleCount: 1 });
  });

  it('POST toggle 级联启停插件规则（404 未知插件）', async () => {
    const notFound = await fetch(`http://127.0.0.1:${port}/hooks/plugins/nope/toggle`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ enabled: false }),
    });
    expect(notFound.status).toBe(404);

    const ok = await fetch(`http://127.0.0.1:${port}/hooks/plugins/demo-plugin/toggle`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ enabled: false }),
    });
    expect(ok.status).toBe(200);

    const after = (await (await get('/hooks/plugins')).json()) as {
      plugins: Array<{ status: string }>;
    };
    expect(after.plugins[0]!.status).toBe('disabled');
    // 规则级联关闭
    const rules = (await (await get('/hooks/rules')).json()) as { rules: Array<{ enabled: boolean }> };
    expect(rules.rules.every((r) => r.enabled === false)).toBe(true);

    // 恢复
    await fetch(`http://127.0.0.1:${port}/hooks/plugins/demo-plugin/toggle`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ enabled: true }),
    });
    const restored = (await (await get('/hooks/rules')).json()) as { rules: Array<{ enabled: boolean }> };
    expect(restored.rules.every((r) => r.enabled === true)).toBe(true);
  });
});
