import { describe, it, expect } from 'vitest';
import { groupByRepo, toggleIn } from '@/lib/repo-groups';

const item = (namespace?: string) => (namespace === undefined ? {} : { namespace });

/**
 * L1 折叠块的分组：#l1 = 仓库 namespace，无 namespace 的资源并成一块「本地」。
 * 这是「按仓库维度管理资源」的一级维度（Skills 与 Plugins 同源），错位会让
 * 整页的层级语义崩掉。
 */
describe('groupByRepo（仓库维度一级分组）', () => {
  it('无 namespace 的项并成一块「本地」且排最前', () => {
    const repos = groupByRepo([item(), item(), item('claude-plugins-official')]);

    expect(repos.map((r) => r.namespace)).toEqual([undefined, 'claude-plugins-official']);
    expect(repos[0].groups).toHaveLength(2);
    expect(repos[0].key).toBe('__local__');
  });

  it('同仓库下的多个成员收进同一个 namespace 块，成员序保持输入序', () => {
    const repos = groupByRepo([
      { namespace: 'official', label: 'superpowers' },
      { namespace: 'official', label: 'figma' },
      { namespace: 'openai-bundled', label: 'pdf' },
    ]);

    expect(repos.map((r) => r.namespace)).toEqual(['official', 'openai-bundled']);
    expect(repos[0].groups.map((g) => g.label)).toEqual(['superpowers', 'figma']);
    expect(repos[1].groups.map((g) => g.label)).toEqual(['pdf']);
  });

  it('仓库块按 namespace 名排序，与输入顺序无关', () => {
    const repos = groupByRepo([item('zeta'), item('alpha')]);
    expect(repos.map((r) => r.namespace)).toEqual(['alpha', 'zeta']);
  });

  it('空输入 → 无块（不产出空壳）', () => {
    expect(groupByRepo([])).toEqual([]);
  });

  it('本地与市场混排时「本地」恒在首位', () => {
    const repos = groupByRepo([item('aaa-market'), item()]);
    expect(repos[0].namespace).toBeUndefined();
  });
});

describe('toggleIn（折叠集切换）', () => {
  it('未在其中则加入、已在其中则移除，且不改原集合', () => {
    const base = new Set(['a']);
    expect([...toggleIn(base, 'b')]).toEqual(['a', 'b']);
    expect([...toggleIn(base, 'a')]).toEqual([]);
    expect([...base]).toEqual(['a']);
  });
});
