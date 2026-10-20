import { describe, it, expect } from 'vitest';
import type { SessionRow, SessionTerminal } from '@/lib/api';
import { groupByTerminal } from '../SessionList';

const row = (sessionId: string, terminal: SessionTerminal | null): SessionRow => ({
  sessionId,
  projectId: 1,
  title: null,
  pendingTitle: null,
  lastSeenAt: '2026-10-15T00:00:00.000Z',
  createdAt: '2026-10-15T00:00:00.000Z',
  terminal,
});

const screen = (id: string): SessionTerminal => ({
  id,
  windowId: 0,
  tabId: Number(id.split(':')[2] ?? 0),
  tabsInWindow: 1,
});

/** 渲染项的紧凑形状（断言用）：块 = 块头 id + 成员，散行 = 成员本身。 */
const shape = (entries: ReturnType<typeof groupByTerminal>) =>
  entries.map((e) =>
    e.kind === 'block' ? [`块 ${e.terminal.id}`, ...e.rows.map((r) => r.sessionId)] : e.row.sessionId,
  );

/**
 * 会话列表分块（窗口管理）：同一块可见屏幕上的会话聚成一块（位置 = 首成员的
 * 活动序位置、块内保持活动序）；没有屏幕信息的行不分组、原位留在块外。
 */
describe('groupByTerminal（终端分块）', () => {
  it('同屏会话聚成一块，块位置 = 首成员位置，块外行原位', () => {
    const a = screen('mux:0:0');
    const b = screen('mux:0:1');
    const entries = groupByTerminal([
      row('r1', null),
      row('r2', a),
      row('r3', b),
      row('r4', a),
      row('r5', null),
    ]);
    expect(shape(entries)).toEqual([
      'r1',
      ['块 mux:0:0', 'r2', 'r4'], // r4 被拉到同屏的 r2 一起（跨过 r3）
      ['块 mux:0:1', 'r3'], // 那块屏只有它一个会话，块头照立
      'r5',
    ]);
  });

  it('一块屏只有一个会话 → 照样立块头（块头答的是「这块屏在哪」）', () => {
    expect(shape(groupByTerminal([row('r1', screen('mux:0:0'))]))).toEqual([
      ['块 mux:0:0', 'r1'],
    ]);
    expect(
      shape(groupByTerminal([row('r1', screen('mux:0:0')), row('r2', screen('mux:0:1')), row('r3', screen('mux:0:1'))])),
    ).toEqual([['块 mux:0:0', 'r1'], ['块 mux:0:1', 'r2', 'r3']]);
  });

  it('terminal 为 null / 缺席（反查不到、没装 hooks）→ 不分组', () => {
    const bare = { ...row('r1', null) };
    delete bare.terminal;
    expect(shape(groupByTerminal([bare, row('r2', null)]))).toEqual(['r1', 'r2']);
  });

  it('空列表 → 空渲染项', () => {
    expect(groupByTerminal([])).toEqual([]);
  });
});
