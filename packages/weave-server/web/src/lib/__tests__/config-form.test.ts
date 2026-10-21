import { describe, it, expect } from 'vitest';
import {
  arrayItemsOf,
  boolOf,
  buildConfigTree,
  controlOf,
  defaultValueOf,
  emptyItemOf,
  fieldValueOf,
  itemObjectOf,
  linesOf,
  listOfLines,
  mapEntriesOf,
  mapOfEntries,
  matchesQuery,
  pruneTree,
  shapeOf,
  textOf,
  treeHasValue,
  valueAt,
  valueOfText,
  withFieldValue,
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

  it('配置树：文件键序在前、词表独有键补在后，同层父节点合并', () => {
    const spec = (key: string, type = 'string') => ({ key, type, group: 'G', description: '' });
    const keys = [spec('sandbox'), spec('sandbox.enabled', 'Boolean'), spec('model'), spec('env.ANTHROPIC_MODEL')];
    const values = {
      model: 'opus',
      sandbox: { enabled: true },
      extras: { a: 1 },
    };
    const tree = buildConfigTree(keys, values);
    expect(tree.map((n) => n.segment)).toEqual(['model', 'sandbox', 'extras', 'env']);
    const sandbox = tree.find((n) => n.segment === 'sandbox')!;
    expect(sandbox.spec?.key).toBe('sandbox');
    expect(sandbox.children.map((n) => n.path)).toEqual(['sandbox.enabled']);
    expect(sandbox.children[0].extra).toBe(false);
    // 词表没收录的对象展开到叶子，并标 extra
    expect(tree.find((n) => n.segment === 'extras')!.children[0].extra).toBe(true);
    // env 只收到词表给的子键（env 变量由调用方合成）
    expect(tree.find((n) => n.segment === 'env')!.children[0].path).toBe('env.ANTHROPIC_MODEL');
  });

  it('配置树：整体是一张 JSON 的对象键不拆开（hooks）', () => {
    const keys = [{ key: 'hooks', type: 'object', group: 'G', description: '' }];
    const tree = buildConfigTree(keys, { hooks: { Stop: [{ command: 'x' }] } });
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toEqual([]);
    expect(tree[0].spec?.key).toBe('hooks');
  });

  it('配置树：剪枝与「里面有值」判据', () => {
    const spec = (key: string) => ({ key, type: 'string', group: 'G', description: '' });
    const tree = buildConfigTree(
      [spec('sandbox'), spec('sandbox.enabled', ), spec('sandbox.network'), spec('model')],
      { model: 'opus', sandbox: { enabled: true } },
    );
    const hasValue = (path: string) => (path === 'model' || path === 'sandbox.enabled' ? 'x' : undefined) !== undefined;
    expect(treeHasValue(tree.find((n) => n.segment === 'sandbox')!, hasValue)).toBe(true);
    const kept = pruneTree(tree, (node) => node.path === 'model');
    expect(kept.map((n) => n.segment)).toEqual(['model']);
  });

  it('搜索与数组文本往返', () => {
    expect(matchesQuery('model', 'Set the model', 'MODEL')).toBe(true);
    expect(matchesQuery('model', 'Set the model', 'theme')).toBe(false);
    expect(linesOf(['a', 'b'])).toBe('a\nb');
    expect(listOfLines(' a \n\n b\n')).toEqual(['a', 'b']);
  });

  it('值形状：map 的条目往返，空键名不写进文件', () => {
    const value = { opus: { effortLevel: 'high' }, 'claude-sonnet': { maxEffortLevel: 'medium' } };
    const entries = mapEntriesOf(value);
    expect(entries.map((e) => e.key)).toEqual(['opus', 'claude-sonnet']);
    expect(mapOfEntries(entries)).toEqual(value);
    expect(mapOfEntries([...entries, { key: '  ', value: {} }])).toEqual(value);
    expect(mapEntriesOf(undefined)).toEqual([]);
    expect(mapEntriesOf(['not', 'a', 'map'])).toEqual([]);
  });

  it('值形状：元素字段读改写，清空字段即删掉那个键', () => {
    const field = { name: 'mode', type: 'enum', options: ['deny', 'mask'] };
    const item = { path: '/a', mode: 'deny' };
    expect(fieldValueOf(item, field)).toBe('deny');
    expect(withFieldValue(item, field, undefined)).toEqual({ path: '/a' });
    expect(withFieldValue(item, field, 'mask')).toEqual({ path: '/a', mode: 'mask' });
    expect(withFieldValue(undefined, field, 'deny')).toEqual({ mode: 'deny' });
    expect(itemObjectOf('scalar')).toEqual({});
  });

  it('值形状：新元素按字段（对象）或标量（默认值）起手', () => {
    const rows = { key: 'rows', type: 'array of rows', group: 'G', description: '', shape: 'array' as const, fields: [{ name: 'model', type: 'string' }] };
    expect(emptyItemOf(rows)).toEqual({});
    const scalars = { key: 'names', type: 'array of strings', group: 'G', description: '', shape: 'array' as const, valueOptions: ['a', 'b'] };
    expect(emptyItemOf(scalars)).toBe('a');
    expect(shapeOf(rows)).toBe('array');
    expect(shapeOf({ key: 'model', type: 'string', group: 'G', description: '' })).toBeNull();
    expect(arrayItemsOf({})).toEqual([]);
  });
});
