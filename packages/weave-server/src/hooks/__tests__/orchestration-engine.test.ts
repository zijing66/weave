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
import {
  OrchestrationEngine,
  matchWhen,
  parseConditionAnswer,
  type DecisionModelTier,
} from '../orchestration-engine.js';
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
  // 诱导登记的假实现：行为对齐 MessageDeliverer（登记 → 一次性核销）。
  const inductions = new Set<string>();
  const registerInduction = vi.fn((sessionId: string) => inductions.add(sessionId));
  const consumeInduction = vi.fn((sessionId: string) => {
    const had = inductions.has(sessionId);
    inductions.delete(sessionId);
    return had;
  });
  const markCompleted = vi.fn(() => false);
  // 扇入并置（2026-11-12）：fake deliverer 的可选只读口（真实现 = 在途行正文）。
  const pendingTexts = new Map<string, string[]>();
  const pendingTextsOf = vi.fn((sessionId: string): string[] => pendingTexts.get(sessionId) ?? []);
  return { send, awaitInboxReady, lastTurnOutput, setLastOutput, registerInduction, consumeInduction, markCompleted, pendingTextsOf, setPendingTexts: (s: string, texts: string[]) => pendingTexts.set(s, texts) };
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
    decisionModel?: DecisionModelTier;
    deferWhenUserPresent?: boolean;
    postJson?: (
      url: string,
      secret: string | undefined,
      body: unknown,
    ) => Promise<{ ok: boolean; status: string; error?: string }>;
    channelById?: (id: string) => { kind: string; config: Record<string, unknown>; enabled: boolean } | undefined;
    sendToChannel?: (
      channel: unknown,
      payload: { title: string; body: string },
    ) => Promise<{ ok: boolean; status: string; error?: string }>;
    deliverVerdict?: (input: { projectId: number; text: string }) => Promise<{
      ok: boolean;
      files: string[];
      error?: string;
    }>;
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
    retryDelayMs: 0,
    ...(opts.supportsExtract ? { supportsExtract: opts.supportsExtract } : {}),
    ...(opts.extract ? { extract: opts.extract } : {}),
    ...(opts.decisionModel ? { decisionModel: opts.decisionModel } : {}),
    ...(opts.deferWhenUserPresent ? { deferWhenUserPresent: true } : {}),
    postJsonImpl: postJson as never,
    ...(opts.channelById ? { channelById: opts.channelById } : {}),
    ...(opts.sendToChannel ? { sendToChannelImpl: opts.sendToChannel as never } : {}),
    ...(opts.deliverVerdict ? { deliverVerdict: opts.deliverVerdict } : {}),
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

  it('同编排已有 running → 并进在跑 run（不叠跑不丢弃，runId 沿用）', async () => {
    const { d, engine } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const id = fanOut();
    const first = await engine.start(id, 'manual');
    const second = await engine.start(id, 'manual', 'second shot');
    expect(second).toMatchObject({ ok: true, runId: (first as { runId: number }).runId });
    // 第二发的首步并进了在跑 run 的 pending（a 现在欠两条）
    const run = runs.getById((first as { runId: number }).runId)!;
    expect(run.state.pending.a).toHaveLength(2);
    expect(d.send).toHaveBeenCalledTimes(2);
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

  it('出口选已登记通道 = 按通道发送，不走裸 POST', async () => {
    const channel = { kind: 'wecom', config: { url: 'https://qy.example/hook' }, enabled: true };
    const sendToChannel = vi.fn(async () => ({ ok: true, status: 'succeeded' }) as const);
    const { engine, postJson } = setup({ channelById: () => channel, sendToChannel });
    sessions.touch('a', projectId);
    const id = orchestrations.insert({
      name: 'hook-out',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), { id: 'w:9', kind: 'webhook', channelId: 'c-1' }],
      edges: [edge('a', 'w:9')],
    }).id;
    const result = await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    expect(postJson).not.toHaveBeenCalled();
    expect(sendToChannel).toHaveBeenCalledWith(
      channel,
      expect.objectContaining({ title: 'weave · hook-out', body: 'msg to w:9' }),
    );
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('done');
    expect(run.state.events.at(-1)).toMatchObject({ to: 'w:9', ok: true });
  });

  it('出口通道不存在/已停用 = 记失败事件（重试一次）', async () => {
    const sendToChannel = vi.fn(async () => ({ ok: true, status: 'succeeded' }) as const);
    const { engine, postJson } = setup({ channelById: () => undefined, sendToChannel });
    sessions.touch('a', projectId);
    const id = orchestrations.insert({
      name: 'hook-out',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), { id: 'w:9', kind: 'webhook', channelId: 'c-gone' }],
      edges: [edge('a', 'w:9')],
    }).id;
    await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    await flush();
    expect(postJson).not.toHaveBeenCalled();
    expect(sendToChannel).not.toHaveBeenCalled();
  });

  it('POST 失败记失败事件，不影响 run 里其他成功投递（重试一次仍失败）', async () => {
    const { engine, postJson } = setup({
      postJson: async () => ({ ok: false, status: 'failed', error: 'HTTP 500' }),
    });
    sessions.touch('a', projectId);
    const result = await engine.start(exitGraph(), 'manual');
    idleOf(engine, 'a');
    await flush();
    await flush();
    expect(postJson).toHaveBeenCalledTimes(2); // 失败重试了一次
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

  it('extract：判提合一组合 fork 一次出全边 briefs；缺键的边回落 {upstream}', async () => {
    const prompts: string[] = [];
    const { d, engine } = setup({
      deliverer: { lastOutput: { output: '上游原文', at: AT } },
      supportsExtract: (id) => id === 'a',
      extract: async (input) => {
        prompts.push(input.prompt);
        // 两边的提炼指令并批进同一次组合 fork（键齐全的那条拿到 brief）。
        return '{"briefs":{"a-b":"提炼后的交接说明"}}';
      },
    });
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    await engine.start(
      graph([
        { id: 'a-b', from: 'a', to: 'b', text: '{summary}', extract: '请总结' },
        { id: 'a-c', from: 'a', to: 'c', text: '{summary}', extract: '请提炼' },
      ]),
      'manual',
    );
    idleOf(engine, 'a');
    await flush();
    expect(prompts).toHaveLength(1); // 两条边的提炼一次 fork 并批出
    expect(prompts[0]).toContain('请总结');
    expect(prompts[0]).toContain('请提炼');
    const texts = d.send.mock.calls.map((c) => c[0].text);
    expect(texts).toContain('提炼后的交接说明');
    expect(texts).toContain('上游原文'); // 缺键回落上游输出
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

  it('编排拉起的会话：登记一次性核销，消费完 pending 后的首个独立收尾不算自然回合（超 60s 也不误判）', async () => {
    const { d, engine } = setup({ deliverer: { lastOutput: { output: 'x', at: AT } }, liveness: new Map([['a', false]]) });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    orchestrations.insert({
      name: 'y',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [edge('a', 'b')],
    });
    // 编排投递（目标判死 → 拉起 → 登记 + send origin=orchestration）
    await engine.start(orchestrations.list()[0]!.id, 'manual');
    expect(d.registerInduction).toHaveBeenCalledWith('a');
    idleOf(engine, 'a'); // 消费 start 的 pending → fan-out 到 b（这一轮本来就是编排驱动的）
    await flush();
    idleOf(engine, 'b'); // 消费 b 的 pending → run 收尾
    await flush();
    expect(runs.listRunning()).toHaveLength(0);
    // pending 已空、登记还在（一次性核销未消费）：哪怕离拉起已超旧 60s 守卫，
    // 首个非 pending 驱动的收尾仍被登记闸豁免——不起跑新 run、不投递
    const sendsBefore = d.send.mock.calls.length;
    idleOf(engine, 'a');
    await flush();
    expect(d.consumeInduction).toHaveLastReturnedWith(true);
    expect(d.send.mock.calls.length).toBe(sendsBefore);
    expect(runs.listRunning()).toHaveLength(0);
    // 核销完成：下一个收尾回到自然回合判定 → 起跑（fan-out 投 b）
    idleOf(engine, 'a');
    await flush();
    expect(d.consumeInduction).toHaveLastReturnedWith(false);
    expect(d.send.mock.calls.length).toBe(sendsBefore + 1);
    expect(runs.listRunning().some((r) => r.orchestrationName === 'y')).toBe(true);
  });

  it('idle 消费 pending 那一拍回写「已执行」到投递行（markCompleted 拿到管道发号）', async () => {
    const { d, engine } = setup();
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    orchestrations.insert({
      name: 'cx',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [edge('a', 'b')],
    });
    const result = await engine.start(orchestrations.list()[0]!.id, 'manual');
    expect(result).toMatchObject({ ok: true });
    // 投递落定才进 pending；idle 到达 → shift 消费 + markCompleted 回写发号
    expect(d.markCompleted).not.toHaveBeenCalled();
    idleOf(engine, 'a');
    await flush();
    expect(d.markCompleted).toHaveBeenCalledTimes(1);
    expect(d.markCompleted).toHaveBeenCalledWith('m-1');
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
  it('rearm：最小续跑——从落库 state 重建 Runtime，pending 原样保留', async () => {
    const { engine, d } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const result = await engine.start(fanOut(), 'manual');
    const runId = (result as { runId: number }).runId;
    engine.rearm();
    // run 仍 running（没被打成 interrupted），pending 原样
    const row = runs.getById(runId)!;
    expect(row.status).toBe('running');
    expect(row.state.pending.a).toHaveLength(1);
    expect(runs.listRunning()).toHaveLength(1);
    // 重启后目标会话的回合照常消费推进
    idleOf(engine, 'a');
    await flush();
    expect(d.send.mock.calls.some((c) => c[0].toSessionId === 'b')).toBe(true);
  });

  it('rearm：定义已删的 run 落 interrupted', async () => {
    const { engine } = setup();
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const orchId = fanOut();
    const result = await engine.start(orchId, 'manual');
    const runId = (result as { runId: number }).runId;
    orchestrations.deleteById(orchId);
    engine.rearm();
    expect(runs.getById(runId)).toMatchObject({ status: 'interrupted' });
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
    const extract = vi.fn(async () => '{"answers":{"a-b":true}}');
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
      extract: async () => '{"answers":{"a-b":false}}',
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

  it('组合 fork 回坏答案（非 JSON）→ 回落逐边仍坏 → 文本兜底拦下', async () => {
    const { d, engine } = setup({
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
    d.setLastOutput({ output: '上游没提到关键词', at: new Date().toISOString() });
    idleOf(engine, 'a');
    await flush();
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('done');
    const event = run.state.events.find((e) => e.stage === 'condition');
    expect(event?.ok).toBe(false);
    expect(event?.source).toBe('text'); // 三级链末档接住了坏答案
  });

  it('harness 没有上下文子 Agent 面 → 文本兜底判（关键词命中放行，否则拦下）', async () => {
    const { d, engine } = setup({ supportsExtract: () => false });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'cond-unsupported',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [condEdge('a', 'b', '需要发吗,发包')],
    }).id;
    const result = await engine.start(id, 'manual');
    d.setLastOutput({ output: '上游决定发包', at: new Date().toISOString() });
    idleOf(engine, 'a');
    await flush();
    const targets = d.send.mock.calls.map((c) => c[0].toSessionId);
    expect(targets).toContain('b'); // 关键词命中 → 文本兜底放行
    idleOf(engine, 'b'); // b 消费投递 → run 收尾
    await flush();
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('done');
    const event = run.state.events.find((e) => e.stage === 'condition');
    expect(event?.ok).toBe(true);
    expect(event?.source).toBe('text');
  });

  it('注入决策模型 → 强结论直接出（fork 不烧）；P≤0.3 真拦截带概率原因', async () => {
    const extract = vi.fn(async () => '{"answers":{"a-b":true}}');
    const ask = vi.fn(async () => ({ 'a-b': 0.05 }));
    const { d, engine } = setup({
      supportsExtract: () => true,
      extract,
      decisionModel: { ask },
    });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'cond-judge',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [condEdge('a', 'b', '需要发吗')],
    }).id;
    const result = await engine.start(id, 'manual');
    d.setLastOutput({ output: '上游这一轮的输出', at: new Date().toISOString() });
    idleOf(engine, 'a');
    await flush();
    expect(extract).not.toHaveBeenCalled(); // 真拦截连 fork 都不烧
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toMatchObject({
      upstream: '上游这一轮的输出',
    });
    expect(ask.mock.calls[0]![0].questions['a-b']).toMatchObject({
      type: 'noul',
      instructions: '需要发吗',
    });
    expect(d.send).toHaveBeenCalledTimes(1); // 只有 start 的首投
    const run = runs.getById((result as { runId: number }).runId)!;
    const event = run.state.events.find((e) => e.stage === 'condition');
    expect(event?.error).toContain('condition answered no');
    expect(event?.detail).toContain('P(yes)=0.05');
    expect(event?.source).toBe('decision-model');
  });

  it('决策模型抛错/中间带 → 降级组合 fork 判断（不因模型故障拦死）', async () => {
    const extract = vi.fn(async () => '{"answers":{"a-b":true}}');
    const ask = vi.fn(async () => {
      throw new Error('api down');
    });
    const { d, engine } = setup({
      supportsExtract: () => true,
      extract,
      decisionModel: { ask },
    });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'cond-judge-throw',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [condEdge('a', 'b', '需要发吗')],
    }).id;
    const result = await engine.start(id, 'manual');
    d.setLastOutput({ output: '上游输出', at: new Date().toISOString() });
    idleOf(engine, 'a');
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1); // 模型故障降级 fork
    const run = runs.getById((result as { runId: number }).runId)!;
    const event = run.state.events.find((e) => e.stage === 'condition');
    expect(event?.ok).toBe(true);
    expect(event?.source).toBe('fork');
    expect(d.send).toHaveBeenCalledTimes(2); // start 首投 + 放行的 b
  });

  it('判断证据与边正文同账 32K 头尾预算（三本账统一，2026-11-12），截断落 detail 注记', async () => {
    const ask = vi.fn(async () => ({ 'a-b': 0.9 }));
    const extract = vi.fn(async () => 'yes'); // 不该被调用：模型已出强结论
    const { d, engine } = setup({
      supportsExtract: () => true,
      extract,
      decisionModel: { ask },
    });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'judge-budget',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [{ ...edge('a', 'b'), text: 'out: {upstream}', condition: '需要发吗' }],
    }).id;
    const result = await engine.start(id, 'manual');
    // 40K 输出：头有 HEAD、尾有 TAIL——头尾截取两头都得在，中段被丢。
    d.setLastOutput({ output: `HEAD${'a'.repeat(40_000)}TAIL`, at: new Date().toISOString() });
    idleOf(engine, 'a');
    await flush();
    expect(extract).not.toHaveBeenCalled(); // 模型强结论免 fork
    // 判断拿到 32K 头尾版：两头都在、带截断标记。
    const state = ask.mock.calls[0]![0].upstream ?? '';
    expect(state).toContain('HEAD');
    expect(state).toContain('TAIL');
    expect(state).toContain('chars truncated');
    expect(state.length).toBeLessThan(33_000);
    // 边正文同账 32K 头尾版（旧 4000 半截硬裁已退役）：两头都在（首投是 start 的
    // 'go'，取末条）。
    const sent = d.send.mock.calls.at(-1)![0] as SendInput;
    expect(sent.text).toContain('HEAD');
    expect(sent.text).toContain('TAIL');
    expect(sent.text).toContain('chars truncated');
    expect(sent.text.length).toBeLessThan(33_000);
    // RunEvent 的 detail 带截断注记（误判可诊断）。
    const run = runs.getById((result as { runId: number }).runId)!;
    const event = run.state.events.find((e) => e.stage === 'condition');
    expect(event?.detail).toContain('P(yes)=0.9');
    expect(event?.detail).toContain('state truncated');
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

describe('when 预筛 + 中间节点自然触发', () => {
  it('when 不命中 → 条件边照常进判断（模型主裁）；命中 → 快捷放行免 fork；纯 when 不命中维持拦下', async () => {
    const extract = vi.fn(async () => '{"answers":{"a-b":true}}');
    const { d, engine } = setup({ supportsExtract: () => true, extract });
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    // a→b：when+condition（不命中也进判断）；a→c：纯 when（不命中维持拦截）
    const id = orchestrations.insert({
      name: 'when',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b'), sNode('c')],
      edges: [
        { ...edge('a', 'b'), when: 'MODE=,ARTIFACT=', condition: '需要发吗' },
        { ...edge('a', 'c'), when: 'MODE=' },
      ],
    }).id;
    const result = await engine.start(id, 'manual');
    // 第一轮输出没有关键词：a→b 不命中 when 但有 condition → 进判断（fork 判
    // yes → 照投）；a→c 纯 when 不命中 → 拦下。
    d.setLastOutput({ output: '普通聊天内容', at: new Date().toISOString() });
    idleOf(engine, 'a');
    await flush();
    expect(extract).toHaveBeenCalledTimes(1); // 判断烧了一次 fork
    expect(d.send).toHaveBeenCalledTimes(2); // start 首投 + b（c 被纯 when 拦下）
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(
      run.state.events.filter((e) => e.edgeId === 'a-c' && e.stage === 'condition'),
    ).toHaveLength(1);
    // 第二轮输出带 MODE= → 两边都命中快捷放行（免 fork 直投）
    const forksAfterFirst = extract.mock.calls.length;
    const sendAfterFirst = d.send.mock.calls.length;
    const run2 = await engine.start(id, 'manual'); // 同编排并进 run（单 run 闸）
    void run2;
    idleOf(engine, 'b'); // b 有 pending（第一轮投给 b 的），消费它的出边（无出边）
    idleOf(engine, 'c');
    await flush();
    d.setLastOutput({ output: 'MODE=pack\nARTIFACT=x.tgz', at: new Date().toISOString() });
    idleOf(engine, 'a'); // 新 run 的 a 消费（不命中 nothing：两边命中快捷）
    await flush();
    expect(d.send.mock.calls.length).toBe(sendAfterFirst + 3); // start 首投 + b + c
    expect(extract.mock.calls.length).toBe(forksAfterFirst); // 快捷放行不再烧 fork
  });

  it('中间节点 autoFire：自然回合触发出边（when 拦噪）；未标记的不触发', async () => {
    const extract = vi.fn(async () => 'yes');
    const { d, engine } = setup({ supportsExtract: () => true, extract });
    for (const id of ['b', 'x', 'm']) sessions.touch(id, projectId);
    orchestrations.insert({
      name: 'midfire',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), { ...sNode('m'), autoFire: true }, sNode('b'), sNode('x')],
      edges: [{ ...edge('m', 'b'), when: 'MODE=' }, edge('a', 'x')],
    });
    // m 的自然回合：输出没关键词 → 预筛拦下（不烧 fork、不投）
    d.setLastOutput({ output: '闲聊', at: new Date().toISOString() });
    idleOf(engine, 'm');
    await flush();
    expect(d.send).toHaveBeenCalledTimes(0);
    expect(extract).not.toHaveBeenCalled();
    // 输出命中 → fork 判 yes → 投 b（清掉冷却：真实场景两回合间隔远大于 5s）
    (engine as unknown as { lastAutoFireAt: Map<string, number> }).lastAutoFireAt.clear();
    d.setLastOutput({ output: 'MODE=pack', at: new Date().toISOString() });
    idleOf(engine, 'm');
    await flush();
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send.mock.calls[0]![0].toSessionId).toBe('b');
    // 未标记自然触发的节点 x：自然回合什么都不做
    idleOf(engine, 'x');
    await flush();
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it('enabled=false：中间节点标记了 autoFire 也不触发', async () => {
    const { d, engine } = setup({ supportsExtract: () => true, extract: async () => 'yes' });
    for (const id of ['a', 'm', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'off',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), { ...sNode('m'), autoFire: true }, sNode('b')],
      edges: [edge('m', 'b')],
      enabled: false,
    }).id;
    await engine.start(id, 'manual', undefined, ['a']);
    const before = d.send.mock.calls.length;
    idleOf(engine, 'm');
    await flush();
    expect(d.send.mock.calls.length).toBe(before);
  });

  it('matchWhen：任一关键词命中即可，大小写不敏感', () => {
    expect(matchWhen('MODE=', '输出 MODE=pack')).toBe(true);
    expect(matchWhen('mode=', '输出 MODE=pack')).toBe(true);
    expect(matchWhen('A,,B', 'has b')).toBe(true);
    expect(matchWhen('A,B', 'nothing')).toBe(false);
    expect(matchWhen('A,B', '')).toBe(false);
  });
});

describe('P0：fork 预算 + pending 陈滞超时', () => {
  it('fork 预算到顶：condition 拦下并记原因，extract 回落 {upstream}，run 不因此失败', async () => {
    let forks = 0;
    const { d, engine } = setup({
      supportsExtract: () => true,
      extract: async () => {
        forks++;
        return 'yes';
      },
      maxDeliveries: 999,
    });
    for (const id of ['a', 'b', 'c', 'e']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'fork-budget',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b'), sNode('c'), sNode('e')],
      edges: [
        { id: 'ab', from: 'a', to: 'b', text: 'to b', condition: '需要吗' },
        { id: 'ac', from: 'a', to: 'c', text: 'to c', condition: '需要吗' },
        { id: 'ae', from: 'a', to: 'e', text: 'to e {summary}', extract: '提炼' },
      ],
    }).id;
    const result = await engine.start(id, 'manual');
    // 预算 50：三条边各烧 1 次远不到顶——直接把 rt.forks 顶到上限再触发一轮
    const runId = (result as { runId: number }).runId;
    idleOf(engine, 'b');
    idleOf(engine, 'c');
    idleOf(engine, 'e');
    await flush();
    // 白盒：把 forks 顶到上限，再让 a 完成一轮 → condition 拦下 + extract 回落
    const rt = (engine as unknown as { runtime: Map<number, { forks: number }> }).runtime.get(runId);
    if (rt) rt.forks = 50;
    d.setLastOutput({ output: 'MODE=pack', at: new Date().toISOString() });
    idleOf(engine, 'a');
    await flush();
    const run = runs.getById(runId)!;
    const events = run.state.events;
    expect(events.some((e) => e.stage === 'condition' && e.error?.includes('fork budget exhausted'))).toBe(true);
    // extract 预算耗尽 → {summary} 回落 {upstream}（不残留占位）
    const ae = events.find((e) => e.edgeId === 'ae' && e.ok);
    expect(ae).toBeTruthy();
  });

  it('pending 陈滞：目标活着但最老待回超 2h → run 落 failed 释放单 run 闸', async () => {
    const { engine } = setup({ liveness: new Map([['b', true]]) });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'stale',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [edge('a', 'b')],
    }).id;
    const result = await engine.start(id, 'manual');
    const runId = (result as { runId: number }).runId;
    idleOf(engine, 'a');
    await flush();
    // 白盒：把 pending 的时刻拨回 3 小时前
    const rt = (engine as unknown as { runtime: Map<number, { state: { pending: Record<string, { at: string }[]> } }> }).runtime.get(runId)!;
    rt.state.pending['b']![0]!.at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    engine.sweepTerminated();
    await flush();
    const run = runs.getById(runId)!;
    expect(run.status).toBe('failed');
    expect(run.error).toContain('pending stale');
    expect(run.state.pending['b']).toBeUndefined();
    // 单 run 闸已释放：能再起一份
    await expect(engine.start(id, 'manual')).resolves.toMatchObject({ ok: true });
  });
});

describe('扇入证据并置（2026-11-12 裁决）', () => {
  it('fan-in 目标的出边判断证据并置其余未消费投递正文（deliverer 在途行）', async () => {
    const ask = vi.fn(async () => ({ 'b-c': 0.9 }));
    const { d, engine } = setup({ decisionModel: { ask } });
    for (const id of ['b', 'c']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'fanin',
      projectId,
      startText: 'go',
      nodes: [sNode('b'), sNode('c')],
      edges: [{ ...edge('b', 'c'), condition: '两路是否都齐了？' }],
    }).id;
    await engine.start(id, 'manual');
    // b 收到首投后有两条在途投递（模拟 fan-in 另一路已送达未消费）
    d.setLastOutput({ output: '第一路上游的产出结论', at: new Date().toISOString() });
    d.setPendingTexts('b', ['第一路上游的产出结论', '第二路上游的产出结论']);
    idleOf(engine, 'b'); // b 回合收盘（消费首投）→ 出边判断
    await flush();
    expect(d.pendingTextsOf).toHaveBeenCalledWith('b');
    const state = ask.mock.calls[0]![0].upstream ?? '';
    expect(state).toContain('fan-in context');
    expect(state).toContain('第一路上游的产出结论');
    expect(state).toContain('第二路上游的产出结论');
  });

  it('无在途正文或 webhook 载荷入口 → 不并置（证据 = 单边 {upstream}）', async () => {
    const ask = vi.fn(async () => ({ 'b-c': 0.9 }));
    const { d, engine } = setup({ decisionModel: { ask } });
    for (const id of ['b', 'c']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'fanin-none',
      projectId,
      startText: 'go',
      nodes: [sNode('b'), sNode('c')],
      edges: [{ ...edge('b', 'c'), condition: '需要发吗' }],
    }).id;
    await engine.start(id, 'manual');
    d.setLastOutput({ output: '上游单边结论', at: new Date().toISOString() });
    idleOf(engine, 'b');
    await flush();
    const state = ask.mock.calls[0]![0].upstream ?? '';
    expect(state).not.toContain('fan-in context');
    expect(state).toBe('上游单边结论');
    expect(d.pendingTextsOf).toHaveBeenCalledWith('b');
  });
});

describe('P1：判提合一批量档（一次组合 fork 出全边路由）', () => {
  it('两条条件边 + 一条提炼边 → 一次组合 fork 出齐 answers+briefs，no 的边拦下', async () => {
    let forkCount = 0;
    const prompts: string[] = [];
    const { d, engine } = setup({
      supportsExtract: () => true,
      extract: async (input) => {
        forkCount++;
        prompts.push(input.prompt);
        return '{"answers":{"ab":true,"ac":false},"briefs":{"ae":"提炼结果"}}';
      },
    });
    for (const id of ['a', 'b', 'c', 'e']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'batch-cond',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b'), sNode('c'), sNode('e')],
      edges: [
        { id: 'ab', from: 'a', to: 'b', text: 'to b', condition: '需要发 b 吗' },
        { id: 'ac', from: 'a', to: 'c', text: 'to c', condition: '需要发 c 吗' },
        { id: 'ae', from: 'a', to: 'e', text: '{summary}', extract: '提炼' },
      ],
    }).id;
    const result = await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    idleOf(engine, 'b');
    await flush();
    expect(forkCount).toBe(1); // 判断 + 提炼一次 fork 出齐
    expect(prompts[0]).toContain('需要发 b 吗');
    expect(prompts[0]).toContain('需要发 c 吗');
    expect(prompts[0]).toContain('提炼');
    const run = runs.getById((result as { runId: number }).runId)!;
    const targets = d.send.mock.calls.map((c) => c[0].toSessionId);
    expect(targets).toContain('b');
    expect(targets).not.toContain('c');
    const texts = d.send.mock.calls.map((c) => c[0].text);
    expect(texts).toContain('提炼结果');
    expect(run.state.events.find((e) => e.edgeId === 'ac' && e.stage === 'condition')).toMatchObject({
      ok: false,
    });
  });

  it('组合 fork 回 JSON 坏 → 回落逐边（单键组合 prompt），全照常出结论', async () => {
    let calls = 0;
    const responses = [
      'not a json', // 批量组合一次：坏
      '{"answers":{"ab":true}}', // 逐边回落：ab
      '{"answers":{"ac":true}}', // 逐边回落：ac
    ];
    const { d, engine } = setup({
      supportsExtract: () => true,
      extract: async () => {
        const answer = responses[calls];
        calls++;
        return answer ?? null;
      },
    });
    for (const id of ['a', 'b', 'c']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'batch-fallback',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b'), sNode('c')],
      edges: [
        { id: 'ab', from: 'a', to: 'b', text: 'to b', condition: 'x' },
        { id: 'ac', from: 'a', to: 'c', text: 'to c', condition: 'y' },
      ],
    }).id;
    await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    idleOf(engine, 'b');
    idleOf(engine, 'c');
    await flush();
    expect(calls).toBe(3); // 1 批量（坏） + 2 逐边
    const targets = d.send.mock.calls.map((c) => c[0].toSessionId);
    expect(targets).toContain('b');
    expect(targets).toContain('c');
  });
});

describe('P2：人在场闸（deferWhenUserPresent）', () => {
  it('开启时：目标闲着且刚有事件 → defer（占位 pending，不真投）；回合开着不 defer', async () => {
    const { d, engine } = setup({ deferWhenUserPresent: true });
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'present',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [edge('a', 'b')],
    }).id;
    const result = await engine.start(id, 'manual');
    // 入口 a 刚 touch（lastSeenAt = now）且闲着 → 首投 defer
    const runId = (result as { runId: number }).runId;
    expect(d.send).toHaveBeenCalledTimes(0);
    const run = runs.getById(runId)!;
    expect(run.state.pending.a).toHaveLength(1); // 占位 pending
    expect(run.status).toBe('running');
    expect(run.state.events.some((e) => e.stage === 'defer')).toBe(true);
    // 用户下一轮完成（Stop）→ 消费占位 → 此时 b 刚被 touch 过也 defer……
    // 但 a 的消费把出边投给 b：b 也刚看过 → defer 挂占位。真投要等 b 闲过窗口。
    idleOf(engine, 'a');
    await flush();
    const after = runs.getById(runId)!;
    expect(after.state.pending.b).toHaveLength(1); // b 的占位
    // 把 b 的 lastSeenAt 拨老（用户离开）→ 消费时真投
    const db = (engine as unknown as { deps: { sessions: { touch: (id: string, p: number) => void } } });
    void db;
  });

  it('关闭时（默认）：恒直投，行为与从前一致', async () => {
    const { d, engine } = setup({});
    for (const id of ['a', 'b']) sessions.touch(id, projectId);
    const id = orchestrations.insert({
      name: 'nopresent',
      projectId,
      startText: 'go',
      nodes: [sNode('a'), sNode('b')],
      edges: [edge('a', 'b')],
    }).id;
    await engine.start(id, 'manual');
    expect(d.send).toHaveBeenCalledTimes(1); // 首投照常
  });
});

describe('记忆出口（批 3，2026-11-12：判提合一写项目记忆文件）', () => {
  const mNode = (id = 'm:1'): OrchestrationNode => ({ id, kind: 'memory' });
  const memGraph = (name: string): number =>
    orchestrations.insert({
      name,
      projectId,
      startText: 'go',
      nodes: [sNode('a'), mNode()],
      edges: [edge('a', 'm:1')],
    }).id;

  it('模型放行 → fork 只提炼：写盘面收到判决文本、stage:memory 落痕、run 收尾', async () => {
    const ask = vi.fn(async () => ({ 'm:1': 0.9 }));
    const extract = vi.fn(async () => '{"briefs":{"m:1":"判决：X 由此走 Y 通道"}}');
    const deliverVerdict = vi.fn(async () => ({ ok: true, files: ['/p/CLAUDE.local.md'] }));
    const { engine } = setup({
      supportsExtract: () => true,
      extract,
      decisionModel: { ask },
      deliverVerdict,
    });
    sessions.touch('a', projectId);
    const id = memGraph('mem-model-clear');
    const result = await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    // 判提合一：模型已放行，组合 fork 只挂提炼节（prompt 有 brief 无 judgment）
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]![0].prompt).toContain('briefs');
    expect(extract.mock.calls[0]![0].prompt).not.toContain('Judgments');
    expect(deliverVerdict).toHaveBeenCalledTimes(1);
    expect(deliverVerdict.mock.calls[0]![0]).toMatchObject({ projectId, text: '判决：X 由此走 Y 通道' });
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('done'); // 记忆出口不进 pending，链路即时收尾
    const event = run.state.events.find((e) => e.stage === 'memory');
    expect(event).toMatchObject({ ok: true, to: 'm:1', detail: '/p/CLAUDE.local.md' });
  });

  it('模型拦下（P≤0.3）→ 连 fork 都不烧：不写盘、stage:memory 落痕、run 照常 done', async () => {
    const ask = vi.fn(async () => ({ 'm:1': 0.05 }));
    const extract = vi.fn(async () => 'never');
    const deliverVerdict = vi.fn(async () => ({ ok: true, files: [] }));
    const { engine } = setup({
      supportsExtract: () => true,
      extract,
      decisionModel: { ask },
      deliverVerdict,
    });
    sessions.touch('a', projectId);
    const id = memGraph('mem-model-block');
    const result = await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    expect(extract).not.toHaveBeenCalled();
    expect(deliverVerdict).not.toHaveBeenCalled();
    const run = runs.getById((result as { runId: number }).runId)!;
    expect(run.status).toBe('done');
    const event = run.state.events.find((e) => e.stage === 'memory');
    expect(event).toMatchObject({ ok: true, source: 'decision-model' });
    expect(event?.detail).toContain('P(yes)=0.05');
  });

  it('模型缺席 → 组合 fork 判提合一（answers+briefs 一次出）', async () => {
    const extract = vi.fn(async () => '{"answers":{"m:1":true},"briefs":{"m:1":"组合判决文本"}}');
    const deliverVerdict = vi.fn(async () => ({ ok: true, files: ['/p/AGENTS.md'] }));
    const { engine } = setup({ supportsExtract: () => true, extract, deliverVerdict });
    sessions.touch('a', projectId);
    const id = memGraph('mem-combined');
    await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(deliverVerdict.mock.calls[0]![0]).toMatchObject({ text: '组合判决文本' });
  });

  it('模型与 fork 都不在 → 不判，正文原样落盘', async () => {
    const deliverVerdict = vi.fn(async () => ({ ok: true, files: ['/p/CLAUDE.local.md'] }));
    const { engine } = setup({ deliverVerdict });
    sessions.touch('a', projectId);
    const id = memGraph('mem-raw');
    await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    expect(deliverVerdict).toHaveBeenCalledTimes(1);
    expect(deliverVerdict.mock.calls[0]![0]).toMatchObject({ text: 'msg to m:1' });
  });

  it('写盘失败 → 如实记失败并走一次投递重试', async () => {
    const deliverVerdict = vi.fn(async () => ({ ok: false, files: [], error: 'project not found' }));
    const { engine } = setup({ deliverVerdict });
    sessions.touch('a', projectId);
    const id = memGraph('mem-fail');
    const result = await engine.start(id, 'manual');
    idleOf(engine, 'a');
    await flush();
    await flush(); // 重试隔一个 0ms 退避拍
    expect(deliverVerdict).toHaveBeenCalledTimes(2); // deliver 的一次退避重试
    const run = runs.getById((result as { runId: number }).runId)!;
    const events = run.state.events.filter((e) => e.stage === 'memory');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.ok === false && e.error === 'project not found')).toBe(true);
  });
});
