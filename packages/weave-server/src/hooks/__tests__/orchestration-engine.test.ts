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
  type OrchestrationNode,
} from '../../repositories/orchestrations.js';
import { HookEventBus } from '../bus.js';
import { OrchestrationEngine, parseConditionAnswer } from '../orchestration-engine.js';
import type { SendInput, SendResult, PipeMessage, PipeStatus } from '../message-deliverer.js';

/**
 * 编排引擎回归：入口投递记账（session 收首条 / webhook 载荷随边下发）、
 * idle 消费一条即 fan-out 全部出边、两轮收尾、失败不增待回、webhook 出口
 * 出站 POST、判死才拉起终端、投递预算、cron 同分钟去重、rearm 落 interrupted、
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

const sNode = (id: string): OrchestrationNode => ({ id, kind: 'session' });
const wNode = (id = 'w:1'): OrchestrationNode => ({ id, kind: 'webhook' });
const edge = (from: string, to: string, id = `${from}-${to}`): OrchestrationEdge => ({
  id,
  from,
  to,
  text: `msg to ${to}`,
});

const deliverer = (
  opts: {
    status?: PipeStatus;
    reject?: string;
    offline?: string;
    lastOutput?: { output: string; at: string };
  } = {},
) => {
  let seq = 0;
  let lastOutput = opts.lastOutput ?? null;
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
  const lastTurnOutput = vi.fn(() => lastOutput);
  const setLastOutput = (value: { output: string; at: string } | null): void => {
    lastOutput = value;
  };
  return { send, awaitInboxReady, lastTurnOutput, setLastOutput };
};

const setup = (
  opts: {
    deliverer?: Parameters<typeof deliverer>[0];
    ensureOpen?: (
      sessionId: string,
    ) => Promise<{ ok: true; ack?: 'session-start' | 'registry' } | { ok: false; error: string }>;
    liveness?: Map<string, boolean>;
    maxDeliveries?: number;
    supportsExtract?: (sessionId: string) => boolean;
    extract?: (input: { sessionId: string; prompt: string }) => Promise<string | null>;
    postJson?: (
      url: string,
      secret: string | undefined,
      body: unknown,
    ) => Promise<{ ok: boolean; status: string; error?: string }>;
  } = {},
) => {
  const bus = new HookEventBus();
  const d = deliverer(opts.deliverer);
  const ensureOpen = vi.fn(opts.ensureOpen ?? (async () => ({ ok: true }) as const));
  const postJson = vi.fn(
    opts.postJson ?? (async () => ({ ok: true, status: 'succeeded' }) as const),
  );
  const engine = new OrchestrationEngine({
    orchestrations,
    runs,
    deliverer: d,
    sessions,
    bus,
    ensureOpen,
    livenessOf: () => opts.liveness ?? new Map(),
    ...(opts.maxDeliveries ? { maxDeliveries: opts.maxDeliveries } : {}),
    ...(opts.supportsExtract ? { supportsExtract: opts.supportsExtract } : {}),
    ...(opts.extract ? { extract: opts.extract } : {}),
    postJsonImpl: postJson as never,
  });
  const frames: Array<{ kind: string; [k: string]: unknown }> = [];
  bus.subscribe((m) => {
    if (m.kind.startsWith('orchestration.')) frames.push(m);
  });
  return { bus, d, engine, ensureOpen, postJson, frames };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const idleOf = (engine: OrchestrationEngine, sessionId: string): void => {
  engine.onEvent({ sessionId, eventType: 'Stop', source: 'claude' });
};

/** 一份 a→b、a→c 的图（单 session 入口 a）。 */
const fanOut = (name = 'fan'): number =>
  orchestrations.insert({
    name,
    projectId,
    startText: 'kick off',
    nodes: [sNode('a'), sNode('b'), sNode('c')],
    edges: [edge('a', 'b'), edge('a', 'c')],
  }).id;

describe('start：入口投递', () => {
  it('缺省触发全部 session 入口；入口收首条并计入待回', async () => {
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
    await engine.start(
      orchestrations.insert({
        name: 'n',
        projectId,
        startText: '',
        nodes: [sNode('a')],
        edges: [],
      }).id,
      'manual',
    );
    expect(d.send.mock.calls[1]![0].text).toBe('n');
  });

  it('多 session 入口：缺省各收一条；entryIds 只挑选中的那些', async () => {
    const { d, engine } = setup();
    for (const id of ['a', 'x', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'two-entries',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('x'), sNode('b')],
      edges: [edge('a', 'b'), edge('x', 'b')],
    }).id;
    const first = await engine.start(id, 'manual');
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(d.send.mock.calls.map((c) => c[0].toSessionId).sort()).toEqual(['a', 'x']);

    // 同编排不叠跑：先收掉第一轮再选入口触发
    engine.cancel((first as { runId: number }).runId);
    await engine.start(id, 'manual', undefined, ['x']);
    expect(d.send).toHaveBeenCalledTimes(3);
    expect(d.send.mock.calls[2]![0].toSessionId).toBe('x');
  });

  it('entryIds 一个都没命中 → 409', async () => {
    const { engine } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const id = fanOut();
    await expect(engine.start(id, 'manual', undefined, ['nope'])).resolves.toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe('webhook 入口', () => {
  it('载荷随出边正文下发（正文空 = 只转发载荷），不向入口投消息', async () => {
    const { d, engine } = setup();
    sessions.touch('a', projectId);
    const id = orchestrations.insert({
      name: 'hook-in',
      projectId,
      startText: '',
      nodes: [wNode(), sNode('a'), sNode('b')],
      edges: [edge('w:1', 'a'), { ...edge('w:1', 'b'), text: '' }],
    }).id;
    await engine.start(id, 'webhook', 'payload', ['w:1']);
    const texts = d.send.mock.calls.map((c) => c[0].text);
    expect(texts).toContain(`msg to a\n\npayload`);
    expect(texts).toContain('payload');
  });

  it('webhook 入口不在 session 入口列表里：cron/缺省触发跳过它', async () => {
    const { d, engine } = setup();
    sessions.touch('a', projectId);
    const id = orchestrations.insert({
      name: 'hook-only-entry',
      projectId,
      startText: '',
      nodes: [wNode(), sNode('a')],
      edges: [edge('w:1', 'a')],
    }).id;
    await engine.start(id, 'manual'); // 缺省 = session 入口，此图没有 → 409
    expect(d.send).not.toHaveBeenCalled();
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
      startText: '',
      nodes: [sNode('a'), sNode('b'), sNode('c')],
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

describe('webhook 出口', () => {
  const exitGraph = (): number =>
    orchestrations.insert({
      name: 'hook-out',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), { id: 'w:9', kind: 'webhook', url: 'https://x/h', secret: 's3' }],
      edges: [edge('a', 'w:9')],
    }).id;

  it('出口节点出站 POST（带签名密钥与载荷），不判活不入 pending', async () => {
    const { d, engine, ensureOpen, postJson } = setup();
    sessions.touch('a', projectId);
    const result = await engine.start(exitGraph(), 'manual');
    idleOf(engine, 'a');
    await flush();
    expect(ensureOpen).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalledTimes(1); // 只有入口那条
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('done');
    expect(run.deliveries).toBe(2);
    expect(postJson).toHaveBeenCalledWith(
      'https://x/h',
      's3',
      expect.objectContaining({ text: 'msg to w:9' }),
    );
    expect(run.state.pending['w:9']).toBeUndefined(); // webhook 出口不入待回
    expect(run.state.events.at(-1)).toMatchObject({ to: 'w:9', ok: true });
  });

  it('POST 失败记失败事件，不影响 run 里其他成功投递', async () => {
    const { engine, postJson } = setup({
      postJson: async () => ({ ok: false, status: 'failed', error: 'HTTP 500' }),
    });
    sessions.touch('a', projectId);
    const result = await engine.start(exitGraph(), 'manual');
    idleOf(engine, 'a');
    await flush();
    expect(postJson).toHaveBeenCalled();
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('done'); // 入口投递成功即 done
    expect(run.state.events.at(-1)).toMatchObject({ to: 'w:9', ok: false, error: 'HTTP 500' });
  });
});

describe('边级提取与变量', () => {
  const AT = '2026-10-21T10:00:00.000Z';
  const graph = (edges: OrchestrationEdge[]): number =>
    orchestrations.insert({
      name: 'vars',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b'), sNode('c')],
      edges,
    }).id;

  it('{upstream}/{session} 渲染上游输出与会话名（无标题回落会话 id）', async () => {
    const { d, engine } = setup({
      deliverer: { lastOutput: { output: '上游结论', at: AT } },
    });
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    await engine.start(
      graph([
        { id: 'a-b', from: 'a', to: 'b', text: '给 {session}：{upstream}' },
        { id: 'a-c', from: 'a', to: 'c', text: 'plain' },
      ]),
      'manual',
    );
    idleOf(engine, 'a');
    await flush();
    const texts = d.send.mock.calls.map((c) => c[0].text);
    expect(texts).toContain('给 a：上游结论');
    expect(texts).toContain('plain');
  });

  it('extract：fork 提取结果填 {summary}；失败回落 {upstream}', async () => {
    const prompts: string[] = [];
    const { d, engine } = setup({
      deliverer: { lastOutput: { output: '上游原文', at: AT } },
      supportsExtract: (id) => id === 'a',
      extract: async (input) => {
        prompts.push(input.prompt);
        return input.prompt.includes('fail') ? null : '提炼后的交接说明';
      },
    });
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    await engine.start(
      graph([
        { id: 'a-b', from: 'a', to: 'b', text: '{summary}', extract: '请总结' },
        { id: 'a-c', from: 'a', to: 'c', text: '{summary}', extract: '请 fail' },
      ]),
      'manual',
    );
    idleOf(engine, 'a');
    await flush();
    expect(prompts).toEqual(['请总结', '请 fail']);
    const texts = d.send.mock.calls.map((c) => c[0].text);
    expect(texts).toContain('提炼后的交接说明');
    expect(texts).toContain('上游原文'); // 提取失败回落上游输出
  });

  it('不支持提取 → 不跑 fork，直接回落 {upstream}', async () => {
    const { d, engine } = setup({
      deliverer: { lastOutput: { output: '上游原文', at: AT } },
      supportsExtract: () => false,
      extract: async () => '不该被调用',
    });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    await engine.start(
      graph([{ id: 'a-b', from: 'a', to: 'b', text: '{summary}', extract: '请总结' }]),
      'manual',
    );
    idleOf(engine, 'a');
    await flush();
    expect(d.send.mock.calls.at(-1)![0].text).toBe('上游原文');
  });

  it('上游无输出且提取失败 → 占位残留记失败，不投半截模板', async () => {
    const { d, engine } = setup({
      supportsExtract: () => true,
      extract: async () => null,
    });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    await engine.start(
      orchestrations.insert({
        name: 'vars-fail',
        projectId,
        startText: 'go',
        nodes: [sNode('a'), sNode('b')],
        edges: [{ id: 'a-b', from: 'a', to: 'b', text: '结论：{summary}', extract: '请总结' }],
      }).id,
      'manual',
    );
    idleOf(engine, 'a');
    await flush();
    expect(d.send).toHaveBeenCalledTimes(1); // 只有起点那条
    const texts = d.send.mock.calls.map((c) => c[0].text);
    expect(texts.every((t) => !t.includes('结论：'))).toBe(true);
  });

  it('webhook 入口：{upstream} 引用载荷；模板没引用就拼在正文后', async () => {
    const { d, engine } = setup();
    sessions.touch('a', projectId);
    sessions.touch('b', projectId);
    await engine.start(
      orchestrations.insert({
        name: 'hook-vars',
        projectId,
        startText: '',
        nodes: [wNode(), sNode('a'), sNode('b')],
        edges: [
          { id: 'w-a', from: 'w:1', to: 'a', text: 'build {upstream}' },
          { id: 'w-b', from: 'w:1', to: 'b', text: '静态正文' },
        ],
      }).id,
      'webhook',
      'v1.2.3',
      ['w:1'],
    );
    const texts = d.send.mock.calls.map((c) => c[0].text);
    expect(texts).toContain('build v1.2.3');
    expect(texts).toContain('静态正文\n\nv1.2.3');
  });
});

describe('自然回合自动触发', () => {
  const AT = '2026-10-21T12:00:00.000Z';

  it('入口会话自然回合 → 下游直启（不向入口再投消息），{upstream} 是该轮输出', async () => {
    const { d, engine } = setup({ deliverer: { lastOutput: { output: '自然结论', at: AT } } });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    orchestrations.insert({
      name: 'auto',
      projectId,
      startText: 'unused',
      nodes: [sNode('a'), sNode('b')],
      edges: [{ id: 'a-b', from: 'a', to: 'b', text: '交给 {session}：{upstream}' }],
    });
    idleOf(engine, 'a'); // 没有任何 start()：自然回合完成
    await flush();
    expect(d.send).toHaveBeenCalledTimes(1); // 只有下游，入口没被塞消息
    expect(d.send.mock.calls[0]![0]).toMatchObject({
      toSessionId: 'b',
      text: '交给 a：自然结论',
    });
  });

  it('编排投递产生的回合不触发别的编排（会话级判据，跨 run）', async () => {
    const { d, engine } = setup({ deliverer: { lastOutput: { output: 'x', at: AT } } });
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    // 编排 X：a → c（a 是中间节点）
    orchestrations.insert({
      name: 'x',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('c')],
      edges: [edge('a', 'c')],
    });
    // 编排 Y：a 为入口
    orchestrations.insert({
      name: 'y',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [edge('a', 'b')],
    });
    const x = await engine.start(
      orchestrations.list().find((o) => o.name === 'x')!.id,
      'manual',
    );
    expect(x).toMatchObject({ ok: true });
    const sendsBefore = d.send.mock.calls.length;
    idleOf(engine, 'a'); // 这一轮是编排 X 投递驱动的
    await flush();
    // X 消费 pending → fan-out 到 c；Y 不起跑
    expect(runs.listRunning().some((r) => r.orchestrationName === 'y')).toBe(false);
    expect(d.send.mock.calls.length).toBe(sendsBefore + 1);
    expect(d.send.mock.calls.at(-1)![0].toSessionId).toBe('c');
  });

  it('enabled=false / 孤立入口 / 冷却期内连拍都不触发', async () => {
    const { d, engine } = setup();
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    const off = orchestrations.insert({
      name: 'off',
      projectId,
      startText: '',
      nodes: [sNode('a'), sNode('b')],
      edges: [edge('a', 'b')],
    });
    orchestrations.update(off.id, { enabled: false });
    idleOf(engine, 'a');
    await flush();
    expect(d.send).not.toHaveBeenCalled();

    orchestrations.update(off.id, { enabled: true });
    // 孤立入口（无出边）：不空转
    orchestrations.insert({
      name: 'lonely',
      projectId,
      startText: '',
      nodes: [sNode('a')],
      edges: [],
    });
    idleOf(engine, 'a');
    await flush();
    expect(d.send).not.toHaveBeenCalled();

    // 正常触发一次后，冷却期内（Stop → SessionEnd 连拍）不重复
    const on = orchestrations.insert({
      name: 'on',
      projectId,
      startText: '',
      nodes: [sNode('a'), sNode('b')],
      edges: [edge('a', 'b')],
    });
    orchestrations.update(on.id, { enabled: true });
    idleOf(engine, 'a');
    await flush();
    const after = d.send.mock.calls.length;
    idleOf(engine, 'a'); // 冷却期内
    expect(d.send.mock.calls.length).toBe(after);
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

  it('拉起单落一条 ensure 事件（含耗时），排在投递事件之前', async () => {
    const { engine } = setup({ liveness: new Map([['a', false]]) });
    sessions.touch('a', projectId);
    const result = await engine.start(fanOut(), 'manual');
    const run = runs.getById((result as { runId: number }).runId)!;
    const ensure = run.state.events.find((e) => e.stage === 'ensure');
    expect(ensure).toMatchObject({ to: 'a', ok: true });
    expect(typeof ensure!.ms).toBe('number');
    expect(run.state.events.indexOf(ensure!)).toBeLessThan(
      run.state.events.findIndex((e) => e.stage === undefined && e.to === 'a'),
    );
  });

  it('同一目标被并发投递时只拉起一次（单飞）', async () => {
    let release: (v: { ok: true }) => void = () => {};
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = resolve;
    });
    const { engine, ensureOpen } = setup({
      ensureOpen: () => gate,
      liveness: new Map([
        ['a', true],
        ['b', false],
        ['c', true],
      ]),
    });
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'join',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b'), sNode('c')],
      edges: [edge('a', 'b'), edge('c', 'b')],
    }).id;
    await engine.start(id, 'manual'); // 入口 a、c 各收一条
    idleOf(engine, 'a');
    idleOf(engine, 'c'); // 两条边同一拍并发投 b
    await flush();
    expect(ensureOpen).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await flush();
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

  it('停用的编排 cron 不触发；webhook-only 无可定时的入口也不触发', async () => {
    const { engine } = setup();
    const id = fanOut();
    orchestrations.update(id, { cron: '* * * * *', enabled: false });
    expect(engine.cronTick(new Date('2026-03-05T09:30:20'))).toBe(0);

    const hookOnly = orchestrations.insert({
      name: 'hook-only',
      projectId,
      startText: '',
      nodes: [wNode()],
      edges: [],
    });
    orchestrations.update(hookOnly.id, { cron: '* * * * *' });
    expect(engine.cronTick(new Date('2026-03-05T09:30:20'))).toBe(0);
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

describe('条件边（edge.condition）', () => {
  const condEdge = (
    from: string,
    to: string,
    condition: string,
    id = `${from}-${to}`,
  ): OrchestrationEdge => ({ id, from, to, text: `msg to ${to}`, condition });

  it('回答 yes → 放行投递；旁边无条件边不受影响', async () => {
    const extract = vi.fn(async () => 'yes');
    const { d, engine } = setup({ supportsExtract: () => true, extract });
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'cond',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b'), sNode('c')],
      edges: [condEdge('a', 'b', '改动是否需要发包？'), edge('a', 'c')],
    }).id;
    const result = await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    // b/c 各欠一轮投递回执，回合完成才收尾
    idleOf(engine, 'b');
    idleOf(engine, 'c');
    await flush();
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('done');
    const targets = d.send.mock.calls.map((c) => c[0].toSessionId);
    expect(targets).toContain('b');
    expect(targets).toContain('c');
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]![0].prompt).toContain('改动是否需要发包');
    expect(run.state.events.find((e) => e.edgeId === 'a-b')).toMatchObject({ ok: true });
  });

  it('回答 no → 拦下不投（stage=condition）；全拦下 run 落 done', async () => {
    const { d, engine } = setup({
      supportsExtract: () => true,
      extract: async () => 'no',
    });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'cond-no',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [condEdge('a', 'b', '需要发吗')],
    }).id;
    const result = await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('done');
    expect(run.deliveries).toBe(1); // 只有 start 的首投计入
    expect(d.send).toHaveBeenCalledTimes(1); // 只有 start 的首投
    expect(run.state.events.find((e) => e.stage === 'condition')).toMatchObject({
      ok: false,
      edgeId: 'a-b',
    });
  });

  it('回答不认 → 拦下并给原因', async () => {
    const { engine } = setup({
      supportsExtract: () => true,
      extract: async () => '我觉得应该发一下',
    });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'cond-ambiguous',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [condEdge('a', 'b', '需要发吗')],
    }).id;
    const result = await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('done');
    const event = run.state.events.find((e) => e.stage === 'condition');
    expect(event?.error).toContain('could not be evaluated');
  });

  it('harness 没有上下文子 Agent 面 → 拦下并给原因', async () => {
    const { engine } = setup({ supportsExtract: () => false });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'cond-unsupported',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [condEdge('a', 'b', '需要发吗')],
    }).id;
    const result = await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('done');
    expect(run.state.events.find((e) => e.stage === 'condition')?.error).toContain(
      'no context sub-agent face',
    );
  });

  it('parseConditionAnswer：中英首词认 yes/no，其余 null', () => {
    expect(parseConditionAnswer('yes')).toBe(true);
    expect(parseConditionAnswer('Yes.')).toBe(true);
    expect(parseConditionAnswer('是')).toBe(true);
    expect(parseConditionAnswer('对')).toBe(true);
    expect(parseConditionAnswer('no')).toBe(false);
    expect(parseConditionAnswer('否')).toBe(false);
    expect(parseConditionAnswer('不需要')).toBe(false);
    expect(parseConditionAnswer('maybe')).toBeNull();
    expect(parseConditionAnswer('')).toBeNull();
    expect(parseConditionAnswer(null)).toBeNull();
  });
});
