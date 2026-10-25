import { describe, it, expect } from 'vitest';
import { collapseDiff, countChanges, diffLines, pairSplitRows } from '../text-diff';

describe('行级 diff', () => {
  it('未变行原样、增删分开标', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    expect(lines).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
    ]);
    expect(countChanges(lines)).toEqual({ added: 1, removed: 1 });
  });

  it('纯新增与纯删除', () => {
    expect(diffLines('', 'x\ny\n').filter((l) => l.kind === 'add')).toHaveLength(2);
    expect(diffLines('x\ny\n', '').filter((l) => l.kind === 'del')).toHaveLength(2);
  });

  it('CRLF 与末尾换行不制造噪声', () => {
    expect(diffLines('a\r\nb\r\n', 'a\nb\n')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
    ]);
  });

  it('折叠：远端的未变区压成 skip', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'X');
    const rows = collapseDiff(diffLines(before, after), 2);
    const skips = rows.filter((r) => r.kind === 'skip');
    expect(skips.length).toBe(2);
    expect(rows.some((r) => r.kind === 'add' && r.text === 'X')).toBe(true);
    // 变更行前后各 2 行仍可见
    expect(rows.filter((r) => r.kind === 'same').length).toBe(4);
  });
});

describe('pairSplitRows（左右分栏配对）', () => {
  it('same 两侧同行；相邻 del/add 配成 mod（左旧右新）', () => {
    const rows = pairSplitRows([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
    ]);
    expect(rows).toEqual([
      { kind: 'same', left: 'a', right: 'a' },
      { kind: 'mod', left: 'b', right: 'B' },
      { kind: 'same', left: 'c', right: 'c' },
    ]);
  });

  it('数量不齐的多出侧补空行；纯增/纯删不成对', () => {
    expect(pairSplitRows([{ kind: 'del', text: 'x' }, { kind: 'del', text: 'y' }, { kind: 'add', text: 'z' }])).toEqual([
      { kind: 'mod', left: 'x', right: 'z' },
      { kind: 'del', left: 'y', right: null },
    ]);
    expect(pairSplitRows([{ kind: 'add', text: 'n1' }, { kind: 'add', text: 'n2' }])).toEqual([
      { kind: 'add', left: null, right: 'n1' },
      { kind: 'add', left: null, right: 'n2' },
    ]);
  });

  it('skip 整行横跨两栏', () => {
    expect(pairSplitRows([{ kind: 'skip', count: 7 }])).toEqual([
      { kind: 'skip', left: null, right: null, count: 7 },
    ]);
  });
});
