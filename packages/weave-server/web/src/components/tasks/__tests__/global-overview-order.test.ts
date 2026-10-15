import { describe, expect, it } from 'vitest';
import type { SessionRow } from '@/lib/api';
import { globalOverviewRows } from '../GlobalTasksOverview';
import { byActivity } from '../SessionList';

const row = (over: Partial<SessionRow> & { sessionId: string }): SessionRow => ({
  projectId: 1,
  title: null,
  pendingTitle: null,
  lastSeenAt: '2026-10-15T00:00:00.000Z',
  createdAt: '2026-10-15T00:00:00.000Z',
  ...over,
});

/**
 * 全局总览行序口径：与会话列表逐行同口径——活动序（byActivity）跨项目混排，
 * 不按项目分组。落地序由调用方门控冻结（useActivityOrder），本函数只吃已冻结
 * 的顺序快照。
 */
describe('globalOverviewRows（活动序，跨项目混排）', () => {
  it('按冻结的活动序逐行渲染，同项目的旧会话不因分组上浮', () => {
    const b1 = row({ sessionId: 'b-new', projectId: 2, lastSeenAt: '2026-10-15T10:00:00.000Z' });
    const a1 = row({ sessionId: 'a-new', projectId: 1, lastSeenAt: '2026-10-15T09:00:00.000Z' });
    const b2 = row({ sessionId: 'b-old', projectId: 2, lastSeenAt: '2026-10-15T08:00:00.000Z' });
    const a2 = row({ sessionId: 'a-old', projectId: 1, lastSeenAt: '2026-10-15T07:00:00.000Z' });
    const all = [b1, a1, b2, a2];
    const applied = all.slice().sort(byActivity).map((s) => s.sessionId);

    expect(globalOverviewRows(all, applied).map((s) => s.sessionId)).toEqual([
      'b-new',
      'a-new',
      'b-old',
      'a-old',
    ]);
  });

  it('冻结序未见的新行按「新在前」兜底置顶', () => {
    const old = row({ sessionId: 'old', projectId: 1 });
    const fresh = row({ sessionId: 'fresh', projectId: 3 });
    expect(globalOverviewRows([old, fresh], ['old']).map((s) => s.sessionId)).toEqual([
      'fresh',
      'old',
    ]);
  });

  it('冻结序里已消失的会话即时移除', () => {
    const live = row({ sessionId: 'live', projectId: 1 });
    expect(globalOverviewRows([live], ['gone', 'live']).map((s) => s.sessionId)).toEqual(['live']);
  });
});
