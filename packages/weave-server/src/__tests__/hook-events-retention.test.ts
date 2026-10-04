import { describe, it, expect } from 'vitest';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository, HOOK_EVENT_RETENTION_DAYS } from '../repositories/hook-events.js';

/**
 * hook_events 被动清理（无定时任务）：每个 UTC 天的首条写入触发一次
 * DELETE，清掉超过保留期的日志；同天后续写入不再扫表。
 */
describe('hook_events passive retention', () => {
  const dayMs = 86_400_000;
  const agoIso = (days: number): string => new Date(Date.now() - days * dayMs).toISOString();

  const setup = (): {
    db: ReturnType<typeof openDatabase>;
    projectId: number;
    hooks: HookEventRepository;
    seed: (createdAt: string) => void;
    count: () => number;
  } => {
    const db = openDatabase(':memory:');
    const projectId = new ProjectRepository(db).register({
      path: '/retention/x',
      name: 'x',
      token: 'tx',
      source: 'init',
    }).id;
    const hooks = new HookEventRepository(db);
    const seed = (createdAt: string): void => {
      db.prepare(
        `INSERT INTO hook_events (project_id, source, event_type, session_id, payload, created_at)
         VALUES (?, 'claude', 'PreToolUse', 's1', '{}', ?)`,
      ).run(projectId, createdAt);
    };
    const count = (): number =>
      Number((db.prepare('SELECT COUNT(*) AS n FROM hook_events').get() as { n: number }).n);
    return { db, projectId, hooks, seed, count };
  };

  it('首条写入触发清理：过期日志被删，保留期内与新事件存活', () => {
    const { db, hooks, projectId, seed, count } = setup();
    seed(agoIso(HOOK_EVENT_RETENTION_DAYS + 1)); // 过期
    seed(agoIso(HOOK_EVENT_RETENTION_DAYS + 5)); // 过期
    seed(agoIso(HOOK_EVENT_RETENTION_DAYS - 1)); // 保留期内
    expect(count()).toBe(3);

    hooks.insert({ projectId, source: 'claude', eventType: 'Stop', sessionId: 's1', payload: '{}' });

    expect(count()).toBe(2); // 两条过期被删：保留期内 + 新事件
    db.close();
  });

  it('同一天第二条写入不再触发清理（一天至多一次）', () => {
    const { db, hooks, projectId, seed, count } = setup();
    hooks.insert({ projectId, source: 'claude', eventType: 'Stop', sessionId: 's1', payload: '{}' });

    // 清理已执行过：此后种入的过期行不被删（同天不再扫表）
    seed(agoIso(HOOK_EVENT_RETENTION_DAYS + 10));
    hooks.insert({ projectId, source: 'claude', eventType: 'Stop', sessionId: 's1', payload: '{}' });
    expect(count()).toBe(3);
    db.close();
  });
});
