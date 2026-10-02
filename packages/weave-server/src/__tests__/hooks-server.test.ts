import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { HookRuleRepository } from '../repositories/hook-rules.js';
import { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import { SessionRepository } from '../repositories/sessions.js';
import { ClaudeCodeAdapter } from '../hooks/adapter.js';
import { HookRuleRegistry } from '../hooks/registry.js';
import { HookDispatcher } from '../hooks/dispatcher.js';
import { HookEventBus } from '../hooks/bus.js';
import { createWeaveServer } from '../daemon/server.js';
import { setDaemonSettingsDir, writeDaemonSettings } from '../daemon/settings.js';

const DAEMON_TOKEN = 'daemon-token';
const PROJECT_TOKEN = 'ptoken';

describe('daemon server /hooks endpoint', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let hookEvents: HookEventRepository;
  let projectId: number;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const row = projects.register({
      path: '/proj',
      name: 'test',
      token: PROJECT_TOKEN,
      source: 'init',
    });
    projectId = row.id;
    hookEvents = new HookEventRepository(db);
    server = createWeaveServer({
      projects,
      daemonToken: DAEMON_TOKEN,
      port: 0,
      hookEvents,
      adapters: [new ClaudeCodeAdapter()],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  it('accepts a valid hook report authenticated by the project token', async () => {
    const body = JSON.stringify({
      source: 'claude',
      eventType: 'PostToolUse',
      sessionId: 's1',
      cwd: '/proj',
      payload: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit' }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      id: number;
      projectId: number;
      source: string;
      eventType: string;
    };
    expect(data.projectId).toBe(projectId);
    expect(data.source).toBe('claude');
    expect(data.eventType).toBe('PostToolUse');
    expect(typeof data.id).toBe('number');

    // Persisted as an append-only row.
    const rows = hookEvents.listByProject(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('PostToolUse');
    expect(rows[0].sessionId).toBe('s1');
  });

  it('rejects the daemon token (a project token is required)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DAEMON_TOKEN}` },
      body: JSON.stringify({ source: 'claude', eventType: 'PostToolUse', payload: '{}' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'claude', eventType: 'PostToolUse', payload: '{}' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a report missing source or eventType', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body: JSON.stringify({ source: 'claude' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a source with no registered adapter', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body: JSON.stringify({ source: 'codex', eventType: 'X', payload: '{}' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('daemon server hooks rules/dispatch/sessions API', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let settingsDir: string;
  let registry: HookRuleRegistry;
  let dispatches: HookDispatchRepository;
  let sessions: SessionRepository;
  let projectId: number;

  const auth = { authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json' };
  const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: auth });
  const post = (p: string, body: unknown, method = 'POST') =>
    fetch(`http://127.0.0.1:${port}${p}`, { method, headers: auth, body: JSON.stringify(body) });

  beforeAll(async () => {
    settingsDir = await mkdtemp(path.join(tmpdir(), 'weave-hooks-api-'));
    setDaemonSettingsDir(settingsDir);
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectId = projects.register({ path: '/api-proj', name: 'p', token: PROJECT_TOKEN, source: 'init' }).id;
    const hookEvents = new HookEventRepository(db);
    registry = new HookRuleRegistry(new HookRuleRepository(db));
    dispatches = new HookDispatchRepository(db);
    sessions = new SessionRepository(db);
    const bus = new HookEventBus();
    const dispatcher = new HookDispatcher({
      registry,
      dispatches,
      bus,
      projects,
      sessions,
    });
    server = createWeaveServer({
      projects,
      daemonToken: DAEMON_TOKEN,
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
    setDaemonSettingsDir(null);
  });

  it('未带 daemon token 的规则请求 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/rules`);
    expect(res.status).toBe(401);
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

  it('ingest 响应路径执行规则：inject 命中时 201 body 带 additionalContext', async () => {
    const created = await post('/hooks/rules', {
      name: 'inject-in-ingest',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'inject', template: 'do {event}' },
    });
    const { rule } = (await created.json()) as { rule: { id: string } };

    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body: JSON.stringify({
        source: 'claude',
        eventType: 'PostToolUse',
        sessionId: 'sess-api',
        payload: JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: '/api-proj/docs/x.md' },
        }),
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: number; additionalContext?: string };
    expect(data.additionalContext).toContain('do PostToolUse');
    expect(data.additionalContext).toContain('<!--weave-dispatch-->');

    // 派发记录可查
    const list = (await (await get(`/hooks/dispatches?ruleId=${rule.id}`)).json()) as {
      dispatches: Array<{ status: string; sessionId: string }>;
    };
    expect(list.dispatches).toHaveLength(1);
    expect(list.dispatches[0]).toMatchObject({ status: 'injected', sessionId: 'sess-api' });

    await post(`/hooks/rules/${rule.id}`, null, 'DELETE');
  });

  it('每条采集事件都经 SSE 推出 event.ingested 帧（任务面板实时刷新源）', async () => {
    const ctrl = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events?token=${DAEMON_TOKEN}`, {
        signal: ctrl.signal,
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // 流建立后再发事件（先连后发，避免帧早于订阅丢失）
      const post = await fetch(`http://127.0.0.1:${port}/hooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
        body: JSON.stringify({
          source: 'claude',
          eventType: 'PostToolUse',
          sessionId: 'sse-sess',
          payload: '{}',
        }),
      });
      expect(post.status).toBe(201);

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
    // 事件触发 touch
    await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body: JSON.stringify({ source: 'claude', eventType: 'Stop', sessionId: 'sess-rename', payload: '{}' }),
    });

    const list = (await (await get('/sessions')).json()) as {
      sessions: Array<{ sessionId: string; pendingTitle: string | null }>;
    };
    const row = list.sessions.find((s) => s.sessionId === 'sess-rename');
    expect(row).toBeDefined();
    expect(row!.pendingTitle).toBeNull();

    const renamed = await post('/sessions/sess-rename', { title: '新标题' }, 'PATCH');
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { session: { pendingTitle: string } }).session.pendingTitle).toBe('新标题');

    expect((await post('/sessions/nope', { title: 'x' }, 'PATCH')).status).toBe(404);
    expect((await post('/sessions/sess-rename', { title: '' }, 'PATCH')).status).toBe(400);
  });
});
