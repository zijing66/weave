import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { SessionMessageRepository, type MessageStatus } from '../../repositories/session-messages.js';
import {
  SessionSequenceRepository,
  type SessionSequenceRow,
  type SequenceStep,
} from '../../repositories/session-sequences.js';
import { HookEventBus } from '../bus.js';
import { SEQUENCE_HOP_LIMIT, SequenceEngine } from '../sequence-engine.js';
import type { SendInput, SendResult } from '../message-deliverer.js';

/**
 * 跨会话序列引擎回归：双通道步完成（idle 事件 / message.finished 帧）、
 * cursor CAS 防重复推进、拒绝/同步失败落 failed、rearm 重启恢复、
 * sweepTerminated 补射与 repo 覆盖。
 */

let db: DatabaseSync;
let sessions: SessionRepository;
let messages: SessionMessageRepository;
let sequences: SessionSequenceRepository;
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
  messages = new SessionMessageRepository(db);
  sequences = new SessionSequenceRepository(db);
});

afterEach(() => db.close());

const seed = (sessionId: string): void => {
  sessions.touch(sessionId, projectId);
};

/**
 * 投递器 mock：真实落 message 行（引擎的 idle 匹配与终态补判都读行）。
 * status 缺省 injected；headless 路径用 status:'running'（行也置 running，
 * 终态由测试显式 emit message.finished 或预先置终态模拟同步失败）。
 */
const deliverer = (opts: { status?: MessageStatus; reject?: string } = {}) => {
  const send = vi.fn(async (input: SendInput): Promise<SendResult> => {
    if (opts.reject) return { ok: false, status: 400, error: opts.reject };
    const status = opts.status ?? 'injected';
    const row = messages.insert({
      fromKind: input.fromKind,
      fromSessionId: null,
      toSessionId: input.toSessionId,
      text: input.text,
      mode: input.mode,
      status: 'queued',
    });
    messages.updateStatus(row.id, { status, delivered: true });
    return { ok: true, messageId: row.id, status };
  });
  return { send };
};

/** 一步 = {to, text, mode}；mode 缺省 auto（engine/route 层才归一，测试显式给）。 */
const steps = (...defs: Array<[to: string, mode?: 'inject' | 'headless' | 'auto']>): SequenceStep[] =>
  defs.map(([to, mode]) => ({ to, text: `msg to ${to}`, mode: mode ?? 'auto' }));

/** 场景基座：三会话 a/b/c（claude），默认全通道 injected 的投递器。 */
const setup = (delivererOpts: { status?: MessageStatus; reject?: string } = {}) => {
  seed('a');
  seed('b');
  seed('c');
  const bus = new HookEventBus();
  const d = deliverer(delivererOpts);
  const engine = new SequenceEngine({ sequences, messages, deliverer: d, sessions, bus });
  const frames: Array<{ kind: string; [k: string]: unknown }> = [];
  bus.subscribe((m) => {
    if (m.kind === 'sequence.step' || m.kind === 'sequence.finished') frames.push(m);
  });
  return { bus, d, engine, frames };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const idleOf = (engine: SequenceEngine, sessionId: string): void => {
  engine.onEvent({ sessionId, eventType: 'Stop', source: 'claude' });
};

const finishedOf = (bus: HookEventBus, messageId: number, status: 'succeeded' | 'failed' | 'timeout'): void => {
  bus.emit({ kind: 'message.finished', messageId, sessionId: 'x', status, at: new Date().toISOString() });
};

describe('trigger 与步 0', () => {
  it('触发步 0：send 带 dashboard 身份 + messageId 回填 + sequence.step 帧', async () => {
    const { d, engine, frames } = setup();
    const row = sequences.insert({ name: 'chain', steps: steps(['a', 'inject']) });
    engine.trigger(row);
    await flush();
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send.mock.calls[0]![0]).toMatchObject({ toSessionId: 'a', fromKind: 'dashboard', mode: 'inject' });
    expect(sequences.getById(row.id)).toMatchObject({ status: 'running', cursor: 0 });
    expect(sequences.getById(row.id)!.steps[0]!.messageId).toBeGreaterThan(0);
    expect(frames[0]).toMatchObject({ kind: 'sequence.step', sequenceId: row.id, cursor: 0 });
  });

  it('send 拒绝 → 序列 failed 留错误 + sequence.finished 帧', async () => {
    const { engine, frames } = setup({ reject: 'Session not found' });
    const row = sequences.insert({ name: '', steps: steps(['a', 'inject']) });
    engine.trigger(row);
    await flush();
    const after = sequences.getById(row.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toContain('rejected: Session not found');
    expect(frames.at(-1)).toMatchObject({ kind: 'sequence.finished', status: 'failed' });
  });
});

describe('inject 步完成（idle 事件通道）', () => {
  it('两步链：a 空闲 → 推进 fire b', async () => {
    const { d, engine } = setup();
    const row = sequences.insert({ name: '', steps: steps(['a', 'inject'], ['b', 'inject']) });
    engine.trigger(row);
    await flush();
    idleOf(engine, 'a');
    await flush();
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(d.send.mock.calls[1]![0]).toMatchObject({ toSessionId: 'b' });
    expect(sequences.getById(row.id)).toMatchObject({ status: 'running', cursor: 1 });
  });

  it('末步目标空闲 → 序列 done', async () => {
    const { engine, frames } = setup();
    const row = sequences.insert({ name: '', steps: steps(['a', 'inject']) });
    engine.trigger(row);
    await flush();
    idleOf(engine, 'a');
    expect(sequences.getById(row.id)).toMatchObject({ status: 'done', cursor: 0 });
    expect(frames.at(-1)).toMatchObject({ kind: 'sequence.finished', status: 'done' });
  });

  it('未触发步（messageId 空）不响应 idle；headless 步（行 running）不响应 idle', async () => {
    const idleEngine = setup();
    const noFire = sequences.insert({ name: '', steps: steps(['a', 'inject']) });
    idleOf(idleEngine.engine, 'a');
    expect(idleEngine.d.send).not.toHaveBeenCalled();
    expect(sequences.getById(noFire.id)!.status).toBe('running');

    const headless = setup({ status: 'running' });
    const row = sequences.insert({ name: '', steps: steps(['a', 'headless']) });
    headless.engine.trigger(row);
    await flush();
    idleOf(headless.engine, 'a');
    expect(headless.d.send).toHaveBeenCalledTimes(1); // 只步 0，idle 不推进
    expect(sequences.getById(row.id)).toMatchObject({ status: 'running', cursor: 0 });
  });

  it('CAS：同批 Stop+SessionEnd 只推进一步', async () => {
    const { d, engine } = setup();
    const row = sequences.insert({ name: '', steps: steps(['a', 'inject'], ['b', 'inject']) });
    engine.trigger(row);
    await flush();
    idleOf(engine, 'a');
    idleOf(engine, 'a'); // 同批重复信号
    await flush();
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(sequences.getById(row.id)).toMatchObject({ cursor: 1 });
  });
});

describe('headless 步完成（message.finished 通道）', () => {
  it('succeeded → 推进；末步 → done', async () => {
    const { bus, engine, frames } = setup({ status: 'running' });
    const row = sequences.insert({ name: '', steps: steps(['a', 'headless']) });
    engine.trigger(row);
    await flush();
    const messageId = sequences.getById(row.id)!.steps[0]!.messageId!;
    finishedOf(bus, messageId, 'succeeded');
    expect(sequences.getById(row.id)).toMatchObject({ status: 'done' });
    expect(frames.at(-1)).toMatchObject({ kind: 'sequence.finished', status: 'done' });
  });

  it('failed → 序列失败带步号与状态', async () => {
    const { bus, engine } = setup({ status: 'running' });
    const row = sequences.insert({ name: '', steps: steps(['a', 'headless'], ['b', 'headless']) });
    engine.trigger(row);
    await flush();
    const messageId = sequences.getById(row.id)!.steps[0]!.messageId!;
    finishedOf(bus, messageId, 'timeout');
    const after = sequences.getById(row.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toBe('step 1 timeout');
  });

  it('同步失败（send 返回 running 但行已终态）→ fire 内即失败，不等帧', async () => {
    // 投递器落 running 行后立刻改 failed = isBusy 竞态/spawn throw 的形状
    const d = {
      send: vi.fn(async (input: SendInput): Promise<SendResult> => {
        const row = messages.insert({
          fromKind: input.fromKind, fromSessionId: null, toSessionId: input.toSessionId,
          text: input.text, mode: input.mode, status: 'queued',
        });
        messages.updateStatus(row.id, { status: 'failed', delivered: true });
        return { ok: true, messageId: row.id, status: 'running' };
      }),
    };
    seed('a');
    const bus = new HookEventBus();
    const engine = new SequenceEngine({ sequences, messages, deliverer: d, sessions, bus });
    const row = sequences.insert({ name: '', steps: steps(['a', 'headless']) });
    engine.trigger(row);
    await flush();
    expect(sequences.getById(row.id)).toMatchObject({ status: 'failed' });
    expect(sequences.getById(row.id)!.error).toContain('step 1 failed');
  });
});

describe('cancel', () => {
  it('running → cancelled + 帧；终态再取消被路由拒（engine 侧 CAS 不翻）', async () => {
    const { engine, frames } = setup();
    const row = sequences.insert({ name: '', steps: steps(['a', 'inject']) });
    engine.trigger(row);
    await flush();
    expect(engine.cancel(row.id)).toBe(true);
    expect(sequences.getById(row.id)).toMatchObject({ status: 'cancelled' });
    expect(frames.at(-1)).toMatchObject({ kind: 'sequence.finished', status: 'cancelled' });
    expect(engine.cancel(row.id)).toBe(false);
  });
});

describe('sweepTerminated：等待目标判死补射', () => {
  it('目标判死 → 序列 failed；判不动/行在 → 不动', async () => {
    const make = (liveness: () => Map<string, boolean>) => {
      seed('a');
      const bus = new HookEventBus();
      const engine = new SequenceEngine({
        sequences, messages, deliverer: deliverer(), sessions, bus, livenessOf: liveness,
      });
      return engine;
    };
    const dead = make(() => new Map([['a', false]]));
    const deadRow = sequences.insert({ name: '', steps: steps(['a', 'inject']) });
    dead.trigger(deadRow);
    await flush();
    expect(dead.sweepTerminated()).toBe(1);
    expect(sequences.getById(deadRow.id)!.status).toBe('failed');

    const alive = make(() => new Map([['a', true]]));
    const aliveRow = sequences.insert({ name: '', steps: steps(['a', 'inject']) });
    alive.trigger(aliveRow);
    await flush();
    expect(alive.sweepTerminated()).toBe(0);
    expect(sequences.getById(aliveRow.id)!.status).toBe('running');

    const gone = make(() => new Map());
    const goneRow = sequences.insert({ name: '', steps: steps(['ghost', 'inject']) });
    gone.trigger(goneRow);
    await flush();
    expect(gone.sweepTerminated()).toBe(1);
  });
});

describe('rearm：daemon 重启恢复', () => {
  const engineOn = (status: MessageStatus = 'injected') => {
    const bus = new HookEventBus();
    const d = deliverer({ status });
    const engine = new SequenceEngine({ sequences, messages, deliverer: d, sessions, bus });
    return { bus, d, engine };
  };

  it('injected 步 → 续等（rearm 后 idle 事件仍推进）', async () => {
    const first = engineOn();
    const row = sequences.insert({ name: '', steps: steps(['a', 'inject'], ['b', 'inject']) });
    first.engine.trigger(row);
    await flush();
    // 模拟重启：新引擎 + rearm，行还在 injected 等待
    const second = engineOn();
    second.engine.rearm();
    expect(second.d.send).not.toHaveBeenCalled(); // 不重发步 0
    idleOf(second.engine, 'a');
    await flush();
    expect(second.d.send).toHaveBeenCalledTimes(1);
    expect(sequences.getById(row.id)).toMatchObject({ status: 'running', cursor: 1 });
  });

  it('headless 步 running → 判失败（settle 回调已随旧进程死）', async () => {
    const first = engineOn('running');
    const row = sequences.insert({ name: '', steps: steps(['a', 'headless']) });
    first.engine.trigger(row);
    await flush();
    expect(sequences.getById(row.id)!.status).toBe('running');
    const second = engineOn();
    second.engine.rearm();
    expect(sequences.getById(row.id)).toMatchObject({ status: 'failed' });
    expect(sequences.getById(row.id)!.error).toContain('daemon restarted');
  });

  it('未触发步（messageId 空）→ 补 fire', async () => {
    sequences.insert({ name: '', steps: steps(['a', 'inject']) }); // 不 trigger 直接留库
    const { engine, d } = engineOn();
    engine.rearm();
    await flush();
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it('宕机窗口错过终态 → 按行终态补推进（succeeded → done）', async () => {
    const first = engineOn();
    const row = sequences.insert({ name: '', steps: steps(['a', 'headless']) });
    first.engine.trigger(row);
    await flush();
    // 模拟 finished 帧已丢：直接把消息行置 succeeded，行状态仍 running
    const messageId = sequences.getById(row.id)!.steps[0]!.messageId!;
    messages.updateStatus(messageId, { status: 'succeeded', finished: true });
    const second = engineOn();
    second.engine.rearm();
    expect(sequences.getById(row.id)).toMatchObject({ status: 'done' });
  });
});

describe('SessionSequenceRepository（in-memory 直覆盖）', () => {
  const rowOf = (id: number): SessionSequenceRow => sequences.getById(id)!;

  it('advanceCursor CAS：只有 running 且 cursor 命中才推', () => {
    const row = sequences.insert({ name: '', steps: steps(['a', 'inject'], ['b', 'inject']) });
    expect(sequences.advanceCursor(row.id, 0, 1)).toBe(true);
    expect(sequences.advanceCursor(row.id, 0, 1)).toBe(false); // 旧游标过期
    expect(rowOf(row.id).cursor).toBe(1);
    sequences.finish(row.id, 'failed', 'boom');
    expect(sequences.advanceCursor(row.id, 1, 2)).toBe(false); // 已终态
  });

  it('finish CAS：终态只落一次', () => {
    const row = sequences.insert({ name: '', steps: steps(['a', 'inject']) });
    expect(sequences.finish(row.id, 'done')).toBe(true);
    expect(sequences.finish(row.id, 'failed', 'late')).toBe(false);
    expect(rowOf(row.id)).toMatchObject({ status: 'done', error: null });
  });

  it('setStepMessage 回填；list/listRunning 过滤', () => {
    const a = sequences.insert({ name: 'n1', steps: steps(['a', 'inject']) });
    const b = sequences.insert({ name: 'n2', steps: steps(['a', 'inject']) });
    sequences.setStepMessage(a.id, 0, 42);
    expect(rowOf(a.id).steps[0]!.messageId).toBe(42);
    expect(sequences.listRunning()).toHaveLength(2);
    sequences.finish(b.id, 'done');
    expect(sequences.listRunning()).toHaveLength(1);
    expect(sequences.list()[0]!.id).toBe(b.id); // 新在前
    expect(sequences.list().map((r) => r.name)).toEqual(['n2', 'n1']);
  });

  it('deleteMentioning：任一步目标命中即删（会话/归档两入口同判据）', () => {
    const a = sequences.insert({ name: '', steps: steps(['a', 'inject']) });
    const ab = sequences.insert({ name: '', steps: steps(['a', 'inject'], ['b', 'inject']) });
    const c = sequences.insert({ name: '', steps: steps(['c', 'inject']) });
    expect(sequences.deleteMentioning(new Set(['b']))).toBe(1);
    expect(sequences.getById(ab.id)).toBeUndefined();
    expect(sequences.getById(a.id)).toBeDefined();
    expect(sequences.getById(c.id)).toBeDefined();
  });
});

describe('hop 上限常量', () => {
  it('SEQUENCE_HOP_LIMIT = 3（D5）', () => {
    expect(SEQUENCE_HOP_LIMIT).toBe(3);
  });
});
