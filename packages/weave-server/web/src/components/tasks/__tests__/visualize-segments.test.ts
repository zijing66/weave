import { describe, expect, it } from 'vitest';
import {
  hasVisualizeRef,
  stripVisualizeRefs,
  visualizeSegments,
} from '../conv-model';

const ref = (path: string, suffix = true): string =>
  `\u{e200}visualize\u{e202}{"path":"${path}"}${suffix ? '\u{e201}' : ''}`;

describe('visualizeSegments', () => {
  it('无引用行 → 单文本段', () => {
    expect(visualizeSegments('hello\nworld')).toEqual([
      { kind: 'text', text: 'hello\nworld' },
    ]);
  });

  it('单引用行（带 suffix）→ viz 段', () => {
    const segs = visualizeSegments(`before\n${ref('D:/x/a.html')}\nafter`);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ kind: 'text', text: 'before' });
    expect(segs[1]).toEqual({ kind: 'viz', ref: { path: 'D:/x/a.html' } });
    expect(segs[2]).toEqual({ kind: 'text', text: 'after' });
  });

  it('suffix 缺席照认（codex TUI 实测如此）', () => {
    const segs = visualizeSegments(ref('D:/x/a.html', false));
    expect(segs).toEqual([{ kind: 'viz', ref: { path: 'D:/x/a.html' } }]);
  });

  it('title 与 mode 解析', () => {
    const segs = visualizeSegments(
      `\u{e200}visualize\u{e202}{"path":"D:/x/a.html","title":"Chart","mode":"wide"}\u{e201}`,
    );
    expect(segs).toEqual([
      { kind: 'viz', ref: { path: 'D:/x/a.html', title: 'Chart', mode: 'wide' } },
    ]);
  });

  it('JSON 坏行回落普通文本', () => {
    const bad = '\u{e200}visualize\u{e202}{broken';
    const segs = visualizeSegments(`a\n${bad}\nb`);
    expect(segs).toEqual([{ kind: 'text', text: 'a\n\u{e200}visualize\u{e202}{broken\nb' }]);
  });

  it('缺 path / path 非字符串回落普通文本', () => {
    const segs = visualizeSegments('\u{e200}visualize\u{e202}{}');
    expect(segs[0]!.kind).toBe('text');
    const segs2 = visualizeSegments('\u{e200}visualize\u{e202}{"path":123}');
    expect(segs2[0]!.kind).toBe('text');
  });

  it('多个引用行各自成段', () => {
    const segs = visualizeSegments(`${ref('D:/1.html')}\ntext\n${ref('D:/2.html')}`);
    expect(segs.map((s) => s.kind)).toEqual(['viz', 'text', 'viz']);
  });

  it('引用行必须整行（行中夹杂不当 viz）', () => {
    const segs = visualizeSegments(`see ${ref('D:/x.html')} inline`);
    expect(segs).toEqual([{ kind: 'text', text: `see ${ref('D:/x.html')} inline` }]);
  });
});

describe('hasVisualizeRef / stripVisualizeRefs', () => {
  it('hasVisualizeRef 短路', () => {
    expect(hasVisualizeRef(`x\n${ref('D:/a.html')}`)).toBe(true);
    expect(hasVisualizeRef('plain text')).toBe(false);
  });

  it('strip 删引用行、压多余空行、去首尾空白', () => {
    expect(stripVisualizeRefs(`a\n\n${ref('D:/a.html')}\n\n\nb\n`)).toBe('a\n\nb');
  });

  it('strip 无引用行时原样（trim 后）', () => {
    expect(stripVisualizeRefs('  hello  ')).toBe('hello');
  });
});
