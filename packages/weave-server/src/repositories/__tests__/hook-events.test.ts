import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { HookEventRepository } from '../hook-events.js';
import { ProjectRepository } from '../projects.js';

/** 仪表盘读侧的轻查询：总数 / 某时刻以来计数 / 回填用的逐秒分布。 */

const db = (): DatabaseSync => openDatabase(':memory:');

/** 事件表对 projects 有外键：先登记项目（拿真实 id）。 */
const projectIds = (d: DatabaseSync, paths: string[]): number[] =>
  paths.map((path) => new ProjectRepository(d).register({ path, name: path, token: 't', source: 'init' }).id);

function insertAt(repo: HookEventRepository, projectId: number, createdAt: string): void {
  repo.insert({ projectId, source: 'claude', eventType: 'PostToolUse', sessionId: 's1', payload: '{}', createdAt });
}

describe('dashboard queries', () => {
  it('总数、时间窗计数与逐秒分布（跨项目合并）', () => {
    const d = db();
    try {
      const repo = new HookEventRepository(d);
      const [p1, p2] = projectIds(d, ['/p1', '/p2']);
      const now = Date.now();
      const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
      insertAt(repo, p1!, at(5_000));
      insertAt(repo, p1!, at(4_000));
      insertAt(repo, p2!, at(1_000));
      insertAt(repo, p2!, at(2 * 86_400_000)); // 前天：进总数不进窗口

      expect(repo.countAll()).toBe(4);
      const since = at(60_000);
      expect(repo.countSince([p1!, p2!], since)).toBe(3);
      expect(repo.countSince([p1!], since)).toBe(2);

      const series = repo.seriesBySecond([p1!, p2!], since);
      expect(series.reduce((n, s) => n + s.n, 0)).toBe(3);
      for (const s of series) expect(s.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      const keys = series.map((s) => s.at);
      expect([...keys].sort()).toEqual(keys);
    } finally {
      d.close();
    }
  });

  it('只统计给定项目的行（归档项目的事件不混进来）', () => {
    const d = db();
    try {
      const repo = new HookEventRepository(d);
      const [p1, p9] = projectIds(d, ['/p1', '/p9']);
      const now = new Date(Date.now() - 3_000).toISOString();
      insertAt(repo, p1!, now);
      insertAt(repo, p9!, now);
      const since = new Date(Date.now() - 60_000).toISOString();
      expect(repo.countAll()).toBe(2); // 整表
      expect(repo.countSince([p1!], since)).toBe(1);
      expect(repo.seriesBySecond([p1!], since)).toHaveLength(1);
    } finally {
      d.close();
    }
  });
});
