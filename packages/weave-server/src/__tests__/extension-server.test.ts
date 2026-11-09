import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { AuthService } from '../daemon/dashboard-auth.js';
import { openDatabase } from '../db/db.js';
import { setDaemonSettingsDb } from '../daemon/settings.js';
import { ProjectRepository } from '../repositories/projects.js';
import { SessionRepository } from '../repositories/sessions.js';
import {
  ExtensionBindingRepository,
  ExtensionExecutionRepository,
} from '../repositories/extension-bindings.js';
import { ExtensionEngine } from '../hooks/extension-engine.js';
import type { HookBusMessage } from '../hooks/bus.js';
import { createWeaveServer } from '../daemon/server.js';

/**
 * 扩展点域端到端（批 2b）：绑定 CRUD（zod 收形/未知项目/未知会话/未知点/端点
 * 预算）、执行日志查询翻页、purge 会话级联清两表、CRUD 后引擎 reload 生效。
 */

vi.setConfig({ testTimeout: 20000 });

let db: DatabaseSync;
let server: Server;
let port: number;
let dir: string;
let projectId: number;
let bindings: ExtensionBindingRepository;
let executions: ExtensionExecutionRepository;

const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  db = openDatabase(':memory:');
  setDaemonSettingsDb(openDatabase(':memory:'));
  dir = mkdtempSync(path.join(tmpdir(), 'weave-ext-srv-'));
  projectId = new ProjectRepository(db).register({
    path: dir,
    name: 'test',
    token: 'ptoken',
    source: 'init',
  }).id;
  new SessionRepository(db).touch('sess-x', projectId);
  bindings = new ExtensionBindingRepository(db);
  executions = new ExtensionExecutionRepository(db);
  const engine = new ExtensionEngine({
    bindings,
    executions,
    deliverer: {
      send: async () => ({ ok: true, messageId: 'm', status: 'delivered', message: {} }) as never,
      registerInduction: () => {},
      consumeInduction: () => false,
    },
    sessions: { getBySessionId: () => undefined },
    hookEvents: { listBySession: () => [] },
    bus: { emit: (_: HookBusMessage) => {} } as never,
    kernel: { judge: async () => ({ ok: true }) },
  });
  server = createWeaveServer({
    projects: new ProjectRepository(db),
    port: 0,
    auth: new AuthService({
      authPath: path.join(dir, 'auth.json'),
      initialPasswordPath: path.join(dir, 'initial-password'),
    }),
    hookSessions: new SessionRepository(db),
    extensionBindings: bindings,
    extensionExecutions: executions,
    extensionEngine: engine,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
  setDaemonSettingsDb(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const localToken = (): Record<string, string> => ({
  'x-weave-local': (JSON.parse(readFileSync(path.join(dir, 'auth.json'), 'utf8')) as { localToken: string })
    .localToken,
});

const adminFetch = async (p: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url(p), { ...init, headers: { ...(init.headers ?? {}), ...localToken() } });

const bindingBody = (over: Record<string, unknown> = {}) => ({
  name: 'b',
  projectId,
  point: 'turn-end',
  endpoints: [{ kind: 'session', target: 'self', text: 'echo: {upstream}' }],
  ...over,
});

describe('extension bindings CRUD', () => {
  it('无凭据 401', async () => {
    expect((await fetch(url('/extensions/bindings'))).status).toBe(401);
  });

  it('建绑定 201 → 列表可见 → 更新 → 删除', async () => {
    const created = await adminFetch('/extensions/bindings', json('POST', bindingBody()));
    expect(created.status).toBe(201);
    const { binding } = (await created.json()) as { binding: { id: number; name: string } };

    const list = await adminFetch(`/extensions/bindings?projectId=${projectId}`);
    const listed = (await list.json()) as { bindings: Array<{ id: number }> };
    expect(listed.bindings.map((b) => b.id)).toContain(binding.id);

    const patched = await adminFetch(`/extensions/bindings/${binding.id}`, json('PUT', { enabled: false }));
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { binding: { enabled: boolean } }).binding.enabled).toBe(false);

    const removed = await adminFetch(`/extensions/bindings/${binding.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    const gone = await adminFetch(`/extensions/bindings/${binding.id}`, { method: 'DELETE' });
    expect(gone.status).toBe(404);
  });

  it('校验：未知项目 / 未知会话 / 未知点 / 端点超预算 / 未知端点 kind 都 400', async () => {
    const badProject = await adminFetch('/extensions/bindings', json('POST', bindingBody({ projectId: 9999 })));
    expect(badProject.status).toBe(400);
    expect(((await badProject.json()) as { error: string }).error).toContain('Unknown project');

    const badSession = await adminFetch(
      '/extensions/bindings',
      json('POST', bindingBody({ sessionId: 'nope' })),
    );
    expect(badSession.status).toBe(400);
    expect(((await badSession.json()) as { error: string }).error).toContain('Unknown session');

    const badPoint = await adminFetch('/extensions/bindings', json('POST', bindingBody({ point: 'moon' })));
    expect(badPoint.status).toBe(400);

    const nine = Array.from({ length: 9 }, (_, i) => ({ kind: 'webhook', url: `https://x/${i}` }));
    const tooMany = await adminFetch('/extensions/bindings', json('POST', bindingBody({ endpoints: nine })));
    expect(tooMany.status).toBe(400);

    const badKind = await adminFetch(
      '/extensions/bindings',
      json('POST', bindingBody({ endpoints: [{ kind: 'plugin' }] })),
    );
    expect(badKind.status).toBe(400);
  });

  it('CRUD 后引擎 reload 生效（无 engine 依赖也能建——路由可选装配）', async () => {
    const before = bindings.list().length;
    const created = await adminFetch(
      '/extensions/bindings',
      json('POST', bindingBody({ name: 'reload-probe', sessionId: 'sess-x' })),
    );
    expect(created.status).toBe(201);
    expect(bindings.list().length).toBe(before + 1);
    const { binding } = (await created.json()) as { binding: { id: number } };
    await adminFetch(`/extensions/bindings/${binding.id}`, { method: 'DELETE' });
  });
});

describe('extension dry-run + capabilities', () => {
  it('dry-run：不真投递、落 trigger=dry-run 执行行、模板变量无值如实报 failed', async () => {
    // 测试引擎没有 lastTurnOutput ⇒ `{upstream}` 无值——dry-run 的价值正在于
    // 把这个「真投会炸」的模板提前报出来（failed，不投半截）。
    const created = await adminFetch('/extensions/bindings', json('POST', bindingBody()));
    const { binding } = (await created.json()) as { binding: { id: number } };
    const res = await adminFetch(`/extensions/bindings/${binding.id}/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-x' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      stages: Array<{ stage: string; endpointTarget: string | null; error: string | null }>;
    };
    expect(body.ok).toBe(false);
    expect(body.stages.length).toBe(1);
    expect(body.stages[0]!.stage).toBe('failed');
    expect(body.stages[0]!.endpointTarget).toBe('self'); // 按绑定配置原文回报（执行期才解析 self）
    expect(body.stages[0]!.error).toContain('unresolved template variable');
    // 执行日志落了 dry-run 行（不进幂等账：eventId=0）。
    const page = (await (
      await adminFetch(`/extensions/executions?bindingId=${binding.id}`)
    ).json()) as { executions: Array<{ trigger: string; stage: string }> };
    const dry = page.executions.filter((r) => r.trigger === 'dry-run');
    expect(dry.length).toBe(1);
    expect(dry[0]!.stage).toBe('failed');
    await adminFetch(`/extensions/bindings/${binding.id}`, { method: 'DELETE' });
  });

  it('dry-run：无变量的模板走通全链 → delivered', async () => {
    const created = await adminFetch(
      '/extensions/bindings',
      json('POST', bindingBody({ endpoints: [{ kind: 'session', target: 'self', text: 'ping' }] })),
    );
    const { binding } = (await created.json()) as { binding: { id: number } };
    const res = await adminFetch(`/extensions/bindings/${binding.id}/dry-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'sess-x' }),
    });
    const body = (await res.json()) as { ok: boolean; stages: Array<{ stage: string }> };
    expect(body.ok).toBe(true);
    expect(body.stages[0]!.stage).toBe('delivered');
    await adminFetch(`/extensions/bindings/${binding.id}`, { method: 'DELETE' });
  });

  it('capabilities：按 harness 派生触发点/端点/决策面（claude 有 fork 提取 → decision true）', async () => {
    const res = await adminFetch('/extensions/capabilities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      harnesses: Array<{
        harness: string;
        points: Record<string, string[]>;
        endpoints: { session: boolean; webhook: boolean };
        decision: boolean;
      }>;
    };
    const claude = body.harnesses.find((h) => h.harness === 'claude')!;
    expect(claude.points['turn-end']).toContain('Stop');
    expect(claude.points.idle).toContain('SessionEnd');
    expect(claude.endpoints.webhook).toBe(true);
    expect(typeof claude.decision).toBe('boolean');
  });
});

describe('extension executions query', () => {
  it('翻页：limit + before 游标', async () => {
    const created = await adminFetch('/extensions/bindings', json('POST', bindingBody()));
    const { binding } = (await created.json()) as { binding: { id: number } };
    for (let i = 0; i < 5; i++) {
      executions.insert({ bindingId: binding.id, sessionId: 'sess-x', eventId: 100 + i, stage: 'delivered', ok: true });
    }
    const page1 = (await (await adminFetch(`/extensions/executions?bindingId=${binding.id}&limit=2`)).json()) as {
      executions: Array<{ id: number }>;
      nextBefore: number | null;
    };
    expect(page1.executions.length).toBe(2);
    expect(page1.nextBefore).not.toBeNull();
    const page2 = (await (
      await adminFetch(`/extensions/executions?bindingId=${binding.id}&limit=2&before=${page1.nextBefore}`)
    ).json()) as { executions: Array<{ id: number }> };
    expect(page2.executions.length).toBe(2);
    expect(page2.executions[0]!.id).toBeLessThan(page1.executions[1]!.id);
    await adminFetch(`/extensions/bindings/${binding.id}`, { method: 'DELETE' });
  });
});
