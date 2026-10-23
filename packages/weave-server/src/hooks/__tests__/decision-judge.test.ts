import { describe, it, expect, vi } from 'vitest';
import { createDecisionConditionJudge } from '../decision-judge.js';
import type { ConditionDecision, ConditionJudge } from '../orchestration-engine.js';

/**
 * 决策模型判断（Jev 兼容 noul）：阈值三段（≥0.7 放行 / ≤0.3 拦下 / 中间带回落
 * fork）与一切失败路径（未配置、无上游文本、网络/超时/坏响应）都回落 fork。
 */

const INPUT = { sessionId: 'a', condition: '需要发吗', upstream: '上游这一轮的输出' };

const mk = (opts: {
  noul?: number;
  configured?: boolean;
  status?: number;
  body?: string;
  hang?: boolean;
  fallback?: ConditionDecision;
} = {}) => {
  const fallback = vi.fn(async (): Promise<ConditionDecision> => opts.fallback ?? { ok: true });
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
    if (opts.hang) {
      // 真实 fetch 会因 abort 拒绝——挂起的 mock 也要接 signal，否则永不落定。
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return new Response(opts.body ?? JSON.stringify({ answers: { proceed: { type: 'noul', noul: opts.noul ?? 0.9 } } }), {
      status: opts.status ?? 200,
    });
  });
  const judge = createDecisionConditionJudge({
    config: async () =>
      opts.configured === false
        ? null
        : { baseUrl: 'https://d.example/', model: 'decision-model', apiKey: 'k' },
    fallback: { judge: fallback } as ConditionJudge,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(opts.hang ? { timeoutMs: 20 } : {}),
  });
  return { judge, fallback, fetchImpl };
};

describe('决策模型判断（createDecisionConditionJudge）', () => {
  it('P(yes)≥0.7 → 放行（source/detail 落痕），fork 不跑', async () => {
    const { judge, fallback } = mk({ noul: 0.95 });
    await expect(judge.judge(INPUT)).resolves.toEqual({
      ok: true,
      source: 'decision-model',
      detail: 'P(yes)=0.95',
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('P(yes)≤0.3 → 拦下带概率原因与来源，fork 不跑', async () => {
    const { judge, fallback } = mk({ noul: 0.05 });
    await expect(judge.judge(INPUT)).resolves.toMatchObject({
      ok: false,
      source: 'decision-model',
      detail: 'P(yes)=0.05',
      reason: expect.stringContaining('condition answered no'),
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('中间带（判不准）→ 回落 fork（结果标 fork 来源）', async () => {
    const { judge, fallback } = mk({ noul: 0.5, fallback: { ok: false, reason: 'fork said no' } });
    await expect(judge.judge(INPUT)).resolves.toEqual({
      ok: false,
      reason: 'fork said no',
      source: 'fork',
    });
    expect(fallback).toHaveBeenCalledWith(INPUT);
  });

  it('未配置 → 回落 fork，一次 HTTP 都不发', async () => {
    const { judge, fallback, fetchImpl } = mk({ configured: false });
    await judge.judge(INPUT);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('上游无文本 → 回落 fork（决策模型只看得到 state）', async () => {
    const { judge, fallback, fetchImpl } = mk({ noul: 0.95 });
    await judge.judge({ ...INPUT, upstream: null });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('非 200 / 坏响应 / 网络抛错 → 都回落 fork', async () => {
    for (const opts of [{ status: 500 }, { status: 401 }, { body: 'not json' }, { body: '{}' }]) {
      const { judge, fallback } = mk(opts);
      await expect(judge.judge(INPUT)).resolves.toEqual({ ok: true, source: 'fork' });
      expect(fallback).toHaveBeenCalledTimes(1);
    }
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const judge = createDecisionConditionJudge({
      config: async () => ({ baseUrl: 'https://d.example', model: 'm', apiKey: 'k' }),
      fallback: { judge: vi.fn(async () => ({ ok: true })) } as ConditionJudge,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(judge.judge(INPUT)).resolves.toEqual({ ok: true, source: 'fork' });
  });

  it('超时（AbortController）→ 回落 fork', async () => {
    const { judge, fallback } = mk({ hang: true });
    await expect(judge.judge(INPUT)).resolves.toEqual({ ok: true, source: 'fork' });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('请求形状：{baseUrl}/v1/systemone + Bearer + noul 问题（state=上游输出）', async () => {
    const { judge, fetchImpl } = mk({ noul: 0.9 });
    await judge.judge(INPUT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://d.example/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'decision-model',
      state: '上游这一轮的输出',
      questions: { proceed: { type: 'noul', instructions: '需要发吗' } },
    });
  });
});

describe('决策模型批量判定（judgeBatch）', () => {
  it('一次 HTTP 答多条边：逐键阈值判定，source/detail 随行', async () => {
    const fallback = vi.fn(async (): Promise<ConditionDecision> => ({ ok: true }));
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const keys = Object.keys(body.questions);
      expect(keys.sort()).toEqual(['e1', 'e2']); // 两条边一次请求
      return new Response(
        JSON.stringify({ answers: { e1: { noul: 0.9 }, e2: { noul: 0.1 } } }),
        { status: 200 },
      );
    });
    const judge = createDecisionConditionJudge({
      config: async () => ({ baseUrl: 'https://d.example/', model: 'm', apiKey: 'k' }),
      fallback: { judge: fallback } as ConditionJudge,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await judge.judgeBatch!({
      sessionId: 'a',
      items: [
        { key: 'e1', condition: '发 b 吗' },
        { key: 'e2', condition: '发 c 吗' },
      ],
      upstream: '输出',
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(out[0]).toEqual({ ok: true, source: 'decision-model', detail: 'P(yes)=0.9' });
    expect(out[1]!.ok).toBe(false);
    expect(out[1]!.source).toBe('decision-model');
    expect(out[1]!.detail).toBe('P(yes)=0.1');
  });

  it('某键判不出 → 该键回落 fork，其他键照常', async () => {
    const fallback = vi.fn(async (): Promise<ConditionDecision> => ({ ok: false, reason: 'fork no' }));
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      new Response(JSON.stringify({ answers: { e1: { noul: 0.9 } } }), { status: 200 }));
    const judge = createDecisionConditionJudge({
      config: async () => ({ baseUrl: 'https://d.example/', model: 'm', apiKey: 'k' }),
      fallback: { judge: fallback } as ConditionJudge,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await judge.judgeBatch!({
      sessionId: 'a',
      items: [
        { key: 'e1', condition: 'x' },
        { key: 'e2', condition: 'y' },
      ],
      upstream: '输出',
    });
    expect(out[0]).toMatchObject({ ok: true, source: 'decision-model' });
    expect(out[1]).toMatchObject({ ok: false, source: 'fork', reason: 'fork no' });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('未配置 → 整批回落 fork', async () => {
    const fallback = vi.fn(async (): Promise<ConditionDecision> => ({ ok: true, source: 'fork' }));
    const fetchImpl = vi.fn();
    const judge = createDecisionConditionJudge({
      config: async () => null,
      fallback: { judge: fallback } as ConditionJudge,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await judge.judgeBatch!({
      sessionId: 'a',
      items: [{ key: 'e1', condition: 'x' }],
      upstream: '输出',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ ok: true, source: 'fork' });
  });
});
