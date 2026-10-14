import { describe, expect, it } from 'vitest';
import type { Harness } from '@weavecode/core/harness';
import type { SessionRow } from '@/lib/api';
import {
  layoutSequenceCanvas,
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

describe('layoutSequenceCanvas', () => {
  it('泳道只给在场 harness 开道，按名表序、未知 harness 归末列', () => {
    const laid = layoutSequenceCanvas([
      session('a', 'claude'),
      session('b', 'codex'),
      session('c', null),
      session('d', 'claude'),
    ]);
    expect(laid.lanes.map((l) => l.harness)).toEqual(['claude', 'codex', null]);
    expect(laid.lanes[0]!.count).toBe(2);
    expect(laid.lanes[1]!.count).toBe(1);
  });

  it('节点坐标：泳道列距 + 泳道内行距，行号只在同泳道内递增', () => {
    const laid = layoutSequenceCanvas([
      session('a', 'claude'),
      session('d', 'claude'),
      session('b', 'codex'),
    ]);
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
});
