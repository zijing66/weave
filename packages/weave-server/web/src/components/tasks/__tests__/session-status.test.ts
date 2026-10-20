import { describe, it, expect } from 'vitest';
import {
  canInterrupt,
  countSessionsByHarness,
  deriveSessionStatus,
  hasTurnSignal,
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

  it('claude 注册表判死（无 SessionEnd）→ terminated', () => {
    expect(deriveSessionStatus({ ...base, pidAlive: false })).toBe('terminated');
    // 压过回合新鲜度——进程都死了就不是运行中
    expect(
      deriveSessionStatus({ ...base, pidAlive: false, lastSeenAt: ago(1_000), turnOpen: true }),
    ).toBe('terminated');
  });

  it('terminated 只认明确 false：SessionEnd 优先 closed；running/failed、未知不猜', () => {
    expect(
      deriveSessionStatus({ ...base, pidAlive: false, latestEventType: 'SessionEnd' }),
    ).toBe('closed');
    expect(
      deriveSessionStatus({ ...base, pidAlive: false, hasRunningDispatch: true }),
    ).toBe('running');
    expect(deriveSessionStatus({ ...base, pidAlive: false, latestDispatchFailed: true })).toBe(
      'failed',
    );
    // null/undefined = 查不到登记（codex/旧会话）→ 不判死
    expect(deriveSessionStatus({ ...base, pidAlive: null, turnOpen: false })).toBe('open');
    expect(deriveSessionStatus({ ...base, pidAlive: true, turnOpen: false })).toBe('open');
  });

  it('最新事件是压缩开始事件 → compacting（压过回合逻辑：压缩期间无事件）', () => {
    const compacting: StatusInput = {
      ...base,
      harness: 'claude',
      lastSeenAt: ago(60_000),
      latestEventType: 'PreCompact',
      turnOpen: true,
    };
    expect(deriveSessionStatus(compacting)).toBe('compacting');
    // 回合已关也一样（手动 /compact 落在 idle 上）
    expect(deriveSessionStatus({ ...compacting, turnOpen: false })).toBe('compacting');
  });

  it('压缩态只认本 harness 的表：别的 harness / 未报 harness 不判', () => {
    const at = { lastSeenAt: ago(1_000), latestEventType: 'PreCompact', turnOpen: true };
    expect(deriveSessionStatus({ ...base, ...at, harness: 'codex' })).toBe('running');
    expect(deriveSessionStatus({ ...base, ...at })).toBe('running');
  });

  it('压缩收尾（后续事件顶掉）与超窗兜底：不在压缩中就按常规判', () => {
    // 收尾笔 SessionStart(source=compact) 成为最新事件 → 回常规逻辑
    expect(
      deriveSessionStatus({
        ...base,
        harness: 'claude',
        lastSeenAt: ago(1_000),
        latestEventType: 'SessionStart',
        turnOpen: true,
      }),
    ).toBe('running');
    // 会话被杀在压缩中：超 10min 无任何事件 → 不永久卡「压缩中」
    expect(
      deriveSessionStatus({
        ...base,
        harness: 'claude',
        lastSeenAt: ago(601_000),
        latestEventType: 'PreCompact',
        turnOpen: true,
      }),
    ).toBe('open');
  });

  it('转录中断标记晚于最后一条事件 → interrupted（压过 turnOpen 与压缩态）', () => {
    // ESC 打断后宿主多数连 Stop 都不发，turnOpen 一直开着——不压住就永远「运行中」
    expect(
      deriveSessionStatus({
        ...base,
        lastSeenAt: ago(60_000),
        turnOpen: true,
        interruptedAt: NOW - 30_000,
      }),
    ).toBe('interrupted');
    // 中断标记也比「最新事件是压缩开始」更新时，中断更靠前
    expect(
      deriveSessionStatus({
        ...base,
        harness: 'claude',
        lastSeenAt: ago(60_000),
        latestEventType: 'PreCompact',
        turnOpen: true,
        interruptedAt: NOW - 30_000,
      }),
    ).toBe('interrupted');
  });

  it('中断标记不比最后一条事件新就不认（本地新事件一到即顶掉，不等下一拍探测）', () => {
    expect(
      deriveSessionStatus({
        ...base,
        lastSeenAt: ago(10_000),
        turnOpen: true,
        interruptedAt: NOW - 60_000,
      }),
    ).toBe('running');
    // 无标记（null/undefined）不改判
    expect(
      deriveSessionStatus({ ...base, lastSeenAt: ago(10_000), turnOpen: true, interruptedAt: null }),
    ).toBe('running');
  });

  it('中断态只压得住还在等结果的回合：正常退出 / 判死各有更硬的依据', () => {
    const interruptedAt = NOW - 30_000;
    expect(
      deriveSessionStatus({
        ...base,
        lastSeenAt: ago(60_000),
        latestEventType: 'SessionEnd',
        interruptedAt,
      }),
    ).toBe('closed');
    expect(
      deriveSessionStatus({ ...base, lastSeenAt: ago(60_000), pidAlive: false, interruptedAt }),
    ).toBe('terminated');
  });
});

describe('canInterrupt', () => {
  it('回合开着就露——含静默超窗（长工具/报错重试正是要 ESC 的时候）', () => {
    expect(canInterrupt('running', true)).toBe(true);
    expect(canInterrupt('open', true)).toBe(true);
    expect(canInterrupt('compacting', true)).toBe(true);
  });

  it('回合已关（正常收尾）不露，不按状态兜底', () => {
    expect(canInterrupt('running', false)).toBe(false);
    expect(canInterrupt('open', false)).toBe(false);
  });

  it('关闭 / 终止 / 失败落定一律不露', () => {
    expect(canInterrupt('closed', true)).toBe(false);
    expect(canInterrupt('terminated', true)).toBe(false);
    expect(canInterrupt('failed', true)).toBe(false);
    expect(canInterrupt('closed')).toBe(false);
  });

  it('已中断不露——这一轮已经停下来了（turnOpen 还挂着是它没发 Stop，不是还有活）', () => {
    expect(canInterrupt('interrupted', true)).toBe(false);
    expect(canInterrupt('interrupted', undefined)).toBe(false);
  });

  it('回合开合未知（无回合信号的 harness / 旧 daemon）按状态兜底', () => {
    expect(canInterrupt('running')).toBe(true);
    expect(canInterrupt('compacting')).toBe(true);
    expect(canInterrupt('open')).toBe(false);
    expect(canInterrupt('open', null)).toBe(false);
  });
});

describe('hasTurnSignal', () => {
  it('只认有「回合开合」事件名的 harness', () => {
    expect(hasTurnSignal('claude')).toBe(true);
    // codex 也有回合开合（rollout 里的 UserPromptSubmit / task_complete）
    expect(hasTurnSignal('codex')).toBe(true);
    expect(hasTurnSignal(null)).toBe(false);
    expect(hasTurnSignal(undefined)).toBe(false);
    expect(hasTurnSignal('nope')).toBe(false);
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

  it('压缩中算运行中（会话正忙，项目行不掉成「打开」）', () => {
    const compacting = new Map<string, SessionStatus>([
      ['a', 'compacting'],
      ['b', 'open'],
      ['c', 'closed'],
      ['d', 'failed'],
    ]);
    expect(countSessionsByHarness(rows, compacting)).toEqual([
      { harness: 'claude', running: 1, open: 1 },
    ]);
  });

  it('已中断算「打开」— 同在等输入，只是这一轮被 ESC 收的场', () => {
    const interrupted = new Map<string, SessionStatus>([
      ['a', 'interrupted'],
      ['b', 'open'],
      ['c', 'closed'],
      ['d', 'failed'],
    ]);
    expect(countSessionsByHarness(rows, interrupted)).toEqual([
      { harness: 'claude', running: 0, open: 2 },
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
