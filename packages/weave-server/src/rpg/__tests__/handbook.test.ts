import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RpgHandbookRepository } from '../handbook.js';
import { makeEvolutionServer } from './helpers/evolution-server.js';

/**
 * 全局手法库（G6 批6）：文件层即事实（零表结构）——learn/prune/索引同步/坏文件
 * 如实分账；端点外壳走 makeEvolutionServer（注入 tmp 根，不碰真手法库）。
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tmpRoot(): string {
  const r = mkdtempSync(path.join(tmpdir(), 'weave-hb-'));
  roots.push(r);
  return r;
}

describe('handbook 仓储（文件层事实）', () => {
  it('learn → list → MEMORY.md 索引行同步', async () => {
    const repo = new RpgHandbookRepository(tmpRoot());
    const r = await repo.learn({
      name: 'retry-then-flush',
      description: '投递前先探活，死了不入队',
      body: '判死（pidAliveOf===false）的会话不入队，开销比盲目入队低',
      source: 'coordinator',
    });
    expect(r.ok).toBe(true);
    const listed = await repo.list();
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]!.source).toBe('coordinator');
    expect(listed.broken).toEqual([]);
    const index = readFileSync(path.join(repo.root, 'MEMORY.md'), 'utf-8');
    expect(index).toContain('- [retry-then-flush](retry-then-flush.md) — 投递前先探活');
  });

  it('同名重写 = 巩固：description/body 换新、createdAt 保留原值', async () => {
    const repo = new RpgHandbookRepository(tmpRoot());
    await repo.learn({ name: 'split-scope', description: 'a', body: 'v1' });
    const first = (await repo.list()).entries[0]!;
    await repo.learn({ name: 'split-scope', description: 'b', body: 'v2 巩固' });
    const second = (await repo.list()).entries;
    expect(second).toHaveLength(1);
    expect(second[0]!.body).toBe('v2 巩固');
    expect(second[0]!.description).toBe('b');
    expect(second[0]!.createdAt).toBe(first.createdAt);
  });

  it('词表闸：name 非 kebab、body 缺失/超限——拒绝且不落盘', async () => {
    const repo = new RpgHandbookRepository(tmpRoot());
    expect((await repo.learn({ name: 'Bad Name', body: 'x' })).ok).toBe(false);
    expect((await repo.learn({ name: '../escape', body: 'x' })).ok).toBe(false);
    expect((await repo.learn({ name: 'ok-name' })).ok).toBe(false);
    expect((await repo.learn({ name: 'ok-name', body: 'x'.repeat(9000) })).ok).toBe(false);
    expect((await repo.list()).entries).toEqual([]);
  });

  it('prune 删文件并同步索引；不存在返回 false', async () => {
    const repo = new RpgHandbookRepository(tmpRoot());
    await repo.learn({ name: 'gone', description: 'd', body: 'b' });
    expect(await repo.prune('gone')).toBe(true);
    expect((await repo.list()).entries).toEqual([]);
    expect(await repo.prune('gone')).toBe(false);
  });

  it('坏 frontmatter 如实进 broken、不伪造条目（零伪造纪律）', async () => {
    const root = tmpRoot();
    writeFileSync(path.join(root, 'garbled.md'), 'no frontmatter at all', 'utf-8');
    const repo = new RpgHandbookRepository(root);
    const listed = await repo.list();
    expect(listed.entries).toEqual([]);
    expect(listed.broken).toEqual(['garbled.md']);
  });
});

describe('handbook 端点外壳（e2e）', () => {
  it('GET 空 → POST learn → GET 回读 → 重写巩固 → prune 后 404 如实', async () => {
    const { server, port, cleanup } = await makeEvolutionServer();
    try {
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/rpg/handbook`)).json()).toEqual({ entries: [], broken: [] });
      const post = await fetch(`${base}/rpg/handbook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'probe-then-queue', description: '先探活再入队', body: '判死不入队' }),
      });
      expect(post.status).toBe(200);
      const bad = await fetch(`${base}/rpg/handbook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'NOT-KEBAB', body: 'x' }),
      });
      expect(bad.status).toBe(400);
      const listed = (await (await fetch(`${base}/rpg/handbook`)).json()) as {
        entries: Array<{ name: string }>;
      };
      expect(listed.entries.map((e) => e.name)).toEqual(['probe-then-queue']);
      const pruned = await fetch(`${base}/rpg/handbook/prune`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'probe-then-queue' }),
      });
      expect(pruned.status).toBe(200);
      const miss = await fetch(`${base}/rpg/handbook/prune`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'probe-then-queue' }),
      });
      expect(miss.status).toBe(404);
    } finally {
      server.close();
      cleanup();
    }
  }, 30_000);
});
