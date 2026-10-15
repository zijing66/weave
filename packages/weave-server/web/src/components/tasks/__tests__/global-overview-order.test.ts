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
 * 全局总览行序口径：先活动序（byActivity），再按项目分桶（首次出现定组序 =
 * 组间按各自最新活跃、同项目相邻，组内保持活动序）。落地序由调用方门控冻结
 *（useActivityOrder），本函数只吃已冻结的顺序快照。
 */
describe('globalOverviewRows（活动序 + 项目分桶）', () => {
  it('组间按各自最新活跃、同项目相邻、组内保持活动序', () => {
    const b1 = row({ sessionId: 'b-new', projectId: 2, lastSeenAt: '2026-10-15T10:00:00.000Z' });
    const a1 = row({ sessionId: 'a-new', projectId: 1, lastSeenAt: '2026-10-15T09:00:00.000Z' });
    const b2 = row({ sessionId: 'b-old', projectId: 2, lastSeenAt: '2026-10-15T08:00:00.000Z' });
    const a2 = row({ sessionId: 'a-old', projectId: 1, lastSeenAt: '2026-10-15T07:00:00.000Z' });
    const all = [b1, a1, b2, a2];
    const applied = all.slice().sort(byActivity).map((s) => s.sessionId);

    expect(globalOverviewRows(all, applied).map((s) => s.sessionId)).toEqual([
      'b-new',
      'b-old',
      'a-new',
      'a-old',
    ]);
  });

  it('跨项目交错的活动序：项目组随之整体上浮（组序 = 该组最新一条的位次）', () => {
    const a = row({ sessionId: 'a-mid', projectId: 1, lastSeenAt: '2026-10-15T09:00:00.000Z' });
    const b = row({ sessionId: 'b-top', projectId: 2, lastSeenAt: '2026-10-15T10:00:00.000Z' });
    const a2 = row({ sessionId: 'a-low', projectId: 1, lastSeenAt: '2026-10-15T08:00:00.000Z' });
    const all = [a, b, a2];
    const applied = all.slice().sort(byActivity).map((s) => s.sessionId);

    expect(globalOverviewRows(all, applied).map((s) => s.sessionId)).toEqual(['b-top', 'a-mid', 'a-low']);
  });

  it('冻结序未见的新行按「新在前」兜底置顶', () => {
    const old = row({ sessionId: 'old', projectId: 1 });
    const fresh = row({ sessionId: 'fresh', projectId: 3 });
    expect(globalOverviewRows([old, fresh], ['old']).map((s) => s.sessionId)).toEqual(['fresh', 'old']);
  });

  it('未知项目（projectId null）归同一尾桶', () => {
    const known = row({ sessionId: 'k', projectId: 1 });
    const unknown = row({ sessionId: 'u', projectId: null });
    const unknown2 = row({ sessionId: 'u2', projectId: null });
    expect(globalOverviewRows([known, unknown, unknown2], ['k', 'u', 'u2']).map((s) => s.sessionId)).toEqual([
      'k',
      'u',
      'u2',
    ]);
  });
});
