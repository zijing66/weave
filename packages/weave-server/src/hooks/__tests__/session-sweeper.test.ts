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
import { PROMPTLESS_GRACE_MS } from '../../repositories/sessions.js';

/**
 * 会话自动移除回归：期限两档——没等到用户 prompt 的新会话 1 小时快过期（PROMPTLESS_GRACE_MS），
 * 收到过 prompt 的走 settings `sessions.idleDays` 闲置窗。两档都锚 lastSeenAt，
 * 行内倒计时读的就是这个期限。
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

describe('自动移除期限（listWithCounts 的 autoDeleteAt，两档）', () => {
  it('无 prompt 的新会话 1 小时快过期；收到过 prompt 的走闲置窗', () => {
    seed('g-single', ['SessionStart']);
    // 只等来一条闲置 Notification、从未提交 prompt——仍是快过期档
    seed('g-notify', ['SessionStart', 'Notification']);
    for (const id of ['g-single', 'g-notify']) {
      const row = sessions.listWithCounts().find((s) => s.sessionId === id)!;
      expect(Date.parse(row.autoDeleteAt!) - Date.parse(row.lastSeenAt)).toBe(PROMPTLESS_GRACE_MS);
    }
    seed('real-full', ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
    const prompted = sessions.listWithCounts().find((s) => s.sessionId === 'real-full')!;
    expect(Date.parse(prompted.autoDeleteAt!) - Date.parse(prompted.lastSeenAt)).toBe(IDLE_MS);
  });

  it('sessions.idleDays 可调：收到过 prompt 的期限随设置缩放（无 prompt 档不受影响）', async () => {
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
      sessions: { idleDays: 7 },
    });
    seed('t-week', ['SessionStart', 'UserPromptSubmit']);
    seed('t-ghost', ['SessionStart']);
    const row = sessions.listWithCounts().find((s) => s.sessionId === 't-week')!;
    expect(Date.parse(row.autoDeleteAt!) - Date.parse(row.lastSeenAt)).toBe(7 * 86_400_000);
    const ghost = sessions.listWithCounts().find((s) => s.sessionId === 't-ghost')!;
    expect(Date.parse(ghost.autoDeleteAt!) - Date.parse(ghost.lastSeenAt)).toBe(PROMPTLESS_GRACE_MS);
  });
});

describe('SessionSweeper.sweep', () => {
  it('各自窗口内的不清；过窗即清（无 prompt 走 1 小时、长会话走闲置窗）；幂等', () => {
    seed('a-idle', ['SessionStart']);
    seed('b-idle', ['SessionStart', 'Notification']);
    seed('c-real', ['SessionStart', 'UserPromptSubmit']);

    // 都在各自窗内 → 一个都不清
    expect(new SessionSweeper({ sessions, events, dispatches }).sweep()).toBe(0);
    expect(sessions.getBySessionId('a-idle')).toBeDefined();

    // 无 prompt 的静默推过 1 小时 → 清；长会话 1 小时还远没到闲置窗 → 留下
    age('a-idle', PROMPTLESS_GRACE_MS + 60_000);
    age('b-idle', PROMPTLESS_GRACE_MS + 60_000);
    const hourLater = new SessionSweeper(
      { sessions, events, dispatches },
      () => Date.now() + 1_000,
    );
    expect(hourLater.sweep()).toBe(2);
    expect(sessions.getBySessionId('a-idle')).toBeUndefined();
    expect(events.listBySession('b-idle')).toHaveLength(0);
    expect(sessions.getBySessionId('c-real')).toBeDefined();

    // 长会话静默推过闲置窗 → 同样清
    age('c-real', IDLE_MS + 60_000);
    expect(hourLater.sweep()).toBe(1);
    expect(sessions.getBySessionId('c-real')).toBeUndefined();
    expect(hourLater.sweep()).toBe(0);
  });

  it('start() 启动即扫一轮（不等首个 5 分钟间隔——dev 重启周期常短于间隔）', () => {
    seed('a-boot', ['SessionStart', 'Notification']);
    age('a-boot', PROMPTLESS_GRACE_MS + 60_000);
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
