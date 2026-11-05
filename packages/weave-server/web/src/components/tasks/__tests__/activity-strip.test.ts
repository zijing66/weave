import { describe, expect, it } from 'vitest';
import { activityCountsOf, popoverBox, recentFirst, runningCountsOf } from '../activity-strip';
import type { SessionActivity } from '@/lib/api';

const base = (partial: Partial<SessionActivity>): SessionActivity => ({
  supported: true,
  agents: [],
  tasks: null,
  shells: [],
  ...partial,
});

describe('activityCountsOf', () => {
  it('无活动 → has:false（按钮 disabled、不弹空壳）', () => {
    expect(activityCountsOf(base({}))).toMatchObject({ has: false, agents: 0, shells: 0, tasksTotal: 0 });
    expect(activityCountsOf(null).has).toBe(false);
  });

  it('codex 的 supported:false（全 null）同样 has:false', () => {
    expect(activityCountsOf({ supported: false, agents: null, tasks: null, shells: null }).has).toBe(false);
  });

  it('任务进度 n/m 只数 completed', () => {
    const counts = activityCountsOf(
      base({
        tasks: [
          { id: '1', subject: 'a', status: 'completed', blocks: [], blockedBy: [] },
          { id: '2', subject: 'b', status: 'in_progress', blocks: [], blockedBy: [] },
          { id: '3', subject: 'c', status: 'pending', blocks: [], blockedBy: [] },
        ],
      }),
    );
    expect(counts).toMatchObject({ tasksDone: 1, tasksTotal: 3, has: true });
  });

  it('只有子 agent / 只有 shell 也算有活动', () => {
    expect(
      activityCountsOf(
        base({
          agents: [
            { agentId: 'a', status: 'running', transcriptPath: null, startedAt: null },
          ],
        }),
      ).has,
    ).toBe(true);
    expect(
      activityCountsOf(
        base({ shells: [{ taskId: 't', status: 'running', lastSeenAt: '2026-11-04T00:00:00Z' }] }),
      ).has,
    ).toBe(true);
  });

  it('已停止但也还在的子 agent 照常计数（存量由 server 过滤，前端不看状态）', () => {
    expect(
      activityCountsOf(
        base({
          agents: [
            { agentId: 'a', status: 'completed', transcriptPath: null, startedAt: null },
            { agentId: 'b', status: 'running', transcriptPath: null, startedAt: null },
          ],
        }),
      ),
    ).toMatchObject({ agents: 2, has: true });
  });
});

describe('runningCountsOf（图标上的分色计数）', () => {
  it('只数正在活动的：agent/shell = running、任务 = in_progress', () => {
    expect(
      runningCountsOf(
        base({
          agents: [
            { agentId: 'a', status: 'running', transcriptPath: null, startedAt: null },
            { agentId: 'b', status: 'completed', transcriptPath: null, startedAt: null },
          ],
          tasks: [
            { id: '1', subject: 'a', status: 'in_progress', blocks: [], blockedBy: [] },
            { id: '2', subject: 'b', status: 'completed', blocks: [], blockedBy: [] },
          ],
          shells: [{ taskId: 's', status: 'running', lastSeenAt: '2026-11-04T00:00:00Z' }],
        }),
      ),
    ).toEqual({ agents: 1, tasks: 1, shells: 1 });
  });

  it('全停了 → 三个都是 0（按钮退回总数）', () => {
    expect(runningCountsOf(null)).toEqual({ agents: 0, tasks: 0, shells: 0 });
  });
});

describe('popoverBox', () => {
  it('宽屏：按设计宽 440 摆，left 跟着锚点', () => {
    expect(popoverBox(300, 1440)).toEqual({ left: 300, width: 440 });
  });

  it('窄屏（手机 390）：宽度收到视口内，弹层不越界', () => {
    const { left, width } = popoverBox(300, 390);
    expect(width).toBe(374);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + width).toBeLessThanOrEqual(390 - 8);
  });

  it('界面缩放 125%：设计宽按缩放放大后再收，不会甩出屏幕', () => {
    const { left, width } = popoverBox(10, 390, 125);
    expect(width).toBe(374);
    expect(left).toBe(8);
  });
});

describe('recentFirst', () => {
  it('子 agent 按最近写入倒序（缺 updatedAt 退回 startedAt）', () => {
    const rows = recentFirst([
      { agentId: 'old', startedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:10:00Z' },
      { agentId: 'new', startedAt: '2026-11-03T00:00:00Z' },
      { agentId: 'mid', startedAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T09:00:00Z' },
    ]);
    expect(rows.map((r) => r.agentId)).toEqual(['new', 'mid', 'old']);
  });

  it('shell 按 lastSeenAt 倒序；没有时间的排最后', () => {
    const rows = recentFirst([
      { taskId: 'none' },
      { taskId: 'a', lastSeenAt: '2026-11-04T01:00:00Z' },
      { taskId: 'b', lastSeenAt: '2026-11-04T03:00:00Z' },
    ]);
    expect(rows.map((r) => r.taskId)).toEqual(['b', 'a', 'none']);
  });
});
