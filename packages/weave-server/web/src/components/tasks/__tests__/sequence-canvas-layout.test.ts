import { describe, expect, it } from 'vitest';
import type { Harness } from '@weavecode/core/harness';
import type { SessionMessageRow, SessionRow } from '@/lib/api';
import {
  layoutSequenceCanvas,
  outgoingOf,
  SEQ_LANE_HEADER_H,
  SEQ_LANE_W,
  SEQ_ROW_H,
} from '../sequence-canvas-layout';

const session = (id: string, harness: Harness | null): SessionRow => ({
  sessionId: id,
  projectId: 1,
  title: null,
  pendingTitle: null,
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  harness,
});

const msg = (
  id: number,
  from: string | null,
  to: string,
  status: SessionMessageRow['status'] = 'succeeded',
): SessionMessageRow => ({
  id,
  fromKind: from ? 'session' : 'dashboard',
  fromSessionId: from,
  toSessionId: to,
  text: `m${id}`,
  mode: 'auto',
  status,
  output: null,
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  deliveredAt: null,
  finishedAt: null,
});

describe('layoutSequenceCanvas', () => {
  it('泳道只给在场 harness 开道，按名表序、未知 harness 归末列', () => {
    const laid = layoutSequenceCanvas(
      [
        session('a', 'claude'),
        session('b', 'codex'),
        session('c', null),
        session('d', 'claude'),
      ],
      [],
    );
    expect(laid.lanes.map((l) => l.harness)).toEqual(['claude', 'codex', null]);
    expect(laid.lanes[0]!.count).toBe(2);
    expect(laid.lanes[1]!.count).toBe(1);
  });

  it('节点坐标：泳道列距 + 泳道内行距，行号只在同泳道内递增', () => {
    const laid = layoutSequenceCanvas(
      [session('a', 'claude'), session('d', 'claude'), session('b', 'codex')],
      [],
    );
    const byId = new Map(laid.nodes.map((n) => [n.session.sessionId, n]));
    expect(byId.get('a')).toMatchObject({ lane: 0, row: 0, x: 0, y: SEQ_LANE_HEADER_H });
    expect(byId.get('d')).toMatchObject({
      lane: 0,
      row: 1,
      x: 0,
      y: SEQ_LANE_HEADER_H + SEQ_ROW_H,
    });
    expect(byId.get('b')).toMatchObject({
      lane: 1,
      row: 0,
      x: SEQ_LANE_W,
      y: SEQ_LANE_HEADER_H,
    });
  });

  it('边只认两端都在画布上的会话间消息（dashboard 投递无源端）', () => {
    const laid = layoutSequenceCanvas(
      [session('a', 'claude'), session('b', 'claude'), session('c', 'codex')],
      [
        msg(1, 'a', 'b'), // 成边
        msg(2, null, 'a'), // dashboard 投递：无源节点
        msg(3, 'a', 'zzz'), // 目标不在画布
        msg(4, 'zzz', 'b'), // 源不在画布
      ],
    );
    expect(laid.edges).toHaveLength(1);
    expect(laid.edges[0]).toMatchObject({ key: 'm:1', sourceKey: 's:a', targetKey: 's:b' });
  });
});

describe('outgoingOf', () => {
  it('双向线程去重：每条会话间消息恰一次（取发送方线程）；dashboard/cli 投递不进边集', () => {
    const threads = new Map<string, SessionMessageRow[]>([
      // a 的线程：a 发出的（成边）+ dashboard 发给 a 的 + b 发给 a 的（在 b 的线程成边）
      ['a', [msg(1, 'a', 'b'), msg(2, null, 'a'), msg(3, 'b', 'a')]],
      // b 的线程：同一条 a→b 在 b 的线程是入向（fromSessionId ≠ b，不取）
      ['b', [msg(1, 'a', 'b'), msg(3, 'b', 'a'), msg(4, null, 'b')]],
    ]);
    const out = outgoingOf(threads);
    expect(out.map((m) => m.id)).toEqual([1, 3]);
  });
});
