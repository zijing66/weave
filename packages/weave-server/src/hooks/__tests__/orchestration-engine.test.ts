import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { setDaemonSettingsDb } from '../../daemon/settings.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import {
  OrchestrationRepository,
  OrchestrationRunRepository,
  type OrchestrationEdge,
} from '../../repositories/orchestrations.js';
import { HookEventBus } from '../bus.js';
import { OrchestrationEngine } from '../orchestration-engine.js';
import type { SendInput, SendResult, PipeMessage, PipeStatus } from '../message-deliverer.js';

/**
 * 编排引擎回归：起点投递记账、idle 消费一条即 fan-out 全部出边、两轮收尾、
 * 失败不增待回、判死才拉起终端、投递预算、cron 同分钟去重、rearm 落 interrupted、
 * sweepTerminated 丢弃死目标、收尾即清日志。
 */

let db: DatabaseSync;
let sessions: SessionRepository;
let orchestrations: OrchestrationRepository;
let runs: OrchestrationRunRepository;
let projectId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  setDaemonSettingsDb(openDatabase(':memory:'));
  projectId = new ProjectRepository(db).register({
    path: '/p',
    name: 'p',
    token: 't',
    source: 'init',
  }).id;
  sessions = new SessionRepository(db);
  orchestrations = new OrchestrationRepository(db);
  runs = new OrchestrationRunRepository(db);
});

afterEach(() => {
  setDaemonSettingsDb(null);
  db.close();
});

const edge = (from: string, to: string, id = `${from}-${to}`): OrchestrationEdge => ({
  id,
  from,
  to,
  text: `msg to ${to}`,
});

const deliverer = (opts: { status?: PipeStatus; reject?: string; offline?: string } = {}) => {
  let seq = 0;
  const send = vi.fn(async (input: SendInput): Promise<SendResult> => {
    if (opts.reject) return { ok: false, status: 400, error: opts.reject };
    const status = opts.status ?? 'delivered';
    const msg: PipeMessage = {
      id: `m-${++seq}`,
      sessionId: input.toSessionId,
      text: input.text,
      mode: input.mode,
      channel: 'prompt',
      status,
      at: new Date().toISOString(),
      ...(opts.offline ? { error: opts.offline, reason: 'offline' as const } : {}),
    };
    return { ok: true, messageId: msg.id, status, message: msg };
  });
  const awaitInboxReady = vi.fn(async () => true);
  return { send, awaitInboxReady };
};

const setup = (
  opts: {
    deliverer?: Parameters<typeof deliverer>[0];
    ensureOpen?: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    liveness?: Map<string, boolean>;
    maxDeliveries?: number;
  } = {},
) => {
  const bus = new HookEventBus();
  const d = deliverer(opts.deliverer);
  const ensureOpen = vi.fn(opts.ensureOpen ?? (async () => ({ ok: true }) as const));
  const engine = new OrchestrationEngine({
    orchestrations,
    runs,
    deliverer: d,
    sessions,
    bus,
    ensureOpen,
    livenessOf: () => opts.liveness ?? new Map(),
    ...(opts.maxDeliveries ? { maxDeliveries: opts.maxDeliveries } : {}),
  });
  const frames: Array<{ kind: string; [k: string]: unknown }> = [];
  bus.subscribe((m) => {
    if (m.kind.startsWith('orchestration.')) frames.push(m);
  });
  return { bus, d, engine, ensureOpen, frames };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const idleOf = (engine: OrchestrationEngine, sessionId: string): void => {
  engine.onEvent({ sessionId, eventType: 'Stop', source: 'claude' });
};

/** 一份 a→b、a→c 的图（起点 a）。 */
const fanOut = (name = 'fan'): number => {
  const row = orchestrations.insert({
    name,
    projectId,
    startSessionId: 'a',
    startText: 'kick off',
    nodes: ['a', 'b', 'c'],
    edges: [edge('a', 'b'), edge('a', 'c')],
  });
  return row.id;
};

describe('start：起点投递', () => {
  it('起点收到首条消息并计入待回，run 落 running', async () => {
    const { d, engine, frames } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const id = fanOut();
    const result = await engine.start(id, 'manual');
    expect(result).toMatchObject({ ok: true });
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send.mock.calls[0]![0]).toMatchObject({ toSessionId: 'a', mode: 'prompt' });
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run).toMatchObject({
      status: 'running',
      trigger: 'manual',
      deliveries: 1,
      orchestrationName: 'fan',
      projectId,
    });
    expect(run.state.pending.a).toHaveLength(1);
    expect(run.state.events[0]).toMatchObject({ from: '', to: 'a', ok: true });
    expect(frames[0]).toMatchObject({ kind: 'orchestration.run', status: 'running' });
    expect(frames.some((f) => f.kind === 'orchestration.delivery')).toBe(true);
  });

  it('同编排已有 running → 409（不叠跑）', async () => {
    const { engine } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const id = fanOut();
    await engine.start(id, 'manual');
    await expect(engine.start(id, 'manual')).resolves.toMatchObject({ ok: false, status: 409 });
  });

  it('载荷作为首步消息；空载荷回落配置文本', async () => {
    const { d, engine } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const id = fanOut();
    await engine.start(id, 'webhook', 'from payload');
    expect(d.send.mock.calls[0]![0].text).toBe('from payload');
    await engine.start(orchestrations.insert({
      name: 'n',
      projectId,
      startSessionId: 'a',
      startText: '',
      nodes: ['a'],
      edges: [],
    }).id, 'manual');
    expect(d.send.mock.calls[1]![0].text).toBe('n');
  });
});

describe('推进：idle 消费一条即 fan-out', () => {
  it('起点空闲 → 所有出边各投一次，起点待回清空', async () => {
    const { d, engine, frames } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const result = await engine.start(fanOut(), 'manual');
    idleOf(engine, 'a');
    await flush();
    expect(d.send).toHaveBeenCalledTimes(3);
    expect(d.send.mock.calls.slice(1).map((c) => c[0].toSessionId).sort()).toEqual(['b', 'c']);
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.state.pending.a).toHaveLength(0);
    expect(run.state.pending.b).toHaveLength(1);
    expect(run.state.pending.c).toHaveLength(1);
    expect(frames.filter((f) => f.kind === 'orchestration.delivery')).toHaveLength(3);
  });

  it('叶子回合完成 → 待回清空即 done', async () => {
    const { engine, frames } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const result = await engine.start(fanOut(), 'manual');
    idleOf(engine, 'a');
    await flush();
    idleOf(engine, 'b');
    idleOf(engine, 'c');
    await flush();
    expect(runs.getById((result as { runId: number }).runId)).toMatchObject({ status: 'done' });
    expect(frames.at(-1)).toMatchObject({ kind: 'orchestration.run', status: 'done' });
  });

  it('一条 idle 只消费一条：同会话两条待回要两次回合', async () => {
    const { d, engine } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    // a→b 与 a→c→b：b 会收两条
    const id = orchestrations.insert({
      name: 'two',
      projectId,
      startSessionId: 'a',
      startText: '',
      nodes: ['a', 'b', 'c'],
      edges: [edge('a', 'b'), edge('a', 'c'), edge('c', 'b')],
    }).id;
    const result = await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    idleOf(engine, 'c');
    await flush();
    expect(d.send).toHaveBeenCalledTimes(4); // a + b + c + b
    let run = runs.getById((result as { runId: number }).runId)!;
    expect(run.state.pending.b).toHaveLength(2);
    idleOf(engine, 'b');
    expect(runs.getById(run.id)!.state.pending.b).toHaveLength(1);
    idleOf(engine, 'b');
    await flush();
    expect(runs.getById(run.id)).toMatchObject({ status: 'done' });
  });
});

describe('失败路径', () => {
  it('send 拒绝 → 记失败事件、不增待回；全无成功即 failed', async () => {
    const { engine } = setup({ deliverer: { reject: 'Session not found' } });
    sessions.touch('a', projectId);
    const result = await engine.start(fanOut(), 'manual');
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Session not found');
    expect(run.state.pending).toEqual({});
    expect(run.state.events[0]).toMatchObject({ ok: false });
  });

  it('投递器判死（failed + offline）也算失败、不计待回', async () => {
    const { engine } = setup({ deliverer: { status: 'failed', offline: 'session offline' } });
    sessions.touch('a', projectId);
    const result = await engine.start(fanOut(), 'manual');
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.deliveries).toBe(0);
    expect(run.error).toContain('session offline');
  });

  it('判死才拉起终端；拉不起 → 不投递只记失败', async () => {
    const { d, engine, ensureOpen } = setup({
      ensureOpen: async () => ({ ok: false, error: 'resume unsupported' }),
      liveness: new Map([['a', false]]),
    });
    sessions.touch('a', projectId);
    const result = await engine.start(fanOut(), 'manual');
    expect(ensureOpen).toHaveBeenCalledWith('a');
    expect(d.send).not.toHaveBeenCalled();
    expect(d.awaitInboxReady).not.toHaveBeenCalled();
    expect(runs.getById((result as { runId: number }).runId)!.state.events[0]!.error).toContain(
      'resume unsupported',
    );
  });

  it('活着的会话不拉起终端', async () => {
    const { d, engine, ensureOpen } = setup({ liveness: new Map([['a', true]]) });
    sessions.touch('a', projectId);
    await engine.start(fanOut(), 'manual');
    expect(ensureOpen).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it('冷启动拉起的会话：等它的 inbox 凭据就位再投', async () => {
    const { d, engine } = setup({ liveness: new Map([['a', false]]) });
    sessions.touch('a', projectId);
    const result = await engine.start(fanOut(), 'manual');
    expect(d.awaitInboxReady).toHaveBeenCalledWith('a', expect.any(Number));
    expect(d.awaitInboxReady.mock.invocationCallOrder[0]!).toBeLessThan(
      d.send.mock.invocationCallOrder[0]!,
    );
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(runs.getById((result as { runId: number }).runId)!.deliveries).toBe(1);
  });

  it('活着的会话不白等凭据', async () => {
    const { d, engine } = setup({ liveness: new Map([['a', true]]) });
    sessions.touch('a', projectId);
    await engine.start(fanOut(), 'manual');
    expect(d.awaitInboxReady).not.toHaveBeenCalled();
  });

  it('投递预算：到顶即 failed（环路兜底）', async () => {
    const { engine } = setup({ maxDeliveries: 1 });
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const result = await engine.start(fanOut(), 'manual');
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('failed');
    expect(run.error).toContain('budget');
  });
});

describe('cronTick', () => {
  it('命中即触发、同分钟去重、跑着的跳过', async () => {
    const { engine } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const id = fanOut();
    orchestrations.update(id, { cron: '* * * * *' });
    const now = new Date('2026-03-05T09:30:20');
    expect(engine.cronTick(now)).toBe(1);
    await flush();
    // 同一分钟再来一拍：last_cron_at 已落，去重
    expect(engine.cronTick(new Date('2026-03-05T09:30:40'))).toBe(0);
    // 下一分钟：同编排还在跑 → 跳过
    expect(engine.cronTick(new Date('2026-03-05T09:31:00'))).toBe(0);
    expect(runs.listRunning()).toHaveLength(1);
  });
});

describe('重启与清扫', () => {
  it('rearm：running 一律 interrupted 且不重发', async () => {
    const { engine } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const result = await engine.start(fanOut(), 'manual');
    engine.rearm();
    expect(runs.getById((result as { runId: number }).runId)).toMatchObject({
      status: 'interrupted',
    });
    expect(runs.listRunning()).toHaveLength(0);
  });

  it('sweepTerminated：死目标拉不起来 → 丢弃待回并收尾', async () => {
    const liveness = new Map([['b', true]]);
    const { engine } = setup({ ensureOpen: async () => ({ ok: false, error: 'gone' }), liveness });
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const result = await engine.start(fanOut(), 'manual');
    idleOf(engine, 'a');
    await flush();
    liveness.set('b', false); // 投递之后死掉
    expect(engine.sweepTerminated()).toBe(1);
    await flush();
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.state.pending.b).toBeUndefined();
    expect(run.state.pending.c).toHaveLength(1);
    expect(run.state.events.some((e) => e.error?.includes('pending dropped'))).toBe(true);
  });
});
