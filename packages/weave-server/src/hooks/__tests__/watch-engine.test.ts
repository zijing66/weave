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

  it('reason 随帧回带：turnEnd 订阅在 Stop 上 == turnEnd，空闲订阅在 SessionEnd 上 == idle', () => {
    const { engine, frames } = setup();
    watches.insert({
      watcherSessionId: null,
      targetSessionId: 'a',
      notify: null,
      onEvents: ['turnEnd'],
    });
    watches.insert({
      watcherSessionId: null,
      targetSessionId: 'a',
      notify: null,
      onEvents: ['idle'],
    });
    engine.onEvent({ sessionId: 'a', eventType: 'Stop', source: 'claude' });
    expect(frames[0]).toMatchObject({ reason: 'turnEnd' });
    engine.onEvent({ sessionId: 'a', eventType: 'SessionEnd', source: 'claude' });
    expect(frames[1]).toMatchObject({ reason: 'idle' });
  });

  it('turnEnd 订阅不认 SessionEnd（只听一轮对话结束，HARNESS_LIFECYCLE.close）', () => {
    const { engine, frames } = setup();
    const watch = watches.insert({
      watcherSessionId: null,
      targetSessionId: 'a',
      notify: null,
      onEvents: ['turnEnd'],
    });
    engine.onEvent({ sessionId: 'a', eventType: 'SessionEnd', source: 'claude' });
    expect(frames).toHaveLength(0);
    expect(watches.getById(watch.id)?.firedAt).toBeNull();
  });
});

describe('messageFailed：投递失败/超时', () => {
  const finished = (
    bus: HookEventBus,
    sessionId: string,
    status: 'succeeded' | 'failed' | 'timeout',
  ): void => {
    bus.emit({ kind: 'message.finished', messageId: 'm-1', sessionId, status, at: 'now' });
  };

  it('failed/timeout → fire（reason=messageFailed）；succeeded 不 fire', () => {
    const { bus, engine, frames } = setup();
    watches.insert({
      watcherSessionId: null,
      targetSessionId: 'a',
      notify: null,
      onEvents: ['messageFailed'],
    });
    finished(bus, 'a', 'succeeded');
    expect(frames).toHaveLength(0);
    finished(bus, 'a', 'failed');
    expect(frames[0]).toMatchObject({ reason: 'messageFailed', targetSessionId: 'a' });
    // 已 fire（one-shot）：再来的 timeout 不再响
    finished(bus, 'a', 'timeout');
    expect(frames).toHaveLength(1);
  });

  it('消息终态属别的会话 → 不 fire', () => {
    const { bus, engine, frames } = setup();
    const watch = watches.insert({
      watcherSessionId: null,
      targetSessionId: 'a',
      notify: null,
      onEvents: ['messageFailed'],
    });
    finished(bus, 'w', 'failed');
    expect(frames).toHaveLength(0);
    expect(watches.getById(watch.id)?.firedAt).toBeNull();
  });

  it('纯投递类订阅不参与即时段与 terminated 补射（等的是投递事件）', () => {
    const { bus, engine, frames } = setup();
    const watch = watches.insert({
      watcherSessionId: null,
      targetSessionId: 'a', // a 已 Stop = 空闲
      notify: null,
      onEvents: ['messageFailed'],
    });
    engine.created(watch);
    expect(frames).toHaveLength(0);

    const dead = new WatchEngine({
      watches,
      deliverer: deliverer(),
      sessions,
      bus,
      livenessOf: () => new Map([['a', false]]),
    });
    expect(dead.sweepTerminated()).toBe(0);
    expect(watches.getById(watch.id)?.firedAt).toBeNull();
  });

  it('会话订阅（watcher）缺省文案按 reason 措辞', () => {
    const { bus, engine, d } = setup();
    watches.insert({
      watcherSessionId: 'w',
      targetSessionId: 'a',
      notify: null,
      onEvents: ['messageFailed'],
    });
    finished(bus, 'a', 'timeout');
    expect((d.send.mock.calls[0]![0] as SendInput).text).toContain('failed message delivery');
  });
});

describe('提醒次数：一次（计数）与持久化', () => {
  it('次数订阅：跨已选类型共享一个计数，用尽即失效', () => {
    vi.useFakeTimers();
    try {
      const { bus, engine, frames } = setup();
      const watch = watches.insert({
        watcherSessionId: null,
        targetSessionId: 'a',
        notify: null,
        onEvents: ['turnEnd', 'messageFailed'],
        times: 2,
      });
      engine.onEvent({ sessionId: 'a', eventType: 'Stop', source: 'claude' }); // 第 1 次（turnEnd）
      vi.advanceTimersByTime(5_000);
      bus.emit({ kind: 'message.finished', messageId: 'm-1', sessionId: 'a', status: 'failed', at: 'now' });
      expect(frames).toHaveLength(2); // 第 2 次（messageFailed）——同一计数
      vi.advanceTimersByTime(5_000);
      engine.onEvent({ sessionId: 'a', eventType: 'Stop', source: 'claude' });
      expect(frames).toHaveLength(2); // 次数用尽：不再提醒
      expect(watches.getById(watch.id)?.firedAt).not.toBeNull();
      expect(watches.listPending()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('持久化订阅：每次命中都提醒、不落定', () => {
    vi.useFakeTimers();
    try {
      const { engine, frames } = setup();
      const watch = watches.insert({
        watcherSessionId: null,
        targetSessionId: 'a',
        notify: null,
        times: null,
      });
      engine.onEvent({ sessionId: 'a', eventType: 'Stop', source: 'claude' });
      vi.advanceTimersByTime(5_000);
      engine.onEvent({ sessionId: 'a', eventType: 'Stop', source: 'claude' });
      expect(frames).toHaveLength(2);
      expect(watches.getById(watch.id)?.firedAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    expect(w1.remaining).toBe(1); // 缺省一次
    expect(watches.listPendingByTarget('a')).toHaveLength(2);
    expect(watches.consumeHit(w1.id)).not.toBeNull();
    expect(watches.consumeHit(w1.id)).toBeNull(); // 次数耗尽：不再命中
    expect(watches.listPendingByTarget('a')).toMatchObject([{ id: w2.id }]);
    expect(watches.listPending()).toHaveLength(1);
  });

  it('consumeHit：单条 UPDATE 原子减一、归零落 fired_at；持久化（null）永不落定', () => {
    const counted = watches.insert({
      watcherSessionId: null,
      targetSessionId: 'a',
      notify: null,
      times: 2,
    });
    expect(watches.consumeHit(counted.id)).toMatchObject({ remaining: 1, firedAt: null });
    const last = watches.consumeHit(counted.id);
    expect(last).toMatchObject({ remaining: 0 });
    expect(last!.firedAt).not.toBeNull(); // 最后一次同时落定
    expect(watches.consumeHit(counted.id)).toBeNull();
    expect(watches.getById(counted.id)?.firedAt).not.toBeNull();
    // 原子性：并发已落定的行，重复命中不会把 remaining 扣成负数
    expect(watches.getById(counted.id)?.remaining).toBe(0);

    const forever = watches.insert({
      watcherSessionId: null,
      targetSessionId: 'a',
      notify: null,
      times: null,
    });
    expect(forever.remaining).toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(watches.consumeHit(forever.id)).toMatchObject({ remaining: null });
    }
    expect(watches.getById(forever.id)?.firedAt).toBeNull();
  });

  it('updateById：pending 行改类型集/次数（含转持久化 null）；已落定行拒绝改', () => {
    seed('a', ['SessionStart']);
    const w = watches.insert({
      watcherSessionId: null,
      targetSessionId: 'a',
      notify: null,
      onEvents: ['idle'],
      times: 1,
    });
    // 修改 = 改写原行（id 不动、不新增 pending 行）
    const updated = watches.updateById(w.id, { onEvents: ['idle', 'turnEnd'], remaining: 3 });
    expect(updated).toMatchObject({ id: w.id, remaining: 3, onEvents: ['idle', 'turnEnd'] });
    expect(watches.listPendingByTarget('a')).toHaveLength(1);
    // 次数可写回 null = 转持久化
    expect(watches.updateById(w.id, { remaining: null })).toMatchObject({ remaining: null });
    expect(watches.getById(w.id)?.firedAt).toBeNull();
    // 计数耗尽落定（fired_at 非空）后不可再改
    const one = watches.insert({ watcherSessionId: null, targetSessionId: 'a', notify: null });
    watches.consumeHit(one.id);
    expect(watches.getById(one.id)?.firedAt).not.toBeNull();
    expect(watches.updateById(one.id, { remaining: 5 })).toBeUndefined();
  });

  it('deleteBySession 双端清理；deleteById 幂等', () => {
    const w = watches.insert({ watcherSessionId: 'w', targetSessionId: 'a', notify: null });
    watches.insert({ watcherSessionId: null, targetSessionId: 'w', notify: null });
    expect(watches.deleteBySession('w')).toBe(2);
    expect(watches.getById(w.id)).toBeUndefined();
    expect(watches.deleteById(w.id)).toBe(false);
  });
});
