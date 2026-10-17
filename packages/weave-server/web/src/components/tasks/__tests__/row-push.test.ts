import { describe, expect, it } from 'vitest';
import { applyRowPush } from '../session-status-store';
import type { SessionRow, SessionTerminal } from '@/lib/api';

const row = (sessionId: string, over: Partial<SessionRow> = {}): SessionRow => ({
  sessionId,
  projectId: 1,
  title: null,
  pendingTitle: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const screen = (id: string): SessionTerminal => ({ id, windowId: 1, tabId: 2, tabsInWindow: 1 });

describe('applyRowPush — push 补丁并上会话行', () => {
  it('terminal/pidAlive 缺键 = 不动（那会话这帧没报）', () => {
    const rows = [row('a', { terminal: screen('t1'), pidAlive: true })];
    expect(applyRowPush(rows, { terminal: {}, alive: {} })).toBe(rows);
  });

  it('terminal 命中即换；按 id 比，同 id 新对象不算变', () => {
    const rows = [row('a', { terminal: screen('t1') }), row('b')];
    const next = applyRowPush(rows, { terminal: { a: screen('t2'), b: screen('t9') } });
    expect(next[0].terminal?.id).toBe('t2');
    expect(next[1].terminal?.id).toBe('t9');
    // 同 id：整批不动（引用都不换，别白重渲）
    expect(applyRowPush(rows, { terminal: { a: screen('t1') } })).toBe(rows);
    // null = 确认不在了 → 摘出块外
    expect(applyRowPush(rows, { terminal: { a: null } })[0].terminal).toBeNull();
  });

  it('interrupted 缺键 = 已恢复（不在快照里即被新事件盖过）', () => {
    const rows = [row('a', { interruptedAt: 5 }), row('b', { interruptedAt: 6 })];
    const next = applyRowPush(rows, { interrupted: { b: 6 } });
    expect(next[0].interruptedAt).toBeNull();
    expect(next[1].interruptedAt).toBe(6);
  });

  it('三路可以同一帧一起并；空补丁原样返回', () => {
    const rows = [row('a')];
    const next = applyRowPush(rows, {
      terminal: { a: screen('t1') },
      alive: { a: false },
      interrupted: {},
    });
    expect(next[0].terminal?.id).toBe('t1');
    expect(next[0].pidAlive).toBe(false);
    expect(next[0].interruptedAt ?? null).toBeNull();
    expect(applyRowPush(rows, {})).toBe(rows);
  });
});
