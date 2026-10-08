import { describe, it, expect } from 'vitest';
import {
  countSessionsByHarness,
  deriveSessionStatus,
  type SessionStatus,
  type StatusInput,
} from '../session-status';

const NOW = 1_700_000_000_000;
const base: StatusInput = {
  lastSeenAt: new Date(NOW - 3_600_000).toISOString(), // 1h 前
  hasRunningDispatch: false,
  now: NOW,
};
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe('deriveSessionStatus', () => {
  it('overlay 最优先（SSE 帧已到、refetch 未回）', () => {
    expect(deriveSessionStatus({ ...base, overlay: 'running', hasRunningDispatch: false })).toBe(
      'running',
    );
    expect(deriveSessionStatus({ ...base, overlay: 'failed' })).toBe('failed');
    expect(
      deriveSessionStatus({ ...base, overlay: 'running', latestEventType: 'SessionEnd' }),
    ).toBe('running');
  });

  it('存在 running dispatch / 后台子 agent → running（即使很久没事件）', () => {
    expect(deriveSessionStatus({ ...base, hasRunningDispatch: true })).toBe('running');
    expect(deriveSessionStatus({ ...base, hasRunningSubagent: true })).toBe('running');
    // 子 agent 存活压过派发失败与静默
    expect(
      deriveSessionStatus({ ...base, hasRunningSubagent: true, latestDispatchFailed: true }),
    ).toBe('running');
  });

  it('最新 dispatch failed/timeout 且无 running → failed', () => {
    expect(deriveSessionStatus({ ...base, latestDispatchFailed: true })).toBe('failed');
    // running 压过 failed
    expect(
      deriveSessionStatus({ ...base, hasRunningDispatch: true, latestDispatchFailed: true }),
    ).toBe('running');
  });

  it('最新事件 SessionEnd → closed，无条件（压过 turnOpen 与新鲜度）', () => {
    expect(deriveSessionStatus({ ...base, latestEventType: 'SessionEnd' })).toBe('closed');
    expect(
      deriveSessionStatus({ ...base, lastSeenAt: ago(1_000), latestEventType: 'SessionEnd' }),
    ).toBe('closed');
    expect(
      deriveSessionStatus({ ...base, lastSeenAt: ago(1_000), turnOpen: true, latestEventType: 'SessionEnd' }),
    ).toBe('closed');
    // failed 压过 closed（最新派发失败比旧 SessionEnd 更新）
    expect(
      deriveSessionStatus({ ...base, latestEventType: 'SessionEnd', latestDispatchFailed: true }),
    ).toBe('failed');
  });

  it('回合开着且未静默超 5min → running（长工具/长思考不丢状态）', () => {
    expect(deriveSessionStatus({ ...base, lastSeenAt: ago(120_000), turnOpen: true })).toBe('running');
    // 临界内侧：4min59s 仍是 running
    expect(deriveSessionStatus({ ...base, lastSeenAt: ago(299_000), turnOpen: true })).toBe('running');
  });

  it('回合开着但静默超 5min → open（异常退出不永久卡运行中）', () => {
    expect(deriveSessionStatus({ ...base, lastSeenAt: ago(301_000), turnOpen: true })).toBe('open');
  });

  it('回合已关（收到 Stop）→ open，无论刚停还是静默很久', () => {
    expect(deriveSessionStatus({ ...base, lastSeenAt: ago(1_000), turnOpen: false })).toBe('open');
    expect(deriveSessionStatus({ ...base, lastSeenAt: ago(600_000), turnOpen: false })).toBe('open');
  });

  it('回合开合未知（旧 daemon / 无 UPS）→ 30s 窗口内有活动算 running，否则 open', () => {
    expect(deriveSessionStatus({ ...base, lastSeenAt: ago(5_000) })).toBe('running');
    expect(deriveSessionStatus({ ...base, lastSeenAt: ago(31_000) })).toBe('open');
    expect(deriveSessionStatus({ ...base })).toBe('open');
  });

  it('无 SessionEnd 的旧会话一律 open（不按静默时长兜底）', () => {
    expect(
      deriveSessionStatus({ ...base, lastSeenAt: ago(30 * 86_400_000), turnOpen: false }),
    ).toBe('open');
  });

  it('最新事件时间比 lastSeen 新时以事件为准', () => {
    expect(
      deriveSessionStatus({ ...base, latestEventAt: ago(1_000), latestEventType: 'PostToolUse' }),
    ).toBe('running');
  });
});

describe('countSessionsByHarness', () => {
  const rows = [
    { sessionId: 'a', harness: 'claude' as const },
    { sessionId: 'b', harness: 'claude' as const },
    { sessionId: 'c', harness: 'codex' as const },
    { sessionId: 'd', harness: null },
  ];
  const statuses = new Map<string, SessionStatus>([
    ['a', 'running'],
    ['b', 'open'],
    ['c', 'closed'],
    ['d', 'failed'],
  ]);

  it('按 harness 分桶，只计运行中/打开，失败/关闭不入桶', () => {
    expect(countSessionsByHarness(rows, statuses)).toEqual([
      { harness: 'claude', running: 1, open: 1 },
    ]);
  });

  it('桶序稳定：claude → codex → 未知', () => {
    const all = new Map<string, SessionStatus>([
      ['a', 'open'],
      ['b', 'open'],
      ['c', 'open'],
      ['d', 'open'],
    ]);
    expect(countSessionsByHarness(rows, all).map((b) => b.harness)).toEqual([
      'claude',
      'codex',
      null,
    ]);
  });

  it('状态缺失按打开计；无会话则无桶', () => {
    const first = rows[0]!;
    expect(countSessionsByHarness([first], new Map())).toEqual([
      { harness: 'claude', running: 0, open: 1 },
    ]);
    expect(countSessionsByHarness([], new Map())).toEqual([]);
  });
});
