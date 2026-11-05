import { describe, it, expect } from 'vitest';
import { HARNESS_SHELL_DISCARD_GRACE_MS } from '@weavecode/core';
import { shellDiscardedByHost } from '../shell.js';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const row = (over: Partial<Parameters<typeof shellDiscardedByHost>[0]> = {}) => ({
  sessionId: 's1',
  harness: 'claude',
  lastSeenAt: new Date(NOW - HARNESS_SHELL_DISCARD_GRACE_MS.claude! - 1).toISOString(),
  lastEventType: 'SessionStart',
  eventCount: 1,
  ...over,
});

describe('shellDiscardedByHost：宿主已丢弃的空壳会话（判据查表，不认 harness 名）', () => {
  it('查无登记 + 过豁免窗 → 丢弃；表里为 null 的 harness 一律不动', () => {
    expect(shellDiscardedByHost(row(), new Map(), NOW)).toBe(true);
    expect(shellDiscardedByHost(row({ harness: 'nope' }), new Map(), NOW)).toBe(false);
    expect(shellDiscardedByHost(row({ harness: null }), new Map(), NOW)).toBe(false);
  });

  it('存活图说它活着（true）→ 留着；图里没有它 / 说它死了 → 都可清', () => {
    expect(shellDiscardedByHost(row(), new Map([['s1', true]]), NOW)).toBe(false);
    expect(shellDiscardedByHost(row(), new Map([['s1', false]]), NOW)).toBe(true);
    expect(shellDiscardedByHost(row(), new Map([['other', true]]), NOW)).toBe(true);
  });

  it('豁免窗内不清（新会话登记面可能还没落盘）', () => {
    expect(
      shellDiscardedByHost(row({ lastSeenAt: new Date(NOW - 1000).toISOString() }), new Map(), NOW),
    ).toBe(false);
  });

  it('说过话的不算空壳（事件多于一条 / 最新不是 SessionStart）', () => {
    expect(shellDiscardedByHost(row({ eventCount: 2 }), new Map(), NOW)).toBe(false);
    expect(shellDiscardedByHost(row({ lastEventType: 'Stop' }), new Map(), NOW)).toBe(false);
  });

  it('codex 用自己那档窗：过了 claude 的 90s 仍不算丢弃，过自己那档才清', () => {
    const codexGrace = HARNESS_SHELL_DISCARD_GRACE_MS.codex!;
    const mid = row({
      harness: 'codex',
      lastSeenAt: new Date(NOW - HARNESS_SHELL_DISCARD_GRACE_MS.claude! - 1).toISOString(),
    });
    expect(shellDiscardedByHost(mid, new Map(), NOW)).toBe(false);
    const past = row({ harness: 'codex', lastSeenAt: new Date(NOW - codexGrace - 1).toISOString() });
    expect(shellDiscardedByHost(past, new Map(), NOW)).toBe(true);
  });
});
