import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import {
  setDaemonSettingsDb,
  writeDaemonSettings,
  DEFAULT_SESSION_IDLE_DAYS,
} from '../../daemon/settings.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { HookDispatchRepository } from '../../repositories/hook-dispatches.js';
import { SessionSweeper } from '../session-sweeper.js';

/**
 * 无操作会话闲置移除回归：期限 = lastSeenAt + settings `sessions.idleDays`，
 * **全会话统一**（含收到过 prompt 的长会话）——新会话（只有一条 SessionStart）
 * 随首个事件即出现，闲置够 n 天才自动移除，行内倒计时读的就是这个期限。
 */

let db: DatabaseSync;
let sessions: SessionRepository;
let events: HookEventRepository;
let dispatches: HookDispatchRepository;
let projectId: number;

const IDLE_MS = DEFAULT_SESSION_IDLE_DAYS * 86_400_000;

beforeEach(() => {
  db = openDatabase(':memory:');
  setDaemonSettingsDb(openDatabase(':memory:'));
  projectId = new ProjectRepository(db).register({
    path: '/p',
    name: 'p',
    token: 't',
    source: 'init',
  }).id;
  sessions = new SessionRepository(db);
  events = new HookEventRepository(db);
  dispatches = new HookDispatchRepository(db);
});

afterEach(() => {
  setDaemonSettingsDb(null);
  db.close();
});

const seed = (sessionId: string, eventTypes: string[]): void => {
  sessions.touch(sessionId, projectId);
  for (const eventType of eventTypes) {
    events.insert({ projectId, source: 'claude', eventType, sessionId, payload: '{}' });
  }
};

/** 把会话行改成「最后一次活动在 msAgo 之前」（autoDeleteAt 锚定 last_seen_at）。 */
const age = (sessionId: string, msAgo: number): void => {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE session_id = ?').run(
    new Date(Date.now() - msAgo).toISOString(),
    sessionId,
  );
};

describe('闲置移除期限（listWithCounts 的 autoDeleteAt）', () => {
  it('全会话统一：期限 = lastSeenAt + 无操作保留窗（判据唯一实现）', () => {
    seed('g-single', ['SessionStart']);
    // 只等来一条闲置 Notification、从未提交 prompt——与长会话同一条线
    seed('g-notify', ['SessionStart', 'Notification']);
    seed('real-full', ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
    for (const id of ['g-single', 'g-notify', 'real-full']) {
      const row = sessions.listWithCounts().find((s) => s.sessionId === id)!;
      expect(row.autoDeleteAt).toBeTruthy();
      expect(Date.parse(row.autoDeleteAt!) - Date.parse(row.lastSeenAt)).toBe(IDLE_MS);
    }
  });

  it('sessions.idleDays 可调：期限随设置缩放', async () => {
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
      sessions: { idleDays: 7 },
    });
    seed('t-week', ['SessionStart']);
    const row = sessions.listWithCounts().find((s) => s.sessionId === 't-week')!;
    expect(Date.parse(row.autoDeleteAt!) - Date.parse(row.lastSeenAt)).toBe(7 * 86_400_000);
  });
});

describe('SessionSweeper.sweep', () => {
  it('闲置窗内的不清；窗过即清（长会话同样移除）；幂等', () => {
    seed('a-idle', ['SessionStart']);
    seed('b-idle', ['SessionStart', 'Notification']);
    seed('c-real', ['SessionStart', 'UserPromptSubmit']);

    // 都在闲置窗内 → 一个都不清
    expect(new SessionSweeper({ sessions, events, dispatches }).sweep()).toBe(0);
    expect(sessions.getBySessionId('a-idle')).toBeDefined();

    // 静默推过窗口 → 三个全清（有无 prompt 不再分家）
    age('a-idle', IDLE_MS + 60_000);
    age('b-idle', IDLE_MS + 60_000);
    age('c-real', IDLE_MS + 60_000);
    const later = new SessionSweeper(
      { sessions, events, dispatches },
      () => Date.now() + 1_000,
    );
    expect(later.sweep()).toBe(3);
    expect(sessions.getBySessionId('a-idle')).toBeUndefined();
    expect(events.listBySession('b-idle')).toHaveLength(0);
    expect(sessions.getBySessionId('c-real')).toBeUndefined();
    expect(later.sweep()).toBe(0);
  });

  it('start() 启动即扫一轮（不等首个 5 分钟间隔——dev 重启周期常短于间隔）', () => {
    seed('a-boot', ['SessionStart', 'Notification']);
    age('a-boot', IDLE_MS + 60_000);
    const sweeper = new SessionSweeper(
      { sessions, events, dispatches },
      () => Date.now() + 1_000,
    );
    clearInterval(sweeper.start());
    expect(sessions.getBySessionId('a-boot')).toBeUndefined();
  });

  it('清空循环之后挂空闲订阅补射（批 2：同 tick 释放刚清掉会话的 pending watch）', () => {
    const sweepTerminated = vi.fn(() => 0);
    const sweeper = new SessionSweeper({
      sessions,
      events,
      dispatches,
      watchEngine: { sweepTerminated },
    });
    expect(sweeper.sweep()).toBe(0);
    expect(sweepTerminated).toHaveBeenCalledTimes(1);
  });

  it('订阅补射之后再挂序列补射（批 3：同 tick 判死进行中序列的等待目标）', () => {
    const watchSweep = vi.fn(() => 0);
    const sequenceSweep = vi.fn(() => 0);
    const sweeper = new SessionSweeper({
      sessions,
      events,
      dispatches,
      watchEngine: { sweepTerminated: watchSweep },
      sequenceEngine: { sweepTerminated: sequenceSweep },
    });
    expect(sweeper.sweep()).toBe(0);
    expect(watchSweep).toHaveBeenCalledTimes(1);
    expect(sequenceSweep).toHaveBeenCalledTimes(1);
  });
});
