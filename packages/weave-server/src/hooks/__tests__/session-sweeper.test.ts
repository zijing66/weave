import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository, type SessionRow } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { HookDispatchRepository } from '../../repositories/hook-dispatches.js';
import { EMPTY_SESSION_GRACE_MS, SessionSweeper, isEmptySession } from '../session-sweeper.js';

/**
 * 空会话清理回归：只在库里残留一条 SessionStart 的会话（开了就 /resume 走掉）
 * 延迟清掉，但**刚开的新会话长得一模一样** —— 保活窗口就是那条分界线。
 */

let db: DatabaseSync;
let sessions: SessionRepository;
let events: HookEventRepository;
let dispatches: HookDispatchRepository;
let projectId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
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

afterEach(() => db.close());

const seed = (sessionId: string, eventTypes: string[]): void => {
  sessions.touch(sessionId, projectId);
  for (const eventType of eventTypes) {
    events.insert({ projectId, source: 'claude', eventType, sessionId, payload: '{}' });
  }
};

const row = (over: Partial<SessionRow>): SessionRow =>
  ({
    sessionId: 's',
    projectId: 1,
    title: null,
    pendingTitle: null,
    lastSeenAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    eventCount: 1,
    lastEventType: 'SessionStart',
    ...over,
  }) as SessionRow;

describe('isEmptySession 判据', () => {
  const now = 1_700_000_000_000;
  const fresh = new Date(now - 1_000).toISOString();
  const stale = new Date(now - EMPTY_SESSION_GRACE_MS - 1_000).toISOString();

  it('只有一条 SessionStart 且过了保活窗口 → 空', () => {
    expect(isEmptySession(row({ lastSeenAt: stale }), now)).toBe(true);
  });

  it('刚开的会话（窗口内）不算空 —— 这是延迟的全部意义', () => {
    expect(isEmptySession(row({ lastSeenAt: fresh }), now)).toBe(false);
  });

  it('有后续事件、或最后一条不是 SessionStart → 不算空', () => {
    expect(isEmptySession(row({ lastSeenAt: stale, eventCount: 2 }), now)).toBe(false);
    expect(isEmptySession(row({ lastSeenAt: stale, lastEventType: 'UserPromptSubmit' }), now)).toBe(
      false,
    );
  });
});

describe('SessionSweeper.sweep', () => {
  it('清掉空+旧，保留空+新与有内容；重复调用幂等', () => {
    seed('a-empty', ['SessionStart']);
    seed('b-used', ['SessionStart', 'UserPromptSubmit']);

    // 都在保活窗口内 → 一个都不清
    expect(new SessionSweeper({ sessions, events, dispatches }).sweep()).toBe(0);
    expect(sessions.getBySessionId('a-empty')).toBeDefined();

    // 时间推过窗口 → 只清空会话，有内容的不动
    const later = new SessionSweeper(
      { sessions, events, dispatches },
      () => Date.now() + EMPTY_SESSION_GRACE_MS + 60_000,
    );
    expect(later.sweep()).toBe(1);
    expect(sessions.getBySessionId('a-empty')).toBeUndefined();
    expect(events.listBySession('a-empty')).toHaveLength(0);
    expect(sessions.getBySessionId('b-used')).toBeDefined();
    expect(later.sweep()).toBe(0);
  });

  it('start() 启动即扫一轮（不等首个 5 分钟间隔——dev 重启周期常短于间隔）', () => {
    seed('a-boot', ['SessionStart']);
    const sweeper = new SessionSweeper(
      { sessions, events, dispatches },
      () => Date.now() + EMPTY_SESSION_GRACE_MS + 60_000,
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
});
