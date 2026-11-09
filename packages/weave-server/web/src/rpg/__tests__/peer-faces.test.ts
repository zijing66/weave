import { describe, expect, it } from 'vitest';
import { peerFacesTest } from '../peer-faces';
import type { PeerSessionsView } from '@/lib/api';

/** F2 跨机角色卡的展示过滤纯函数（渲染本身无测试库——逻辑收在 peerFacesTest）。 */

const view = (over: Partial<PeerSessionsView> = {}): PeerSessionsView => ({
  peer: 'host-b',
  online: true,
  sessions: [
    { sessionId: 's1', title: '一号', harness: 'claude', turnOpen: true, lastSeenAt: '2026-11-08T00:00:00Z' },
    { sessionId: 's2', title: '二号', harness: null, turnOpen: false, lastSeenAt: null },
  ],
  ...over,
});

describe('peer 角色来源徽章过滤（F2）', () => {
  it('enabled + 在线（90s 内心跳）+ 有会话才可见；离线/无会话不摆空壳', () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 200_000).toISOString();
    expect(peerFacesTest.cardVisible({ enabled: true, lastSeenAt: fresh }, view())).toBe(true);
    expect(peerFacesTest.cardVisible({ enabled: true, lastSeenAt: stale }, view())).toBe(false);
    expect(peerFacesTest.cardVisible({ enabled: false, lastSeenAt: fresh }, view())).toBe(false);
    expect(peerFacesTest.cardVisible({ enabled: true, lastSeenAt: fresh }, { peer: 'x', online: false, sessions: [] })).toBe(false);
    expect(peerFacesTest.cardVisible({ enabled: true, lastSeenAt: fresh }, null)).toBe(false);
  });

  it('跨机看板行摘要：turnOpen 计数（交战数）', () => {
    expect(peerFacesTest.openCount(view())).toBe(1);
    expect(peerFacesTest.openCount(view({ sessions: [] }))).toBe(0);
  });

  it('liveness 判据与 server peerLiveness 同口径：null / 非法时间戳 = 离线', () => {
    expect(peerFacesTest.livenessOf(null)).toBe(false);
    expect(peerFacesTest.livenessOf('not-a-date')).toBe(false);
  });
});
