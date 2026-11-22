import { describe, expect, it } from 'vitest';
import type { AgentInstanceRecord } from '../protocol.js';
import { isTerminalStatus, reconcileInstances } from '../instance-registry.js';

function row(partial: Partial<AgentInstanceRecord>): AgentInstanceRecord {
  return {
    id: 'inst-1',
    projectId: 1,
    harness: 'claude',
    status: 'running',
    executionMode: 'headless',
    workingDirectory: 'D:/repo',
    command: 'claude',
    createdAt: '2026-11-20T00:00:00.000Z',
    ...partial,
  };
}

describe('reconcileInstances', () => {
  it('刷新 Host 上报变化的 pid / harness 会话 id', () => {
    const plan = reconcileInstances([row({ osPid: 1 })], [{ id: 'inst-1', osPid: 2 }]);
    expect(plan.refresh).toEqual([{ id: 'inst-1', osPid: 2, harnessSessionId: undefined }]);
    expect(plan.lost).toEqual([]);
    expect(plan.unknown).toEqual([]);
  });

  it('Host 不再报的活行判 failed；终态行不动', () => {
    const plan = reconcileInstances(
      [row({ id: 'a', status: 'running' }), row({ id: 'b', status: 'exited' })],
      [],
    );
    expect(plan.lost.map((l) => l.id)).toEqual(['a']);
    expect(plan.refresh).toEqual([]);
  });

  it('Host 报了但库里没有的行进 unknown（待登记）', () => {
    const plan = reconcileInstances([], [{ id: 'inst-9', osPid: 9 }]);
    expect(plan.unknown).toEqual([{ id: 'inst-9', osPid: 9 }]);
  });

  it('两边一致且无变化时空计划', () => {
    const plan = reconcileInstances([row({ osPid: 5, harnessSessionId: 's1' })], [
      { id: 'inst-1', osPid: 5, harnessSessionId: 's1' },
    ]);
    expect(plan).toEqual({ refresh: [], lost: [], unknown: [] });
  });

  it('isTerminalStatus 只认 exited / failed', () => {
    expect(isTerminalStatus('exited')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('recovering')).toBe(false);
    expect(isTerminalStatus('running')).toBe(false);
  });
});
