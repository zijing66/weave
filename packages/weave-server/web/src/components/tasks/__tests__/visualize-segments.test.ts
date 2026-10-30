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

  it('LANGUAGE TAG 区同义写法照认（U+E200/E202/E201 → U+E0000/E0001/E0002）', () => {
    const tagRef = (path: string, suffix = true): string =>
      `\u{e0000}visualize\u{e0001}{"path":"${path}"}${suffix ? '\u{e0002}' : ''}`;
    expect(visualizeSegments(tagRef('D:/x/a.html'))).toEqual([
      { kind: 'viz', ref: { path: 'D:/x/a.html' } },
    ]);
    // suffix 缺席照认；夹在正文中间也照切
    const segs = visualizeSegments(`before\n${tagRef('D:/x/b.html', false)}\nafter`);
    expect(segs).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'viz', ref: { path: 'D:/x/b.html' } },
      { kind: 'text', text: 'after' },
    ]);
    expect(hasVisualizeRef(tagRef('D:/x/c.html'))).toBe(true);
    expect(stripVisualizeRefs(`a\n${tagRef('D:/x/d.html')}\nb`)).toBe('a\nb');
  });

  it('降级形（裸 `visualize` 行）照认——压缩摘要会把不可见字符整个吃掉', () => {
    const bare = 'visualize{"path":"D:/x/a.html"}';
    expect(visualizeSegments(bare)).toEqual([{ kind: 'viz', ref: { path: 'D:/x/a.html' } }]);
    expect(hasVisualizeRef(`前文\n\n${bare}\n\n后文`)).toBe(true);
    // 正文里提到语法（带前缀文字 / 反引号）不算引用行
    expect(hasVisualizeRef('输出 `visualize{"path":"D:/x/a.html"}` 这行')).toBe(false);
    expect(visualizeSegments('1. 写 visualize{"path":"D:/x/a.html"}')).toEqual([
      { kind: 'text', text: '1. 写 visualize{"path":"D:/x/a.html"}' },
    ]);
    // 裸形也必须过 JSON 校验：坏 JSON 当文本
    expect(visualizeSegments('visualize{oops}')).toEqual([{ kind: 'text', text: 'visualize{oops}' }]);
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
