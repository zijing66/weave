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
        : { baseUrl: 'https://d.example/', model: 'ftm-decision', apiKey: 'k' },
    fallback: { judge: fallback } as ConditionJudge,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(opts.hang ? { timeoutMs: 20 } : {}),
  });
  return { judge, fallback, fetchImpl };
};

describe('决策模型判断（createDecisionConditionJudge）', () => {
  it('P(yes)≥0.7 → 放行，fork 不跑', async () => {
    const { judge, fallback } = mk({ noul: 0.95 });
    await expect(judge.judge(INPUT)).resolves.toEqual({ ok: true });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('P(yes)≤0.3 → 拦下带概率原因，fork 不跑', async () => {
    const { judge, fallback } = mk({ noul: 0.05 });
    await expect(judge.judge(INPUT)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('P(yes)=0.05'),
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('中间带（判不准）→ 回落 fork', async () => {
    const { judge, fallback } = mk({ noul: 0.5, fallback: { ok: false, reason: 'fork said no' } });
    await expect(judge.judge(INPUT)).resolves.toEqual({ ok: false, reason: 'fork said no' });
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
      await expect(judge.judge(INPUT)).resolves.toEqual({ ok: true });
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
    await expect(judge.judge(INPUT)).resolves.toEqual({ ok: true });
  });

  it('超时（AbortController）→ 回落 fork', async () => {
    const { judge, fallback } = mk({ hang: true });
    await expect(judge.judge(INPUT)).resolves.toEqual({ ok: true });
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
      model: 'ftm-decision',
      state: '上游这一轮的输出',
      questions: { proceed: { type: 'noul', instructions: '需要发吗' } },
    });
  });
});
