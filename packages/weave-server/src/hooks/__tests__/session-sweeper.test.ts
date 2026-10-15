import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { PROMPTLESS_GRACE_MS } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { HookDispatchRepository } from '../../repositories/hook-dispatches.js';
import { SessionSweeper } from '../session-sweeper.js';

/**
 * 无 prompt 幽灵会话清理回归：从未收到 UserPromptSubmit 的会话（开了就走——
 * SessionStart 单例，或 SessionStart + 闲置 Notification 组合）静默过保活窗即清，
 * 但**刚开的会话长得一模一样**——保活窗口就是那条分界线。收到过 prompt 的
 * 长会话永不被自动清（遵循全局事件保留期）。
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

/** 把会话行改成「最后一次活动在 msAgo 之前」（autoDeleteAt 锚定 last_seen_at）。 */
const age = (sessionId: string, msAgo: number): void => {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE session_id = ?').run(
    new Date(Date.now() - msAgo).toISOString(),
    sessionId,
  );
};

describe('幽灵会话判据（listWithCounts 的 autoDeleteAt）', () => {
  it('从未收到 UserPromptSubmit → 期限 = lastSeenAt + 保活窗（判据唯一实现）', () => {
    seed('g-single', ['SessionStart']);
    // 实库真实形状：开了之后只等来一条闲置 Notification，从未提交 prompt
    seed('g-notify', ['SessionStart', 'Notification']);
    for (const id of ['g-single', 'g-notify']) {
      const row = sessions.listWithCounts().find((s) => s.sessionId === id)!;
      expect(row.autoDeleteAt).toBeTruthy();
      expect(Date.parse(row.autoDeleteAt!) - Date.parse(row.lastSeenAt)).toBe(
        PROMPTLESS_GRACE_MS,
      );
    }
  });

  it('收到过 UserPromptSubmit（哪怕只此一条）→ null：长会话遵循全局保留期，永不自动删', () => {
    seed('real-full', ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
    seed('real-ups-only', ['UserPromptSubmit']);
    for (const id of ['real-full', 'real-ups-only']) {
      const row = sessions.listWithCounts().find((s) => s.sessionId === id)!;
      expect(row.autoDeleteAt).toBeNull();
    }
  });
});

describe('SessionSweeper.sweep', () => {
  it('保活窗内的幽灵不清；窗过即清（含 SessionStart+Notification 形状）；有 prompt 的不动；幂等', () => {
    seed('a-ghost', ['SessionStart']);
    seed('b-ghost', ['SessionStart', 'Notification']);
    seed('c-real', ['SessionStart', 'UserPromptSubmit']);

    // 都在保活窗口内 → 一个都不清
    expect(new SessionSweeper({ sessions, events, dispatches }).sweep()).toBe(0);
    expect(sessions.getBySessionId('a-ghost')).toBeDefined();

    // 静默推过窗口 → 只清无 prompt 的两个；c-real 同样静默过窗但有 prompt，
    // 长会话遵循全局生命周期，不自动删
    age('a-ghost', PROMPTLESS_GRACE_MS + 60_000);
    age('b-ghost', PROMPTLESS_GRACE_MS + 60_000);
    age('c-real', PROMPTLESS_GRACE_MS + 60_000);
    const later = new SessionSweeper(
      { sessions, events, dispatches },
      () => Date.now() + 1_000,
    );
    expect(later.sweep()).toBe(2);
    expect(sessions.getBySessionId('a-ghost')).toBeUndefined();
    expect(events.listBySession('b-ghost')).toHaveLength(0);
    expect(sessions.getBySessionId('c-real')).toBeDefined();
    expect(later.sweep()).toBe(0);
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
