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

describe('searchConversationTexts（全局搜索的聊天记录路）', () => {
  const ups = (prompt: string): string =>
    JSON.stringify({ raw: { prompt, cwd: '/x', transcript_path: '/t' } });
  const stop = (summary: string): string =>
    JSON.stringify({ raw: { last_assistant_message: summary, cwd: '/x' } });

  it('UPS 正文与 Stop 总结都命中；非对话事件与非正文键不命中', () => {
    const d = db();
    try {
      const repo = new HookEventRepository(d);
      const [p1] = projectIds(d, ['/p1']);
      repo.insert({ projectId: p1!, source: 'claude', eventType: 'UserPromptSubmit', sessionId: 's1', payload: ups('帮我写个编排图') });
      repo.insert({ projectId: p1!, source: 'claude', eventType: 'Stop', sessionId: 's1', payload: stop('编排已画好,共三个节点') });
      // 工具事件:即使 payload 里别处(如 cwd)含词也不命中
      repo.insert({ projectId: p1!, source: 'claude', eventType: 'PostToolUse', sessionId: 's1', payload: JSON.stringify({ raw: { cwd: '/编排' } }) });
      // 对话事件但正文不含词
      repo.insert({ projectId: p1!, source: 'claude', eventType: 'UserPromptSubmit', sessionId: 's1', payload: ups('另一条') });

      const hits = repo.searchConversationTexts('编排', 20);
      expect(hits).toHaveLength(2);
      // 倒序:最新的 Stop 在前
      expect(hits[0]!.eventType).toBe('Stop');
      expect(hits[0]!.text).toBe('编排已画好,共三个节点');
      expect(hits[1]!.eventType).toBe('UserPromptSubmit');
      expect(hits[1]!.text).toBe('帮我写个编排图');
    } finally {
      d.close();
    }
  });

  it('事件集合随 HARNESS_LIFECYCLE 表(codex 的 TurnAborted 也算收尾)', () => {
    const d = db();
    try {
      const repo = new HookEventRepository(d);
      const [p1] = projectIds(d, ['/p1']);
      repo.insert({ projectId: p1!, source: 'codex', eventType: 'TurnAborted', sessionId: 's2', payload: stop('被打断的总结提到编排') });
      expect(repo.searchConversationTexts('编排', 20)).toHaveLength(1);
    } finally {
      d.close();
    }
  });

  it('LIKE 通配符按字面匹配(%/_ 不当通配符)', () => {
    const d = db();
    try {
      const repo = new HookEventRepository(d);
      const [p1] = projectIds(d, ['/p1']);
      repo.insert({ projectId: p1!, source: 'claude', eventType: 'UserPromptSubmit', sessionId: 's1', payload: ups('100% 完成') });
      repo.insert({ projectId: p1!, source: 'claude', eventType: 'UserPromptSubmit', sessionId: 's1', payload: ups('100x 完成') });
      expect(repo.searchConversationTexts('%', 20)).toHaveLength(1);
      expect(repo.searchConversationTexts('%', 20)[0]!.text).toBe('100% 完成');
    } finally {
      d.close();
    }
  });

  it('limit 早停:倒序取最新的 N 条', () => {
    const d = db();
    try {
      const repo = new HookEventRepository(d);
      const [p1] = projectIds(d, ['/p1']);
      for (let i = 0; i < 5; i++) {
        repo.insert({ projectId: p1!, source: 'claude', eventType: 'UserPromptSubmit', sessionId: 's1', payload: ups(`第${i}条提到关键词`) });
      }
      const hits = repo.searchConversationTexts('关键词', 3);
      expect(hits).toHaveLength(3);
      expect(hits[0]!.text).toBe('第4条提到关键词');
    } finally {
      d.close();
    }
  });
});
