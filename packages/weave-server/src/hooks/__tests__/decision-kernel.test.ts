import { describe, it, expect, vi } from 'vitest';
import { createDecisionKernel, parseConditionAnswer } from '../decision-kernel.js';
import type { ConditionDecision, ConditionJudge } from '../decision-kernel.js';

/**
 * 决策内核：档一（judge/judgeBatch 既有语义转发 + 缺省 fork 判断）、档二
 * （extract 透传 fork 面）、档三 evaluate（决策并总结组合 fork）。
 * evaluate 目前暂无生产调用方（编排档一/档二语义不变；扩展点绑定在批 2b
 * 落引擎时才消费此档）——单测在此防它被误判为死代码。
 */

const mkFork = (opts: {
  supports?: boolean;
  extract?: (input: { sessionId: string; prompt: string }) => Promise<string | null>;
} = {}) => ({
  supports: vi.fn(() => opts.supports ?? true),
  extract: vi.fn(
    opts.extract ?? (async () => 'yes'),
  ),
});

describe('parseConditionAnswer（迁移自编排引擎，认法不变）', () => {
  it('首个词命中 yes/no 词表；其余判不出', () => {
    expect(parseConditionAnswer('yes')).toBe(true);
    expect(parseConditionAnswer('对的 可以发')).toBe(true);
    expect(parseConditionAnswer('No。')).toBe(false);
    expect(parseConditionAnswer('不发')).toBe(false);
    expect(parseConditionAnswer('我觉得应该发一下')).toBeNull();
    expect(parseConditionAnswer(null)).toBeNull();
  });
});

describe('决策内核档一：judge', () => {
  it('注入判断链时原样转发（不造第二份判断实现）', async () => {
    const injected: ConditionJudge = {
      judge: vi.fn(async (): Promise<ConditionDecision> => ({
        ok: true,
        source: 'decision-model',
        detail: 'P(yes)=0.95',
      })),
    };
    const kernel = createDecisionKernel({ conditionJudge: injected, fork: mkFork() });
    const input = { sessionId: 'a', condition: '需要发吗', upstream: '上游输出' };
    await expect(kernel.judge(input)).resolves.toEqual({
      ok: true,
      source: 'decision-model',
      detail: 'P(yes)=0.95',
    });
    expect(injected.judge).toHaveBeenCalledWith(input);
  });

  it('判断链没实现 judgeBatch → 内核也不实现（可选档如实缺席）', () => {
    const kernel = createDecisionKernel({
      conditionJudge: { judge: async () => ({ ok: true }) },
      fork: mkFork(),
    });
    expect(kernel.judgeBatch).toBeUndefined();
  });

  it('缺省判断链 = fork 子 Agent：一次 fork 出 yes/no', async () => {
    const fork = mkFork({ extract: async () => 'yes' });
    const kernel = createDecisionKernel({ fork });
    await expect(kernel.judge({ sessionId: 'a', condition: '发吗', upstream: null })).resolves.toEqual({
      ok: true,
      source: 'fork',
    });
    expect(fork.extract).toHaveBeenCalledTimes(1);
    expect(fork.extract.mock.calls[0]![0].prompt).toContain('发吗');
  });

  it('fork 面不可用（supports=false）→ 拦下并说明原因', async () => {
    const kernel = createDecisionKernel({ fork: mkFork({ supports: false }) });
    await expect(kernel.judge({ sessionId: 'a', condition: '发吗', upstream: null })).resolves.toMatchObject({
      ok: false,
      source: 'fork',
      reason: expect.stringContaining('no context sub-agent face'),
    });
  });
});

describe('决策内核档二：extract', () => {
  it('透传 fork 面（单 fork 无头回合出文本）', async () => {
    const fork = mkFork({ extract: async () => '  提炼结果  ' });
    const kernel = createDecisionKernel({ fork });
    await expect(kernel.extract({ sessionId: 'a', prompt: '请总结' })).resolves.toBe('  提炼结果  ');
    expect(fork.extract).toHaveBeenCalledWith({ sessionId: 'a', prompt: '请总结' });
  });

  it('fork 失败 = null 原样透传（不包装、不回落）', async () => {
    const kernel = createDecisionKernel({ fork: mkFork({ extract: async () => null }) });
    await expect(kernel.extract({ sessionId: 'a', prompt: '请总结' })).resolves.toBeNull();
  });
});

describe('决策内核档三：evaluate（决策并总结组合 fork）', () => {
  it('condition+summarize：一次组合 fork 出 {answer, summary}（token ÷2）', async () => {
    const fork = mkFork({
      extract: async () => '{"answer":"yes","summary":"改动是文档更新，风险低"}',
    });
    const kernel = createDecisionKernel({ fork });
    await expect(
      kernel.evaluate({ sessionId: 'a', condition: '需要总结吗', summarize: '总结改动', upstream: '上游输出' }),
    ).resolves.toEqual({
      ok: true,
      summary: '改动是文档更新，风险低',
      source: 'fork',
      detail: 'combined fork: yes',
    });
    expect(fork.extract).toHaveBeenCalledTimes(1);
    const prompt = fork.extract.mock.calls[0]![0].prompt;
    expect(prompt).toContain('需要总结吗');
    expect(prompt).toContain('总结改动');
  });

  it('组合 fork 答 no → ok=false（拦下）、summary 照带', async () => {
    const fork = mkFork({
      extract: async () => '前置说明 {"answer":"no","summary":"无需总结"} 尾注',
    });
    const kernel = createDecisionKernel({ fork });
    await expect(
      kernel.evaluate({ sessionId: 'a', condition: '需要总结吗', summarize: '总结改动', upstream: null }),
    ).resolves.toEqual({
      ok: false,
      summary: '无需总结',
      source: 'fork',
      detail: 'combined fork: no — delivery skipped',
    });
  });

  it('组合 fork 解析失败 → 回落先 judge 后 extract 两段式', async () => {
    const fork = mkFork({
      extract: vi.fn(async (input: { prompt: string }) =>
        input.prompt.includes('exactly one word') ? 'yes' : input.prompt.includes('{"answer"') ? '我判不出（无 JSON）' : '两段式总结',
      ),
    });
    const kernel = createDecisionKernel({ fork });
    const result = await kernel.evaluate({
      sessionId: 'a',
      condition: '需要总结吗',
      summarize: '总结改动',
      upstream: '上游输出',
    });
    expect(result).toMatchObject({ ok: true, summary: '两段式总结', source: 'fork' });
    expect(fork.extract).toHaveBeenCalledTimes(3);
  });

  it('组合 fork 判 no 且解析失败 → 两段式判 no 即拦下、不再烧总结 fork', async () => {
    const fork = mkFork({
      extract: vi.fn(async (input: { prompt: string }) =>
        input.prompt.includes('exactly one word') ? 'no' : '我判不出（无 JSON）',
      ),
    });
    const kernel = createDecisionKernel({ fork });
    const result = await kernel.evaluate({
      sessionId: 'a',
      condition: '需要总结吗',
      summarize: '总结改动',
      upstream: null,
    });
    expect(result).toMatchObject({ ok: false, summary: null, source: 'fork' });
    expect(fork.extract).toHaveBeenCalledTimes(2);
  });

  it('仅 summarize：单 fork 只出 summary，ok 恒 true', async () => {
    const fork = mkFork({ extract: async () => '只有总结' });
    const kernel = createDecisionKernel({ fork });
    await expect(kernel.evaluate({ sessionId: 'a', summarize: '总结改动', upstream: null })).resolves.toEqual({
      ok: true,
      summary: '只有总结',
      source: 'fork',
    });
  });

  it('仅 condition：fork 判断（决策模型优先分支缓做，编排档一语义不变）', async () => {
    const fork = mkFork({ extract: async () => 'no' });
    const kernel = createDecisionKernel({ fork });
    await expect(kernel.evaluate({ sessionId: 'a', condition: '发吗', upstream: null })).resolves.toMatchObject({
      ok: false,
      summary: null,
      source: 'fork',
      detail: 'condition answered no — delivery skipped',
    });
  });

  it('两者都缺：恒放行、零 fork', async () => {
    const fork = mkFork();
    const kernel = createDecisionKernel({ fork });
    await expect(kernel.evaluate({ sessionId: 'a', upstream: null })).resolves.toEqual({
      ok: true,
      summary: null,
      source: 'fork',
    });
    expect(fork.extract).not.toHaveBeenCalled();
  });

  it('fork 面不可用：summary=null、仅 condition 时判不出 = 拦下', async () => {
    const kernel = createDecisionKernel({ fork: mkFork({ supports: false }) });
    await expect(
      kernel.evaluate({ sessionId: 'a', summarize: '总结改动', upstream: null }),
    ).resolves.toEqual({ ok: true, summary: null, source: 'fork' });
    await expect(
      kernel.evaluate({ sessionId: 'a', condition: '发吗', summarize: '总结改动', upstream: null }),
    ).resolves.toMatchObject({
      ok: false,
      summary: null,
      source: 'fork',
      detail: expect.stringContaining('no context sub-agent face'),
    });
  });
});
