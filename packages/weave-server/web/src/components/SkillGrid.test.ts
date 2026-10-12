import { describe, it, expect } from 'vitest';
import { groupByRepo, type SkillGroup } from './SkillGrid';

const group = (over: Partial<SkillGroup> & Pick<SkillGroup, 'source' | 'label'>): SkillGroup => ({
  skills: [],
  ...over,
});

/**
 * L1 折叠块的分组：#l1 = 仓库 namespace，个人组（无 namespace）并成一块「本地」。
 * 这是「按仓库维度管理资源」的一级维度，错位会让整页的层级语义崩掉。
 */
describe('groupByRepo（仓库维度一级分组）', () => {
  it('个人组并成一块「本地」且排最前（claude 与 codex 的个人技能同块）', () => {
    const repos = groupByRepo([
      group({ source: 'claude-personal', label: 'Claude Code · 个人' }),
      group({ source: 'codex-personal', label: 'Codex · 个人' }),
      group({ source: 'claude-plugin', label: 'superpowers', namespace: 'claude-plugins-official' }),
    ]);

    expect(repos.map((r) => r.namespace)).toEqual([undefined, 'claude-plugins-official']);
    expect(repos[0].groups.map((g) => g.source)).toEqual(['claude-personal', 'codex-personal']);
    expect(repos[0].key).not.toBe('claude-plugins-official');
  });

  it('同市场下的多个插件包收进同一个 namespace 块，包序保持输入序', () => {
    const repos = groupByRepo([
      group({ source: 'claude-plugin', label: 'superpowers', namespace: 'official' }),
      group({ source: 'claude-plugin', label: 'figma', namespace: 'official' }),
      group({ source: 'codex-plugin', label: 'pdf', namespace: 'openai-bundled' }),
    ]);

    expect(repos.map((r) => r.namespace)).toEqual(['official', 'openai-bundled']);
    expect(repos[0].groups.map((g) => g.label)).toEqual(['superpowers', 'figma']);
    expect(repos[1].groups.map((g) => g.label)).toEqual(['pdf']);
  });

  it('市场块按 namespace 名排序，与输入顺序无关', () => {
    const repos = groupByRepo([
      group({ source: 'claude-plugin', label: 'x', namespace: 'zeta' }),
      group({ source: 'claude-plugin', label: 'y', namespace: 'alpha' }),
    ]);
    expect(repos.map((r) => r.namespace)).toEqual(['alpha', 'zeta']);
  });

  it('空输入 → 无块（不产出空壳）', () => {
    expect(groupByRepo([])).toEqual([]);
  });

  it('个人组与市场组混排时「本地」恒在首位', () => {
    const repos = groupByRepo([
      group({ source: 'claude-plugin', label: 'aaa', namespace: 'aaa-market' }),
      group({ source: 'codex-personal', label: 'Codex · 个人' }),
    ]);
    expect(repos[0].namespace).toBeUndefined();
  });
});
