import { describe, it, expect } from 'vitest';
import { resolveRule, renderTable } from '../commands/hooks';

const rules = [
  { id: 'aaaa1111-0000', name: 'A', enabled: true, projectId: null, source: { kind: 'claude-event', event: 'Stop' }, handler: { type: 'log' } },
  { id: 'aaaa2222-0000', name: 'B', enabled: false, projectId: 1, source: { kind: 'claude-event', event: 'PostToolUse' }, handler: { type: 'inject' } },
  { id: 'bbbb3333-0000', name: 'C', enabled: true, projectId: null, source: { kind: 'claude-event', event: 'Stop' }, handler: { type: 'manual' } },
];

describe('hooks command helpers', () => {
  it('resolveRule：精确 ID 优先', () => {
    expect(resolveRule(rules, 'aaaa2222-0000').rule?.name).toBe('B');
  });

  it('resolveRule：唯一前缀可解析', () => {
    expect(resolveRule(rules, 'bbbb').rule?.name).toBe('C');
    expect(resolveRule(rules, 'aaaa2222').rule?.name).toBe('B');
  });

  it('resolveRule：多命中标记 ambiguous，无命中返回空', () => {
    expect(resolveRule(rules, 'aaaa').ambiguous).toBe(true);
    expect(resolveRule(rules, 'zzz')).toEqual({});
  });

  it('renderTable：按列宽对齐且保留所有单元格', () => {
    const out = renderTable(['A', 'BB'], [['x', 'y'], ['longer', 'z']]);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('A'); // 表头
    expect(lines[1]).toContain('x');
    expect(lines[2]).toContain('longer');
    // 第二列起对齐：两行数据的第二列处于同一列位置
    expect(lines[1]!.indexOf('y')).toBe(lines[2]!.indexOf('z'));
  });
});
