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
    // failed 压过 turnOpen（回合开着也先报派发失败）
    expect(
      deriveSessionStatus({
        ...base,
        lastSeenAt: new Date(NOW - 10_000).toISOString(),
        latestDispatchFailed: true,
        turnOpen: true,
      }),
    ).toBe('failed');
    // overlay 压过 turnOpen
    expect(
      deriveSessionStatus({
        ...base,
        lastSeenAt: new Date(NOW - 10_000).toISOString(),
        overlay: 'running',
        turnOpen: true,
      }),
    ).toBe('running');
    // active 压过 completed（窗口内非 SessionEnd 的最新事件）
    expect(
      deriveSessionStatus({
        ...base,
        lastSeenAt: new Date(NOW - 1000).toISOString(),
        latestEventType: 'Stop',
      }),
    ).toBe('active');
  });

  it('turnOpen 无视 30s 窗口：静默 >30s 但 <5min → active（长工具不丢状态）', () => {
    const stale = { ...base, lastSeenAt: new Date(NOW - 120_000).toISOString(), turnOpen: true };
    expect(deriveSessionStatus(stale)).toBe('active');
    // 临界内侧：4min59s 仍是 active
    expect(
      deriveSessionStatus({ ...stale, lastSeenAt: new Date(NOW - 299_000).toISOString() }),
    ).toBe('active');
  });

  it('turnOpen 静默超 5min → idle（异常退出不永久卡死）', () => {
    expect(
      deriveSessionStatus({
        ...base,
        lastSeenAt: new Date(NOW - 301_000).toISOString(),
        turnOpen: true,
      }),
    ).toBe('idle');
  });

  it('SessionEnd 无条件 completed，优先于 turnOpen', () => {
    expect(
      deriveSessionStatus({
        ...base,
        lastSeenAt: new Date(NOW - 10_000).toISOString(),
        latestEventType: 'SessionEnd',
        turnOpen: true,
      }),
    ).toBe('completed');
  });

  it('后台子 agent 进行中 → running：静默再久也算主会话运行中', () => {
    expect(deriveSessionStatus({ ...base, hasRunningSubagent: true })).toBe('running');
  });

  it('子 agent running 压过 failed 与 turnOpen 超时', () => {
    // 派发失败但子 agent 还在跑 → running（更新的事实）
    expect(
      deriveSessionStatus({ ...base, hasRunningSubagent: true, latestDispatchFailed: true }),
    ).toBe('running');
    // turnOpen 超 5min 本应 idle 兜底，但子 agent 存活 → running
    expect(
      deriveSessionStatus({
        ...base,
        lastSeenAt: new Date(NOW - 600_000).toISOString(),
        turnOpen: true,
        hasRunningSubagent: true,
      }),
    ).toBe('running');
  });
});
