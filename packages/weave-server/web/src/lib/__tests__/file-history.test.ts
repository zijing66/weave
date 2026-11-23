import { beforeEach, describe, expect, it } from 'vitest';
import { loadMergedFileHistory } from '../file-history';

/** 跨项目合并视图：全项目文件浏览器首屏的「最近打开」。 */
const KEY = 'weave:file-browser-history';
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
};

function write(buckets: Record<string, unknown>): void {
  store.set(KEY, JSON.stringify(buckets));
}

describe('loadMergedFileHistory', () => {
  beforeEach(() => store.clear());

  it('各项目桶摊平、按最近倒序，条目带 projectId', () => {
    write({
      '21': [{ path: 'a/SKILL.md', name: 'SKILL.md', at: 100 }],
      '168': [
        { path: 'b/x.ts', name: 'x.ts', at: 300 },
        { path: 'c/y.ts', name: 'y.ts', at: 200 },
      ],
    });
    expect(loadMergedFileHistory().map((e) => [e.projectId, e.path])).toEqual([
      [168, 'b/x.ts'],
      [168, 'c/y.ts'],
      [21, 'a/SKILL.md'],
    ]);
  });

  it('坏 JSON 回空；非数组桶 / 非数字键 / 缺 path 的条目跳过', () => {
    store.set(KEY, '{oops');
    expect(loadMergedFileHistory()).toEqual([]);
    write({
      '21': { nope: 1 },
      x: [{ path: 'ghost.ts', name: 'ghost.ts', at: 9 }],
      '22': [{ name: 'no-path' }, { path: 'ok.ts', name: 'ok.ts', at: 5 }],
    });
    expect(loadMergedFileHistory().map((e) => e.path)).toEqual(['ok.ts']);
  });

  it('超上限只留最近的 max 条', () => {
    write({
      '1': Array.from({ length: 5 }, (_, i) => ({ path: `p${i}.ts`, name: `p${i}.ts`, at: i })),
    });
    expect(loadMergedFileHistory(3).map((e) => e.path)).toEqual(['p4.ts', 'p3.ts', 'p2.ts']);
  });
});
