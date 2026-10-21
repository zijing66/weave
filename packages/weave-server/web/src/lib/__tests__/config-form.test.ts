import { describe, it, expect } from 'vitest';
import {
  boolOf,
  controlOf,
  defaultValueOf,
  groupKeys,
  linesOf,
  listOfLines,
  matchesQuery,
  textOf,
  valueAt,
  valueOfText,
} from '../config-form';

describe('配置表单纯函数', () => {
  it('词表类型 → 控件', () => {
    expect(controlOf('Boolean')).toBe('switch');
    expect(controlOf('string', ['low', 'high'])).toBe('select');
    expect(controlOf('number')).toBe('number');
    expect(controlOf('array of model aliases or IDs')).toBe('list');
    expect(controlOf('object')).toBe('object');
    expect(controlOf('string, a model alias or full model ID')).toBe('text');
  });

  it('取值走点号路径', () => {
    const values = { sandbox: { filesystem: { allowWrite: ['/a'] } }, model: 'opus' };
    expect(valueAt(values, 'sandbox.filesystem.allowWrite')).toEqual(['/a']);
    expect(valueAt(values, 'model')).toBe('opus');
    expect(valueAt(values, 'sandbox.nope')).toBeUndefined();
    expect(valueAt({ a: 1 }, 'a.b')).toBeUndefined();
  });

  it('文本 ↔ 值：JSON 优先、空串即删除', () => {
    expect(valueOfText('["a","b"]')).toEqual({ value: ['a', 'b'] });
    expect(valueOfText('  ')).toEqual({ value: undefined, remove: true });
    expect(valueOfText('opus')).toEqual({ value: 'opus' });
    expect(valueOfText('[oops').error).toBe('invalidJson');
    expect(textOf(['a', 1])).toBe('[\n  "a",\n  1\n]');
    expect(textOf(undefined)).toBe('');
  });

  it('开关与缺省值', () => {
    expect(boolOf(undefined)).toBe(false);
    expect(boolOf('true')).toBe(true);
    expect(defaultValueOf('Boolean')).toBe(true);
    expect(defaultValueOf('string', ['a', 'b'])).toBe('a');
    expect(defaultValueOf('array of strings')).toEqual([]);
    expect(defaultValueOf('number')).toBe(0);
  });

  it('分组按词表顺序、空组不出现', () => {
    const keys = [
      { key: 'a', group: 'G1' },
      { key: 'b', group: 'G2' },
    ];
    expect(groupKeys(keys, ['G2', 'G1', 'G3']).map((g) => g.group)).toEqual(['G2', 'G1']);
  });

  it('搜索与数组文本往返', () => {
    expect(matchesQuery('model', 'Set the model', 'MODEL')).toBe(true);
    expect(matchesQuery('model', 'Set the model', 'theme')).toBe(false);
    expect(linesOf(['a', 'b'])).toBe('a\nb');
    expect(listOfLines(' a \n\n b\n')).toEqual(['a', 'b']);
  });
});
