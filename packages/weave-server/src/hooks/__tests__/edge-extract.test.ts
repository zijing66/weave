import { describe, it, expect, vi } from 'vitest';
import type { MessagingSurface, ResumeCommandSpec } from '@weavecode/harness';
import { createEdgeExtract } from '../edge-extract.js';
import type { HeadlessRunner, HeadlessRunInput } from '../headless-runner.js';

/**
 * 编排边级提取（EdgeExtract）专属单测（此前零专属测试）：supports 判据 /
 * run 产出链 / 并发满回落三案。fork 的真进程面（headless-runner）用假实现——
 * 这里只验 edge-extract 自己的组装与闸，不重复 headless-runner.test 的账。
 */

const SPEC: ResumeCommandSpec = {
  bin: 'claude',
  args: () => [],
  extractArgs: (sessionId, forkSessionId) => ['--resume', sessionId, '--fork', forkSessionId],
};

const surface = (spec: ResumeCommandSpec | null): MessagingSurface =>
  ({
    id: 'claude',
    harness: 'claude',
    headless: spec,
  }) as unknown as MessagingSurface;

interface Settle {
  resolve(result: { status: 'succeeded' | 'failed' | 'timeout'; output: string | null; error: string | null }): void;
}

const mkHeadless = () => {
  const pending = new Map<number, Settle>();
  let started = 0;
  const runner: HeadlessRunner = {
    run(input: HeadlessRunInput): boolean {
      started++;
      const token = started;
      pending.set(token, {
        resolve: (result) => input.onSettle(result),
      });
      return true;
    },
  };
  return {
    runner: runner as HeadlessRunner,
    settle: (result: { status: 'succeeded' | 'failed' | 'timeout'; output: string | null; error: string | null }) => {
      const [first] = [...pending.values()];
      pending.delete([...pending.keys()][0]!);
      first.resolve(result);
    },
    startedCount: () => started,
  };
};

const mkDeps = (opts: {
  surface?: MessagingSurface;
  harness?: string | null;
  concurrency?: number;
  headless?: HeadlessRunner;
} = {}) => {
  const headless = opts.headless ?? mkHeadless();
  return {
    headless,
    deps: {
      sessions: { getBySessionId: vi.fn(() => ({ sessionId: 'a', projectId: 1 })) },
      projects: { getById: vi.fn(() => ({ id: 1, path: '/repo' })) },
      harnessOf: vi.fn(() => (opts.harness === undefined ? 'claude' : opts.harness)),
      surfaceFor: vi.fn(() => opts.surface ?? surface(SPEC)),
      headless: headless.runner,
      onSyntheticChange: vi.fn(),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    },
  };
};

describe('EdgeExtract（编排边级提取）', () => {
  it('supports：面带 extractArgs = true；面为 null / extractArgs 缺席 / harness 未知 = false', () => {
    const { deps } = mkDeps();
    const extract = createEdgeExtract(deps);
    expect(extract.supports('a')).toBe(true);

    const noSpec = createEdgeExtract(mkDeps({ surface: surface(null) }).deps);
    expect(noSpec.supports('a')).toBe(false);

    const noArgs = createEdgeExtract(
      mkDeps({ surface: surface({ bin: 'codex', args: () => [] } as ResumeCommandSpec) }).deps,
    );
    expect(noArgs.supports('a')).toBe(false);

    const unknown = createEdgeExtract(mkDeps({ harness: null }).deps);
    expect(unknown.supports('a')).toBe(false);
  });

  it('run：fork 无头回合成功 → 裁边空白出文本；失败/空输出 = null', async () => {
    const first = mkDeps();
    const extract = createEdgeExtract(first.deps);
    const p1 = extract.run({ sessionId: 'a', prompt: '请总结' });
    first.headless.settle({ status: 'succeeded', output: '  总结内容  \n', error: null });
    await expect(p1).resolves.toBe('总结内容');
    expect(first.deps.onSyntheticChange).toHaveBeenCalled();

    const second = mkDeps();
    const extract2 = createEdgeExtract(second.deps);
    const p2 = extract2.run({ sessionId: 'a', prompt: '请总结' });
    second.headless.settle({ status: 'failed', output: null, error: 'boom' });
    await expect(p2).resolves.toBeNull();

    const third = mkDeps();
    const extract3 = createEdgeExtract(third.deps);
    const p3 = extract3.run({ sessionId: 'a', prompt: '请总结' });
    third.headless.settle({ status: 'succeeded', output: '   \n', error: null });
    await expect(p3).resolves.toBeNull();
  });

  it('run：会话缺 projectId / harness 未知 / 面无 extractArgs = null（不 spawn）', async () => {
    const noProject = mkDeps();
    (noProject.deps.sessions.getBySessionId as ReturnType<typeof vi.fn>).mockReturnValue({
      sessionId: 'a',
      projectId: null,
    });
    await expect(createEdgeExtract(noProject.deps).run({ sessionId: 'a', prompt: 'p' })).resolves.toBeNull();

    const noHarness = mkDeps({ harness: null });
    await expect(createEdgeExtract(noHarness.deps).run({ sessionId: 'a', prompt: 'p' })).resolves.toBeNull();

    const noArgs = mkDeps({
      surface: surface({ bin: 'codex', args: () => [] } as ResumeCommandSpec),
    });
    await expect(createEdgeExtract(noArgs.deps).run({ sessionId: 'a', prompt: 'p' })).resolves.toBeNull();
  });

  it('并发满回落：4 槽占满后再 run 立即 null（静默，不排队）', async () => {
    const { headless, deps } = mkDeps({ concurrency: 2 });
    const extract = createEdgeExtract(deps);
    const runs = [extract.run({ sessionId: 'a', prompt: '1' }), extract.run({ sessionId: 'a', prompt: '2' })];
    await expect(extract.run({ sessionId: 'a', prompt: '3' })).resolves.toBeNull();
    expect(headless.startedCount()).toBe(2);
    headless.settle({ status: 'succeeded', output: 'out1', error: null });
    headless.settle({ status: 'succeeded', output: 'out2', error: null });
    await expect(Promise.all(runs)).resolves.toEqual(['out1', 'out2']);
    // 槽释放后可再跑
    const again = extract.run({ sessionId: 'a', prompt: '4' });
    headless.settle({ status: 'succeeded', output: 'out4', error: null });
    await expect(again).resolves.toBe('out4');
  });
});
