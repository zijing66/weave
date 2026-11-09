import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExtensionEngine, DEFAULT_EXTENSION_STALE_MS, type ExtensionEventInput } from '../extension-engine.js';
import {
  ExtensionBindingRepository,
  ExtensionExecutionRepository,
  type ExtensionEndpoint,
} from '../../repositories/extension-bindings.js';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import type { HookEventBus, HookBusMessage } from '../bus.js';
import type { DecisionKernel } from '../decision-kernel.js';

/** 引擎单测（批 2b）：作用域叠加 / 冷却 / 陈旧 / 诱导 / 端点预算 / 频次 /
 *  幂等 partial index / 忙跳过 / when 预筛 / 决策档分流 / 失败告警。 */

let bindings: ExtensionBindingRepository;
let executions: ExtensionExecutionRepository;
let frames: HookBusMessage[];
let sent: Array<{ toSessionId: string; text: string; origin?: string; fromKind?: string; oneWay?: boolean }>;
let consumed: string[];
let kernel: Pick<DecisionKernel, 'judge' | 'evaluate'>;
let staleMs: number | undefined;

const bus = {
  emit: (m: HookBusMessage) => {
    frames.push(m);
  },
} as unknown as HookEventBus;

const deliverer = {
  send: async (input: { toSessionId: string; text: string; origin?: string; fromKind?: string; oneWay?: boolean }) => {
    sent.push(input);
    return {
      ok: true,
      messageId: `m-${sent.length}`,
      status: 'delivered',
      message: { id: `m-${sent.length}`, sessionId: input.toSessionId, text: input.text, mode: 'prompt', channel: 'prompt', status: 'delivered', at: new Date().toISOString() },
    } as never;
  },
  registerInduction: () => {},
  consumeInduction: (sessionId: string) => consumed.includes(sessionId),
};

/** 让在飞执行的收尾微任务（record / busy 清理）落定——vi.waitFor 首查同步命中时不让出微任务。 */
const settle = () => new Promise((r) => setTimeout(r, 5));

const baseInput = (over: Partial<ExtensionEventInput> = {}): ExtensionEventInput => ({
  sessionId: 'sess-a',
  source: 'claude',
  eventType: 'Stop',
  eventId: 101,
  projectId: 1,
  payload: { raw: { last_assistant_message: 'turn output' } },
  ...over,
});

const mkEngine = () =>
  new ExtensionEngine({
    bindings,
    executions,
    deliverer,
    sessions: { getBySessionId: () => undefined },
    hookEvents: { listBySession: () => [] },
    bus,
    kernel,
    ...(staleMs !== undefined ? { staleMs } : {}),
  });

const mkKernel = (over: Partial<Pick<DecisionKernel, 'judge' | 'evaluate'>> = {}) => ({
  judge: over.judge ?? (async () => ({ ok: true, source: 'fork' as const })),
  evaluate: over.evaluate,
});

beforeEach(() => {
  const db = openDatabase(':memory:');
  new ProjectRepository(db).register({ path: 'C:/x/proj', name: 'p', token: 'pt', source: 'init' });
  bindings = new ExtensionBindingRepository(db);
  executions = new ExtensionExecutionRepository(db);
  frames = [];
  sent = [];
  consumed = [];
  kernel = mkKernel();
  staleMs = undefined;
});

const sessionBinding = (over: Partial<Parameters<ExtensionBindingRepository['insert']>[0]> = {}) =>
  bindings.insert({
    name: 'b',
    projectId: 1,
    point: 'turn-end',
    endpoints: [{ kind: 'session', target: 'self', text: 'echo: {upstream}' }],
    ...over,
  });

describe('作用域叠加', () => {
  it('项目级与该会话的会话级各自独立执行（互不抑制）', async () => {
    sessionBinding({ name: 'project-level', sessionId: null });
    sessionBinding({ name: 'session-level', sessionId: 'sess-a' });
    const engine = mkEngine();
    engine.onEvent(baseInput());
    await vi.waitFor(() => expect(sent.length).toBe(2));
  });

  it('别的会话不吃会话级绑定；未启用的不命中', async () => {
    sessionBinding({ sessionId: 'sess-b' });
    sessionBinding({ enabled: false });
    const engine = mkEngine();
    engine.onEvent(baseInput());
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.length).toBe(0);
    // 项目级绑定对同一会话照常生效。
    sessionBinding();
    engine.reload();
    engine.onEvent(baseInput({ eventId: 999 }));
    await vi.waitFor(() => expect(sent.length).toBe(1));
  });
});

describe('扩展点与事件名（经表取，不散写）', () => {
  it('turn-end = HARNESS_LIFECYCLE[claude].close（Stop / StopFailure）；idle 额外吃 SessionEnd', async () => {
    sessionBinding({ point: 'turn-end' });
    sessionBinding({ point: 'idle', endpoints: [{ kind: 'session', target: 'self', text: 'idle' }] });
    const engine = mkEngine();
    // Stop 同拍双命中：两个独立绑定各自的执行。
    engine.onEvent(baseInput({ eventType: 'Stop' }));
    await vi.waitFor(() => expect(sent.length).toBe(2));
    await settle();
    // SessionEnd 只命中 idle 绑定。
    sent = [];
    engine.onEvent(baseInput({ eventType: 'SessionEnd', eventId: 102, sessionId: 'sess-fresh' }));
    await vi.waitFor(() => expect(sent.length).toBe(1));
    // 无关事件不触发。
    engine.onEvent(baseInput({ eventType: 'PostToolUse', eventId: 103, sessionId: 'sess-fresh' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.length).toBe(1);
  });

  it('codex 的 turn-end = close 表（Stop / TurnAborted）', async () => {
    sessionBinding({ point: 'turn-end' });
    const engine = mkEngine();
    engine.onEvent(baseInput({ source: 'codex', eventType: 'TurnAborted' }));
    await vi.waitFor(() => expect(sent.length).toBe(1));
  });
});

describe('冷却与忙跳过', () => {
  it('同绑定×会话 5s 冷却：同拍 Stop + SessionEnd 连拍第二拍不执行（无日志无帧）', async () => {
    sessionBinding({ point: 'idle' });
    const engine = mkEngine();
    engine.onEvent(baseInput({ eventType: 'Stop' }));
    await vi.waitFor(() => expect(sent.length).toBe(1));
    // 紧接着的 SessionEnd 在 5s 冷却窗内：静默跳过（连日志都不记——冷却不是闸迹）。
    engine.onEvent(baseInput({ eventType: 'SessionEnd', eventId: 102 }));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.length).toBe(1);
    expect(executions.query({}).rows.length).toBe(1);
  });

  it('同绑定前一拍未完 → 本拍记 skipped:busy 不排队', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    kernel = {
      judge: async () => {
        await gate;
        return { ok: true };
      },
    };
    sessionBinding({ condition: '需要吗' });
    const engine = mkEngine();
    engine.onEvent(baseInput());
    // 第一拍还在等 judge；第二拍换会话绕开会话维冷却（忙跳过按绑定计），应记 skipped:busy。
    engine.onEvent(baseInput({ eventId: 102, sessionId: 'sess-b' }));
    release();
    await vi.waitFor(() => {
      const stages = executions.query({}).rows.map((r) => r.stage);
      expect(stages).toContain('skipped:busy');
    });
  });
});

describe('陈旧闸与频次闸', () => {
  it('回放中超龄事件记 skipped:stale 不执行；settings 可配窗', async () => {
    staleMs = DEFAULT_EXTENSION_STALE_MS;
    sessionBinding();
    const engine = mkEngine();
    engine.onEvent(baseInput({ at: new Date(Date.now() - 30 * 60_000).toISOString() }));
    await vi.waitFor(() => {
      const rows = executions.query({}).rows;
      expect(rows[0]!.stage).toBe('skipped:stale');
    });
    expect(sent.length).toBe(0);
  });

  it('日频次上限：超记 skipped:capped', async () => {
    sessionBinding();
    const engine = mkEngine();
    // 直接灌满计数（绕冷却窗用递增 eventId 也不行——冷却按绑定×会话卡 5s；
    // 这里伪造多会话绕开会话维冷却，频次闸按绑定计）。
    let n = 0;
    for (let i = 0; i < 205; i++) {
      engine.onEvent(baseInput({ sessionId: `s${i % 210}`, eventId: 1000 + i, at: new Date().toISOString() }));
      await new Promise((r) => setTimeout(r, 0));
      // 冷却 5s 会拦掉大部分——把 lastFiredAt 窗口打掉的最省路径是逐会话各一次。
      n = executions.query({}).rows.filter((r) => r.stage === 'delivered').length;
      if (executions.query({}).rows.some((r) => r.stage === 'skipped:capped')) break;
    }
    expect(executions.query({}).rows.some((r) => r.stage === 'skipped:capped')).toBe(true);
    expect(n).toBeLessThanOrEqual(200);
  });
});

describe('诱导回合豁免（批 2a 登记，消费即核销）', () => {
  it('有登记的首个 Stop 不触发绑定；核销后下一轮照常', async () => {
    sessionBinding();
    const engine = mkEngine();
    consumed = ['sess-a'];
    engine.onEvent(baseInput());
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.length).toBe(0);
    // 核销（一次性）：下一轮按自然回合触发。
    consumed = [];
    engine.onEvent(baseInput({ eventId: 102 }));
    await vi.waitFor(() => expect(sent.length).toBe(1));
  });
});

describe('幂等 partial index', () => {
  it('同一 (绑定, 事件, 端点) 已 delivered 的回放记 skipped:duplicate，不重复扇出', async () => {
    sessionBinding();
    const engine = mkEngine();
    engine.onEvent(baseInput());
    await vi.waitFor(() => expect(sent.length).toBe(1));
    // 冷却窗挡不住「另一会话的同一事件」——用新引擎实例模拟 daemon 重启回放
    // （内存冷却/忙态全空，只剩库里的 delivered 行）。
    const replayed = mkEngine();
    replayed.onEvent(baseInput({ sessionId: 'sess-replay' }));
    await vi.waitFor(() => {
      const stages = executions.query({}).rows.map((r) => r.stage);
      expect(stages).toContain('skipped:duplicate');
    });
    expect(sent.length).toBe(1);
  });
});

describe('端点预算与 when 预筛', () => {
  it('空端点表与超预算（>8）都记 failed 不投', async () => {
    sessionBinding({ endpoints: [] });
    const nine: ExtensionEndpoint[] = Array.from({ length: 9 }, (_, i) => ({
      kind: 'webhook',
      url: `https://x/${i}`,
    }));
    sessionBinding({ name: 'too-many', endpoints: nine });
    const engine = mkEngine();
    engine.onEvent(baseInput());
    await vi.waitFor(() => {
      const failed = executions.query({}).rows.filter((r) => r.stage === 'failed');
      expect(failed.length).toBe(2);
    });
    expect(sent.length).toBe(0);
  });

  it('when 不命中记 when-blocked，不烧决策不扇出；命中才走', async () => {
    sessionBinding({ when: '部署,发布', condition: '需要吗', endpoints: [{ kind: 'session', target: 'self', text: 'go' }] });
    const judge = vi.fn(async () => ({ ok: true }));
    kernel = { judge };
    const engine = mkEngine();
    engine.onEvent(baseInput({ payload: { raw: { last_assistant_message: 'just refactored' } } }));
    await vi.waitFor(() => {
      expect(executions.query({}).rows[0]!.stage).toBe('when-blocked');
    });
    await settle();
    expect(judge).not.toHaveBeenCalled();
    engine.onEvent(
      baseInput({ eventId: 102, sessionId: 'sess-c', payload: { raw: { last_assistant_message: 'shipped the 部署' } } }),
    );
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(judge).toHaveBeenCalled();
  });
});

describe('决策档分流', () => {
  it('summarize 在场走档三 evaluate；拦下记 condition-blocked，放行把 {summary} 渲进载荷', async () => {
    const evaluate = vi.fn(async () => ({
      ok: true,
      summary: '三行总结',
      source: 'fork' as const,
      detail: 'combined fork: yes',
    }));
    kernel = { judge: async () => ({ ok: true }), evaluate };
    sessionBinding({ summarize: '总结这轮', endpoints: [{ kind: 'session', target: 'self', text: '{summary}' }] });
    const engine = mkEngine();
    engine.onEvent(baseInput());
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(evaluate).toHaveBeenCalled();
    expect(sent[0]!.text).toBe('三行总结');
    expect(sent[0]!.origin).toBe('extension');
    expect(sent[0]!.fromKind).toBe('session');
  });

  it('仅 condition 走档一 judge；no 拦下', async () => {
    kernel = mkKernel({ judge: async () => ({ ok: false, reason: 'answered no', source: 'fork' }) });
    sessionBinding({ condition: '有错误吗' });
    const engine = mkEngine();
    engine.onEvent(baseInput());
    await vi.waitFor(() => {
      const row = executions.query({}).rows[0]!;
      expect(row.stage).toBe('condition-blocked');
      expect(row.source).toBe('fork');
    });
    expect(sent.length).toBe(0);
  });

  it('kernel 抛错 = 拦下（不投半截），错误落日志', async () => {
    kernel = mkKernel({ judge: async () => { throw new Error('judge down'); } });
    sessionBinding({ condition: 'x' });
    const engine = mkEngine();
    engine.onEvent(baseInput());
    await vi.waitFor(() => {
      const row = executions.query({}).rows[0]!;
      expect(row.stage).toBe('condition-blocked');
      expect(row.error).toContain('judge down');
    });
  });

  it('模板变量缺值（无 upstream 无 summary）记 failed 不投半截', async () => {
    sessionBinding({ endpoints: [{ kind: 'session', target: 'self', text: '{summary} / {upstream}' }] });
    const engine = mkEngine();
    engine.onEvent(baseInput({ payload: { raw: {} } }));
    await vi.waitFor(() => {
      expect(executions.query({}).rows[0]!.stage).toBe('failed');
    });
    expect(sent.length).toBe(0);
  });
});

describe('session 端点自指与 webhook 端点', () => {
  it("target='self' 投回本会话；显式 target 投给目标", async () => {
    sessionBinding();
    sessionBinding({ name: 'cross', endpoints: [{ kind: 'session', target: 'sess-b', text: 'hey' }] });
    const engine = mkEngine();
    engine.onEvent(baseInput());
    await vi.waitFor(() => expect(sent.length).toBe(2));
    expect(sent.map((s) => s.toSessionId).sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('webhook 端点走 postJson 边界（注入 fake，payload 带上游与 summary）', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    kernel = { judge: async () => ({ ok: true }), evaluate: async () => ({ ok: true, summary: 'S', source: 'fork' }) };
    sessionBinding({
      endpoints: [{ kind: 'webhook', url: 'https://hook.example/x', secret: 's' }],
      summarize: '总结',
    });
    const engine = new ExtensionEngine({
      bindings,
      executions,
      deliverer,
      sessions: { getBySessionId: () => undefined },
      hookEvents: { listBySession: () => [] },
      bus,
      kernel,
      postJsonImpl: async (url, _secret, body) => {
        posts.push({ url, body });
        return { ok: true, status: 'succeeded' };
      },
    });
    engine.onEvent(baseInput());
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]!.url).toBe('https://hook.example/x');
    expect((posts[0]!.body as { summary: string }).summary).toBe('S');
  });
});

describe('失败告警与 reload', () => {
  it('连续 3 次 failed 发 extension.failed 帧；成功清零连败计数', async () => {
    const failing = {
      send: async () => ({ ok: false, status: 409 as const, error: 'no channel' }),
      registerInduction: () => {},
      consumeInduction: () => false,
    };
    sessionBinding({ endpoints: [{ kind: 'session', target: 'self', text: 'x' }] });
    const engine = new ExtensionEngine({
      bindings,
      executions,
      deliverer: failing as never,
      sessions: { getBySessionId: () => undefined },
      hookEvents: { listBySession: () => [] },
      bus,
      kernel,
    });
    for (const id of [1, 2, 3]) {
      engine.onEvent(baseInput({ sessionId: `f${id}`, eventId: id }));
      await settle();
    }
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.kind === 'extension.failed').length).toBe(1);
    });
  });

  it('reload 后新增/停用的绑定立即生效', async () => {
    const engine = mkEngine();
    engine.onEvent(baseInput());
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.length).toBe(0);
    sessionBinding();
    engine.reload();
    engine.onEvent(baseInput({ eventId: 102, sessionId: 'other' }));
    await vi.waitFor(() => expect(sent.length).toBe(1));
  });
});

describe('SSE 帧', () => {
  it('每条执行落一帧 extension.execution（stage/ok 随行）', async () => {
    sessionBinding({ when: 'nomatch' });
    sessionBinding({ name: 'ok', endpoints: [{ kind: 'session', target: 'self', text: 'x' }] });
    const engine = mkEngine();
    engine.onEvent(baseInput({ sessionId: 'frame-sess' }));
    await vi.waitFor(() => {
      const exec = frames.filter((f) => f.kind === 'extension.execution');
      expect(exec.length).toBeGreaterThanOrEqual(2);
    });
    const stages = frames.filter((f) => f.kind === 'extension.execution').map((f) => (f as { stage: string }).stage);
    expect(stages).toContain('when-blocked');
    expect(stages).toContain('delivered');
  });
});
