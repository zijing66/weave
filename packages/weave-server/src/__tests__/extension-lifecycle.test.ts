import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { SessionRepository } from '../repositories/sessions.js';
import {
  ExtensionBindingRepository,
  ExtensionExecutionRepository,
} from '../repositories/extension-bindings.js';
import { ExtensionEngine, type ExtensionEventInput } from '../hooks/extension-engine.js';
import { purgeSession } from '../hooks/session-purge.js';
import type { HookBusMessage, HookEventBus } from '../hooks/bus.js';

/**
 * 生命周期（批 2b）：删会话级联清两表（项目级绑定不动）+ daemon 重启回放
 * （新引擎实例吃回放事件 → 陈旧闸拦超龄 → 幂等不重复扇出）。
 */

vi.setConfig({ testTimeout: 15000 });

let db: DatabaseSync;
let bindings: ExtensionBindingRepository;
let executions: ExtensionExecutionRepository;
let sessions: SessionRepository;
let sent: Array<{ toSessionId: string }>;
let frames: HookBusMessage[];

const settle = () => new Promise((r) => setTimeout(r, 5));

const deliverer = {
  send: async (input: { toSessionId: string }) => {
    sent.push(input);
    return { ok: true, messageId: 'm', status: 'delivered', message: {} } as never;
  },
  registerInduction: () => {},
  consumeInduction: () => false,
};

const baseInput = (over: Partial<ExtensionEventInput> = {}): ExtensionEventInput => ({
  sessionId: 'sess-a',
  source: 'claude',
  eventType: 'Stop',
  eventId: 101,
  projectId: 1,
  payload: { raw: { last_assistant_message: 'turn output' } },
  ...over,
});

const mkEngine = (over: Partial<ConstructorParameters<typeof ExtensionEngine>[0]> = {}) =>
  new ExtensionEngine({
    bindings,
    executions,
    deliverer,
    sessions: { getBySessionId: () => undefined },
    hookEvents: { listBySession: () => [] },
    bus: { emit: (m: HookBusMessage) => frames.push(m) } as unknown as HookEventBus,
    kernel: { judge: async () => ({ ok: true }) },
    ...over,
  });

beforeEach(() => {
  db = openDatabase(':memory:');
  new ProjectRepository(db).register({ path: 'C:/x/p', name: 'p', token: 'pt', source: 'init' });
  sessions = new SessionRepository(db);
  sessions.touch('sess-a', 1);
  bindings = new ExtensionBindingRepository(db);
  executions = new ExtensionExecutionRepository(db);
  sent = [];
  frames = [];
});

describe('删会话级联', () => {
  it('purge 清会话级绑定与执行行；项目级绑定不动', () => {
    bindings.insert({
      name: 'project',
      projectId: 1,
      sessionId: null,
      point: 'turn-end',
      endpoints: [{ kind: 'session', target: 'self', text: 'x' }],
    });
    bindings.insert({
      name: 'scoped',
      projectId: 1,
      sessionId: 'sess-a',
      point: 'turn-end',
      endpoints: [{ kind: 'session', target: 'self', text: 'x' }],
    });
    executions.insert({ bindingId: 1, sessionId: 'sess-a', eventId: 1, stage: 'delivered', ok: true });
    executions.insert({ bindingId: 2, sessionId: 'sess-a', eventId: 2, stage: 'delivered', ok: true });

    purgeSession(
      {
        sessions,
        events: { deleteBySession: () => 0 },
        extensionBindings: bindings,
        extensionExecutions: executions,
      },
      'sess-a',
    );

    const left = bindings.list().map((b) => b.name);
    expect(left).toEqual(['project']);
    expect(executions.query({}).rows.length).toBe(0);
  });

  it('purge 未装配扩展点时不炸（可选装配口径）', () => {
    expect(() =>
      purgeSession({ sessions, events: { deleteBySession: () => 0 } }, 'sess-a'),
    ).not.toThrow();
  });
});

describe('daemon 重启回放', () => {
  it('新引擎实例吃回放事件照常补执行；已 delivered 的端点不重复扇出', async () => {
    bindings.insert({
      name: 'b',
      projectId: 1,
      point: 'turn-end',
      endpoints: [{ kind: 'session', target: 'self', text: 'x' }],
    });
    const first = mkEngine();
    first.onEvent(baseInput());
    await vi.waitFor(() => expect(sent.length).toBe(1));
    await settle();

    // 重启：内存全空的新实例 + 同一事件（文件轴兜底回放）
    const replayed = mkEngine();
    replayed.onEvent(baseInput({ sessionId: 'other' }));
    await vi.waitFor(() => {
      const stages = executions.query({}).rows.map((r) => r.stage);
      expect(stages).toContain('skipped:duplicate');
    });
    expect(sent.length).toBe(1);
  });

  it('回放中超龄事件记 skipped:stale（陈旧闸）不执行', async () => {
    bindings.insert({
      name: 'b',
      projectId: 1,
      point: 'turn-end',
      endpoints: [{ kind: 'session', target: 'self', text: 'x' }],
    });
    // 停机期间积压的事件：事件时刻早于陈旧窗
    const engine = mkEngine();
    engine.onEvent(baseInput({ at: new Date(Date.now() - 30 * 60_000).toISOString() }));
    await vi.waitFor(() => {
      expect(executions.query({}).rows[0]!.stage).toBe('skipped:stale');
    });
    expect(sent.length).toBe(0);
  });

  it('settings 调大陈旧窗后同一超龄事件照常执行', async () => {
    bindings.insert({
      name: 'b',
      projectId: 1,
      point: 'turn-end',
      endpoints: [{ kind: 'session', target: 'self', text: 'x' }],
    });
    const engine = mkEngine({ staleMs: 60 * 60_000 });
    engine.onEvent(baseInput({ at: new Date(Date.now() - 30 * 60_000).toISOString() }));
    await vi.waitFor(() => expect(sent.length).toBe(1));
  });
});
