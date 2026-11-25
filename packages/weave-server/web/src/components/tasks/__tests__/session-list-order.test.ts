import { describe, it, expect } from 'vitest';
import type { SessionRow } from '@/lib/api';
import { byActivity, mergeNewRows, archiveExempt, olderThanDays } from '../SessionList';
import type { SessionStatus } from '../session-status';

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
 * 顺序落地（mergeNewRows）：既有行的重排只由周期 tick 落地，成员增删路径只
 * 做「新行置顶 + 消失行移除」，既有行相对序冻结。
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

  it('给 statuses 时已关闭类（closed/terminated/gone）整体沉底，层内仍按活动序', () => {
    const statuses = new Map<string, SessionStatus>([
      ['closed-recent', 'closed'],
      ['gone-old', 'gone'],
      ['open-old', 'open'],
      ['run-new', 'running'],
    ]);
    const list = [
      // closed 但 lastSeenAt 最新——不给 statuses 时它排第一，会压住刚打开的
      row({ sessionId: 'closed-recent', createdAt: '2026-10-15T12:00:00.000Z', lastSeenAt: '2026-10-15T12:00:00.000Z' }),
      row({ sessionId: 'open-old', createdAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-15T09:00:00.000Z' }),
      row({ sessionId: 'run-new', createdAt: '2026-10-15T08:00:00.000Z', lastSeenAt: '2026-10-15T08:00:00.000Z' }),
      row({ sessionId: 'gone-old', createdAt: '2026-10-02T00:00:00.000Z', lastSeenAt: '2026-10-03T00:00:00.000Z' }),
    ];
    expect(
      list.slice().sort((a, b) => byActivity(a, b, statuses)).map((s) => s.sessionId),
    ).toEqual(['open-old', 'run-new', 'closed-recent', 'gone-old']);
  });

  it('不给 statuses 时行为不变（旧口径）', () => {
    const list = [
      row({ sessionId: 'closed-recent', createdAt: '2026-10-15T12:00:00.000Z', lastSeenAt: '2026-10-15T12:00:00.000Z' }),
      row({ sessionId: 'open-old', createdAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-15T09:00:00.000Z' }),
    ];
    expect(list.slice().sort(byActivity).map((s) => s.sessionId)).toEqual(['closed-recent', 'open-old']);
  });
});

describe('mergeNewRows（成员增删时的顺序快照合并）', () => {
  it('既有行相对序冻结：活动序变了也不重排，等周期 tick 落地', () => {
    expect(mergeNewRows(['a', 'b'], ['b', 'a'])).toEqual(['a', 'b']);
  });

  it('新行即时置顶（先后取 sorted）', () => {
    expect(mergeNewRows(['a', 'b'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
    expect(mergeNewRows(['a', 'b'], ['d', 'c', 'a'])).toEqual(['d', 'c', 'a']);
  });

  it('消失行即时移除，其余相对序不变', () => {
    expect(mergeNewRows(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c']);
  });

  it('无成员变化时内容不变（同序引用由调用方检查）', () => {
    expect(mergeNewRows(['a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('olderThanDays / archiveExempt（收纳分区）', () => {
  const NOW = Date.parse('2026-11-17T00:00:00.000Z');
  const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();
  const base = { pidAlive: false as const };

  it('lastSeenAt 超过 n 天才收纳；n=0 关闭', () => {
    const r = row({ lastSeenAt: daysAgo(6), pidAlive: null });
    expect(olderThanDays(r, 5, NOW)).toBe(true);
    expect(olderThanDays(row({ lastSeenAt: daysAgo(5), pidAlive: null }), 5, NOW)).toBe(false);
    expect(olderThanDays(r, 0, NOW)).toBe(false);
  });

  it('豁免：运行中/失败/选中/活进程/待答/在途/失败投递/草稿都不收纳，就绪旧会话收纳', () => {
    const old = (over: Partial<SessionRow>): SessionRow => row({ lastSeenAt: daysAgo(30), ...over });
    const noSignals = { question: false, inflight: 0, failed: 0, draft: false };
    expect(archiveExempt(old(base), 'open', false, noSignals)).toBe(false);
    expect(archiveExempt(old({ ...base, pidAlive: true }), 'open', false, noSignals)).toBe(true);
    for (const status of ['running', 'compacting', 'failed'] as const) {
      expect(archiveExempt(old(base), status, false, noSignals)).toBe(true);
    }
    expect(archiveExempt(old(base), 'open', true, noSignals)).toBe(true);
    expect(archiveExempt(old(base), 'open', false, { ...noSignals, question: true })).toBe(true);
    expect(archiveExempt(old(base), 'open', false, { ...noSignals, inflight: 2 })).toBe(true);
    expect(archiveExempt(old(base), 'open', false, { ...noSignals, failed: 1 })).toBe(true);
    expect(archiveExempt(old(base), 'open', false, { ...noSignals, draft: true })).toBe(true);
  });
});
