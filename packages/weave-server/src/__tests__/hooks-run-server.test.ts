import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookRuleRepository } from '../repositories/hook-rules.js';
import { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import { SessionRepository } from '../repositories/sessions.js';
import { HookEventBus } from '../hooks/bus.js';
import { HookRuleRegistry } from '../hooks/registry.js';
import { ResumeRunner, type SpawnLike } from '../hooks/resume-runner.js';
import { createWeaveServer } from '../daemon/server.js';

const SESSION_ID = 'sess-run';

/** 结构上满足 SpawnChild 的假子进程（不真调 claude）。 */
class FakeChild extends EventEmitter {
  readonly pid = 7777;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

describe('daemon server POST /hooks/dispatches/:id/run', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let dispatches: HookDispatchRepository;
  let ruleId: string;
  let children: FakeChild[];
  let spawnArgs: Array<readonly string[]>;
  let pendingId: number;

  const auth = { 'content-type': 'application/json' };
  const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: auth });
  const runPost = (id: number, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/hooks/dispatches/${id}/run`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const project = projects.register({
      path: '/run-proj',
      name: 'run',
      token: 'rtoken',
      source: 'init',
    });
    const sessions = new SessionRepository(db);
    sessions.touch(SESSION_ID, project.id);
    dispatches = new HookDispatchRepository(db);
    const rule = new HookRuleRepository(db).create({
      name: 'run-rule',
      projectId: null,
      source: { kind: 'claude-event', event: 'PostToolUse' },
      handler: { type: 'manual', template: 'go' },
    });
    ruleId = rule.id;
    pendingId = dispatches.insert({
      ruleId,
      sessionId: SESSION_ID,
      prompt: '跑一次',
      status: 'pending',
      mode: 'manual',
    }).id;

    const bus = new HookEventBus();
    children = [];
    spawnArgs = [];
    const spawnImpl: SpawnLike = (_cmd, args) => {
      spawnArgs.push(args);
      const child = new FakeChild();
      children.push(child);
      return child;
    };
    const runner = new ResumeRunner({
      dispatches,
      sessions,
      projects,
      bus,
      spawnImpl,
      claudeBin: 'fake-claude',
    });
    // 不带 hookDispatcher：run 端点不依赖 dispatcher，也不读 daemon settings。
    server = createWeaveServer({
      projects,
      port: 0,
      hookRegistry: new HookRuleRegistry(new HookRuleRepository(db)),
      hookDispatches: dispatches,
      hookSessions: sessions,
      hookBus: bus,
      hookRunner: runner,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  it('body 缺 sessionId → 400', async () => {
    const res = await runPost(pendingId, {});
    expect(res.status).toBe(400);
  });

  it('未知 dispatch → 404', async () => {
    const res = await runPost(9999, { sessionId: SESSION_ID });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('Dispatch');
  });

  it('running 的 dispatch → 409', async () => {
    const runningId = dispatches.insert({
      ruleId,
      sessionId: SESSION_ID,
      prompt: '已在跑',
      status: 'pending',
      mode: 'manual',
    }).id;
    dispatches.updateStatus(runningId, { status: 'running' });
    const res = await runPost(runningId, { sessionId: SESSION_ID });
    expect(res.status).toBe(409);
    // 校验失败的请求不应触发 spawn
    expect(children).toHaveLength(0);
  });

  it('成功：200 已启动，异步执行到 succeeded 后 GET 可见', async () => {
    const res = await runPost(pendingId, { sessionId: SESSION_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dispatchId: pendingId });

    expect(children).toHaveLength(1);
    expect(spawnArgs[0]).toEqual(['--resume', SESSION_ID, '-p', '跑一次']);

    children[0]!.stdout.emit('data', Buffer.from('run 输出'));
    children[0]!.emit('exit', 0, null);

    await vi.waitFor(
      async () => {
        const list = (await (await get('/hooks/dispatches?status=succeeded')).json()) as {
          dispatches: Array<{ id: number; status: string; output: string | null }>;
        };
        const row = list.dispatches.find((d) => d.id === pendingId);
        expect(row).toBeDefined();
        expect(row!.status).toBe('succeeded');
        expect(row!.output).toContain('run 输出');
      },
      { timeout: 2000 },
    );
  });
});
