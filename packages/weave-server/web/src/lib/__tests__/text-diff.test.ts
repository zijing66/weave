import { describe, it, expect } from 'vitest';
import { collapseDiff, countChanges, diffLines } from '../text-diff';

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
