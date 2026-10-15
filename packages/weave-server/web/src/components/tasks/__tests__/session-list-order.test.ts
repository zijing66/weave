import { describe, it, expect } from 'vitest';
import type { SessionRow } from '@/lib/api';
import { byActivity } from '../SessionList';

const row = (over: Partial<SessionRow>): SessionRow => ({
  sessionId: 's',
  projectId: 1,
  title: null,
  pendingTitle: null,
  lastSeenAt: '2026-10-15T00:00:00.000Z',
  createdAt: '2026-10-15T00:00:00.000Z',
  ...over,
});

/**
 * 会话列表排序口径（byActivity）：活动序——lastSeenAt 倒序、createdAt 决胜。
 * 静默列表（lastSeenAt 同为各自创建时刻）等价创建时间倒序；活跃会话上浮。
 */

describe('byActivity（活动序）', () => {
  it('lastSeenAt 新的在前：活跃的老会话浮到最新创建的之上', () => {
    const ordered = [
      row({ sessionId: 'old-active', createdAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-15T09:00:00.000Z' }),
      row({ sessionId: 'new-idle', createdAt: '2026-10-15T08:00:00.000Z', lastSeenAt: '2026-10-15T08:00:00.000Z' }),
    ];
    const list = [ordered[1]!, ordered[0]!];
    expect(list.slice().sort(byActivity).map((s) => s.sessionId)).toEqual([
      'old-active',
      'new-idle',
    ]);
  });

  it('lastSeenAt 并列时 createdAt 决胜：新创建的在前（静默列表 = 创建时间倒序）', () => {
    const list = [
      row({ sessionId: 'a', createdAt: '2026-10-10T00:00:00.000Z', lastSeenAt: '2026-10-10T00:00:00.000Z' }),
      row({ sessionId: 'c', createdAt: '2026-10-14T00:00:00.000Z', lastSeenAt: '2026-10-14T00:00:00.000Z' }),
      row({ sessionId: 'b', createdAt: '2026-10-12T00:00:00.000Z', lastSeenAt: '2026-10-12T00:00:00.000Z' }),
    ];
    expect(list.slice().sort(byActivity).map((s) => s.sessionId)).toEqual(['c', 'b', 'a']);
  });
});
