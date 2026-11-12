import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { I18nProvider } from '@/i18n/I18nProvider';
import type { PeerRow, PeerSessionsView } from '@/lib/api';
import { peerGodSeatSpot, visitorNpcSpot } from '../worldmap';
import { wandererSpot } from '../RpgView';
import { PeerSeatBar, peerSeatRowsOf, visitorLabelOf, visitorRowsOf } from '../peer-camp';

/**
 * G5 联机席位（客席区）：席位/来访 NPC 槽位纯函数 + 只读聚合的构建纯函数。
 * 槽位超界 = null（调用方截断，绝不越图纸）；来访只收在线对端的真实会话。
 */

const peer = (over: Partial<PeerRow> = {}): PeerRow => ({
  id: 'p1',
  name: 'host-b',
  host: '10.0.0.2',
  port: 6443,
  fingerprint: null,
  source: 'manual',
  lastSeenAt: new Date().toISOString(),
  enabled: true,
  createdAt: '2026-11-08T00:00:00Z',
  ...over,
});

describe('客席区槽位（G5）', () => {
  it('对等上帝席位：宅基地东侧横排，超槽位返回 null', () => {
    expect(peerGodSeatSpot(0)).toEqual({ x: 13, y: 5 });
    expect(peerGodSeatSpot(1)).toEqual({ x: 16, y: 5 });
    const last = peerGodSeatSpot(7);
    expect(last).not.toBeNull();
    // 槽位尽 = null（不越图纸）
    expect(peerGodSeatSpot(8)).toBeNull();
    expect(peerGodSeatSpot(-1)).toBeNull();
  });

  it('来访 NPC 槽位：席位排下方一路，超槽位返回 null', () => {
    expect(visitorNpcSpot(0)).toEqual({ x: 13, y: 7 });
    expect(visitorNpcSpot(11)).not.toBeNull();
    expect(visitorNpcSpot(12)).toBeNull();
    expect(visitorNpcSpot(-1)).toBeNull();
  });

  it('席位/来访不与宅基地热点（x4-11, y5-8）或在野角色排（y12）相撞', () => {
    for (let i = 0; i < 8; i++) {
      const s = peerGodSeatSpot(i)!;
      expect(s.x + 2).toBeLessThanOrEqual(38); // 界内
      expect(s.x).toBeGreaterThanOrEqual(13); // 宅基地右界之外
      expect(s.y).toBe(5);
    }
    // 在野角色行不与客席行重叠（y12 vs y5/y7）
    expect(wandererSpot(0)!.y).not.toBe(visitorNpcSpot(0)!.y);
  });
});

describe('客席区聚合（G5）', () => {
  const view = (over: Partial<PeerSessionsView> = {}): PeerSessionsView => ({
    peer: 'p1',
    online: true,
    sessions: [
      { sessionId: 's1', title: '征战', harness: 'claude', turnOpen: true, lastSeenAt: '2026-11-08T00:00:00Z' },
      { sessionId: 's2', title: null, harness: null, turnOpen: false, lastSeenAt: null },
      { sessionId: 's3', title: '三号', harness: null, turnOpen: false, lastSeenAt: null },
      { sessionId: 's4', title: '四号', harness: null, turnOpen: false, lastSeenAt: null },
    ],
    ...over,
  });

  it('席位只收 enabled + 在线的对端；离线/停用不摆', () => {
    const fresh = peer();
    const stale = peer({ id: 'p2', lastSeenAt: new Date(Date.now() - 200_000).toISOString() });
    const off = peer({ id: 'p3', enabled: false });
    const rows = peerSeatRowsOf([fresh, stale, off]);
    expect(rows.map((r) => r.peer.id)).toEqual(['p1']);
  });

  it('来访 NPC = 在线对端的真实会话：每端上限 3、代理不可达如实缺席', () => {
    const a = peer();
    const b = peer({ id: 'p2', name: 'host-c' });
    const views = new Map<string, PeerSessionsView>([['p1', view()]]);
    const rows = visitorRowsOf([a, b], views);
    // p1 有 4 条会话但上限 3；p2 无代理视图 = 缺席
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.peer.id === 'p1')).toBe(true);
    expect(rows.map((r) => r.sessionId)).toEqual(['s1', 's2', 's3']);
    expect(rows[0]!.turnOpen).toBe(true);
  });

  it('NPC 名牌短标：标题截 12 字，无标题用会话 id 前 8 位', () => {
    expect(visitorLabelOf({ title: '  一二三四五六七八九十甲乙丙 ', sessionId: 'x' })).toBe('一二三四五六七八九十甲乙');
    expect(visitorLabelOf({ title: null, sessionId: 'abcdefgh-1234' })).toBe('abcdefgh');
    expect(visitorLabelOf({ title: '   ', sessionId: 'abcdefgh-1234' })).toBe('abcdefgh');
  });

  it('客席只读详情条渲染不炸（机器名/地址/远端会话账都落 DOM）', () => {
    const html = renderToString(
      <I18nProvider>
        <PeerSeatBar peer={peer()} view={view({ peer: 'p1' })} onClose={() => {}} />
      </I18nProvider>,
    );
    expect(html).toContain('host-b');
    expect(html).toContain('10.0.0.2:6443');
    expect(html).toContain('征战');
  });
});
