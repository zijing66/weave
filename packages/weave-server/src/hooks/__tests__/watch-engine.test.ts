import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { SessionWatchRepository, type SessionWatchRow } from '../../repositories/session-watches.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { HookEventBus, type HookBusMessage } from '../bus.js';
import { WatchEngine } from '../watch-engine.js';
import type { SendInput, SendResult } from '../message-deliverer.js';

/**
 * 空闲订阅引擎回归：one-shot fire 三路径（onEvent / created / sweepTerminated）、
 * CAS 防双 fire、watcher 分流（dashboard → watch.fired 帧；会话 → inject 投递）。
 */

let db: DatabaseSync;
let sessions: SessionRepository;
let watches: SessionWatchRepository;
let events: HookEventRepository;
let projectId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  projectId = new ProjectRepository(db).register({
    path: '/p',
    name: 'p',
    token: 't',
    source: 'init',
  }).id;
  sessions = new SessionRepository(db);
  watches = new SessionWatchRepository(db);
  events = new HookEventRepository(db);
});

afterEach(() => db.close());

const seed = (sessionId: string, eventTypes: string[]): void => {
  sessions.touch(sessionId, projectId);
  for (const eventType of eventTypes) {
    events.insert({ projectId, source: 'claude', eventType, sessionId, payload: '{}' });
  }
};

const deliverer = () => {
  const send = vi.fn(
    async (_input: SendInput): Promise<SendResult> => ({ ok: true, messageId: 1, status: 'injected' }),
  );
  return { send };
};

const framesOf = (bus: HookEventBus): HookBusMessage[] => {
  const seen: HookBusMessage[] = [];
  bus.subscribe((m) => {
    if (m.kind === 'watch.fired') seen.push(m);
  });
  return seen;
};

/** 场景基座：目标 a（已 Stop = 空闲）、会话订阅方 w、dashboard 订阅方置空。 */
const setup = () => {
  seed('a', ['SessionStart', 'UserPromptSubmit', 'Stop']);
  seed('w', ['SessionStart', 'UserPromptSubmit']);
  const bus = new HookEventBus();
  const d = deliverer();
  const engine = new WatchEngine({ watches, deliverer: d, sessions, bus });
  return { bus, d, engine, frames: framesOf(bus) };
};

describe('onEvent：ingest 命中 idleSignals', () => {
  it('Stop 命中 → dashboard 订阅仅发 watch.fired 帧，不投递', () => {
    const { engine, frames, d } = setup();
    const watch = watches.insert({ watcherSessionId: null, targetSessionId: 'a', notify: null });
    engine.onEvent({ sessionId: 'a', eventType: 'Stop', source: 'claude' });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'watch.fired', watchId: watch.id, targetSessionId: 'a', watcherSessionId: null });
    expect(d.send).not.toHaveBeenCalled();
    expect(watches.getById(watch.id)?.firedAt).not.toBeNull();
  });

  it('会话订阅 → inject 投递（fromSessionId=目标，notify 缺省含 trigger=watch:）', () => {
    const { engine, d } = setup();
    const watch = watches.insert({ watcherSessionId: 'w', targetSessionId: 'a', notify: null });
    engine.onEvent({ sessionId: 'a', eventType: 'Stop', source: 'claude' });
    expect(d.send).toHaveBeenCalledTimes(1);
    const input = d.send.mock.calls[0]![0] as SendInput;
    expect(input).toMatchObject({ toSessionId: 'w', fromKind: 'session', fromSessionId: 'a', mode: 'inject' });
    expect(input.text).toContain('trigger=watch:a');
    expect(watches.getById(watch.id)?.firedAt).not.toBeNull();
  });

  it('自定义 notify 文本原样投递', () => {
    const { engine, d } = setup();
    watches.insert({ watcherSessionId: 'w', targetSessionId: 'a', notify: '你的活好了' });
    engine.onEvent({ sessionId: 'a', eventType: 'Stop', source: 'claude' });
    expect((d.send.mock.calls[0]![0] as SendInput).text).toBe('你的活好了');
  });

  it('缺省文案用目标 title（无 title 回落 id 前 8 位）', () => {
    const { engine, d } = setup();
    seed('untitled', ['SessionStart', 'UserPromptSubmit', 'Stop']);
    watches.insert({ watcherSessionId: 'w', targetSessionId: 'untitled', notify: null });
    engine.onEvent({ sessionId: 'untitled', eventType: 'Stop', source: 'claude' });
    const text = (d.send.mock.calls[0]![0] as SendInput).text;
    expect(text).toContain('untitled'.slice(0, 8));
  });

  it('非 idleSignal 事件（UserPromptSubmit）不 fire', () => {
    const { engine, frames, d } = setup();
    watches.insert({ watcherSessionId: null, targetSessionId: 'a', notify: null });
    engine.onEvent({ sessionId: 'a', eventType: 'UserPromptSubmit', source: 'claude' });
    expect(frames).toHaveLength(0);
    expect(d.send).not.toHaveBeenCalled();
  });

  it('codex 事件源（idleSignals 空）不 fire——判据来自事件源面，不散写事件名', () => {
    const { engine, frames } = setup();
    watches.insert({ watcherSessionId: null, targetSessionId: 'a', notify: null });
    engine.onEvent({ sessionId: 'a', eventType: 'Stop', source: 'codex' });
    expect(frames).toHaveLength(0);
  });

  it('CAS：同批 Stop+SessionEnd 只 fire 一次（帧/投递各一）', () => {
    const { engine, frames, d } = setup();
    watches.insert({ watcherSessionId: 'w', targetSessionId: 'a', notify: null });
    engine.onEvent({ sessionId: 'a', eventType: 'Stop', source: 'claude' });
    engine.onEvent({ sessionId: 'a', eventType: 'SessionEnd', source: 'claude' });
    expect(frames).toHaveLength(1);
    expect(d.send).toHaveBeenCalledTimes(1);
  });
});

describe('created：订阅落库即时段', () => {
  it('目标此刻已空闲（turnOpen false）→ 立即 fire', () => {
    const { engine, frames } = setup();
    const watch = watches.insert({ watcherSessionId: null, targetSessionId: 'a', notify: null });
    engine.created(watch);
    expect(frames).toHaveLength(1);
  });

  it('目标回合开着 → 留 pending 等 ingest', () => {
    const { engine, frames } = setup();
    const watch = watches.insert({ watcherSessionId: null, targetSessionId: 'w', notify: null });
    engine.created(watch);
    expect(frames).toHaveLength(0);
    expect(watches.getById(watch.id)?.firedAt).toBeNull();
  });
});

describe('sweepTerminated：补射', () => {
  it('注册表判死（liveness false）→ 补 fire', () => {
    const bus = new HookEventBus();
    const d = deliverer();
    const engine = new WatchEngine({
      watches,
      deliverer: d,
      sessions,
      bus,
      livenessOf: () => new Map([['a', false]]),
    });
    watches.insert({ watcherSessionId: null, targetSessionId: 'a', notify: null });
    const fired = engine.sweepTerminated();
    expect(fired).toBe(1);
    expect(watches.listPending()).toHaveLength(0);
  });

  it('判不动（liveness true）→ 不动', () => {
    seed('a', ['SessionStart', 'UserPromptSubmit']);
    const bus = new HookEventBus();
    const d = deliverer();
    const engine = new WatchEngine({
      watches,
      deliverer: d,
      sessions,
      bus,
      livenessOf: () => new Map([['a', true]]),
    });
    watches.insert({ watcherSessionId: null, targetSessionId: 'a', notify: null });
    expect(engine.sweepTerminated()).toBe(0);
    expect(watches.listPending()).toHaveLength(1);
  });

  it('目标行已消失（等待不可解）→ fire', () => {
    const bus = new HookEventBus();
    const engine = new WatchEngine({
      watches,
      deliverer: deliverer(),
      sessions,
      bus,
      livenessOf: () => new Map(),
    });
    watches.insert({ watcherSessionId: null, targetSessionId: 'gone', notify: null });
    expect(engine.sweepTerminated()).toBe(1);
  });

  it('codex 目标（无登记不猜）→ 不动', () => {
    const bus = new HookEventBus();
    const d = deliverer();
    const engine = new WatchEngine({
      watches,
      deliverer: d,
      sessions,
      bus,
      livenessOf: () => new Map(),
    });
    sessions.touch('cx', projectId);
    events.insert({ projectId, source: 'codex', eventType: 'SessionStart', sessionId: 'cx', payload: '{}' });
    watches.insert({ watcherSessionId: null, targetSessionId: 'cx', notify: null });
    expect(engine.sweepTerminated()).toBe(0);
  });
});

describe('SessionWatchRepository（in-memory 直覆盖）', () => {
  it('insert 回填整行；listPendingByTarget/listPending 只见未 fire', () => {
    seed('a', ['SessionStart']);
    const w1 = watches.insert({ watcherSessionId: null, targetSessionId: 'a', notify: null });
    const w2 = watches.insert({ watcherSessionId: 'w', targetSessionId: 'a', notify: 'n' });
    expect(w1.id).toBeGreaterThan(0);
    expect(watches.listPendingByTarget('a')).toHaveLength(2);
    expect(watches.markFired(w1.id)).toBe(true);
    expect(watches.markFired(w1.id)).toBe(false); // CAS：已 fire 不再翻
    expect(watches.listPendingByTarget('a')).toMatchObject([{ id: w2.id }]);
    expect(watches.listPending()).toHaveLength(1);
  });

  it('deleteBySession 双端清理；deleteById 幂等', () => {
    const w = watches.insert({ watcherSessionId: 'w', targetSessionId: 'a', notify: null });
    watches.insert({ watcherSessionId: null, targetSessionId: 'w', notify: null });
    expect(watches.deleteBySession('w')).toBe(2);
    expect(watches.getById(w.id)).toBeUndefined();
    expect(watches.deleteById(w.id)).toBe(false);
  });
});
