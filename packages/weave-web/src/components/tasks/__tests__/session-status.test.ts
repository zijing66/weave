import { describe, it, expect } from 'vitest';
import { deriveSessionStatus, type StatusInput } from '../session-status';

const NOW = 1_700_000_000_000;
const base: StatusInput = {
  lastSeenAt: new Date(NOW - 3_600_000).toISOString(), // 1h 前
  hasRunningDispatch: false,
  now: NOW,
};

describe('deriveSessionStatus', () => {
  it('overlay 最优先（SSE 帧已到、refetch 未回）', () => {
    expect(deriveSessionStatus({ ...base, overlay: 'running', hasRunningDispatch: false })).toBe('running');
    expect(deriveSessionStatus({ ...base, overlay: 'failed' })).toBe('failed');
  });

  it('存在 running dispatch → running（即使很久没事件）', () => {
    expect(deriveSessionStatus({ ...base, hasRunningDispatch: true })).toBe('running');
  });

  it('最新 dispatch failed/timeout 且无 running → failed', () => {
    expect(deriveSessionStatus({ ...base, latestDispatchFailed: true })).toBe('failed');
  });

  it('30s 窗口内有事件/lastSeen → active；最新为 SessionEnd → completed', () => {
    const fresh = { ...base, lastSeenAt: new Date(NOW - 5_000).toISOString() };
    expect(deriveSessionStatus(fresh)).toBe('active');
    expect(
      deriveSessionStatus({
        ...fresh,
        latestEventAt: new Date(NOW - 5_000).toISOString(),
        latestEventType: 'SessionEnd',
      }),
    ).toBe('completed');
  });

  it('窗口外：SessionEnd → completed，否则 idle', () => {
    expect(
      deriveSessionStatus({
        ...base,
        latestEventAt: new Date(NOW - 120_000).toISOString(),
        latestEventType: 'SessionEnd',
      }),
    ).toBe('completed');
    expect(deriveSessionStatus(base)).toBe('idle');
  });

  it('优先级串接：running > failed > active > completed > idle', () => {
    // running 压过 failed
    expect(
      deriveSessionStatus({ ...base, hasRunningDispatch: true, latestDispatchFailed: true }),
    ).toBe('running');
    // failed 压过 active
    expect(
      deriveSessionStatus({ ...base, lastSeenAt: new Date(NOW).toISOString(), latestDispatchFailed: true }),
    ).toBe('failed');
    // active 压过 completed（窗口内非 SessionEnd 的最新事件）
    expect(
      deriveSessionStatus({
        ...base,
        lastSeenAt: new Date(NOW - 1000).toISOString(),
        latestEventType: 'Stop',
      }),
    ).toBe('active');
  });
});
