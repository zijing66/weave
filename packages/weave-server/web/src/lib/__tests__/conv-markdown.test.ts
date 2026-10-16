import { describe, it, expect } from 'vitest';
import { parseInline, parseMarkdown, type MdBlock, type MdSpan } from '../conv-markdown';

const text = (spans: readonly MdSpan[]): string => spans.map((s) => s.text).join('');
const styles = (spans: readonly MdSpan[]): string[] => spans.map((s) => `${s.text}:${s.style}`);
const kinds = (blocks: readonly MdBlock[]): string[] => blocks.map((b) => b.kind);

describe('parseInline', () => {
  it('粗体/斜体/行内代码/删除线各自成 span', () => {
    expect(styles(parseInline('a **粗** b *斜* c `码` d ~~删~~'))).toEqual([
      'a :plain',
      '粗:strong',
      ' b :plain',
      '斜:em',
      ' c :plain',
      '码:code',
      ' d :plain',
      '删:del',
    ]);
  });

  it('嵌套：代码与链接吃掉内层样式，粗+斜合成一档', () => {
    expect(styles(parseInline('`**x**`'))).toEqual(['**x**:code']);
    expect(styles(parseInline('**[a](u)**'))).toEqual(['a (u):link']);
    expect(styles(parseInline('**_x_**'))).toEqual(['x:strongEm']);
  });

  it('链接：同文案只留标签、异文案补出目标（图片点不动，不写等于丢了）', () => {
    expect(styles(parseInline('[文档](文档)'))).toEqual(['文档:link']);
    expect(text(parseInline('见 [文档](https://a.b/c)'))).toBe('见 文档 (https://a.b/c)');
  });

  it('裸链接只吃链接本体，句末标点退回正文', () => {
    expect(styles(parseInline('见 https://a.b/c. 完'))).toEqual([
      '见 :plain',
      'https://a.b/c:link',
      '. 完:plain',
    ]);
  });

  it('反斜杠转义出字面记号', () => {
    expect(styles(parseInline('\\*不是斜体\\*'))).toEqual(['*不是斜体*:plain']);
  });

  it('解析不出的记号原样留下', () => {
    expect(text(parseInline('a * b 与 # 与 | 与 [x]'))).toBe('a * b 与 # 与 | 与 [x]');
  });
});

describe('parseMarkdown', () => {
  it('段落：软换行接成一行、空行分段', () => {
    const blocks = parseMarkdown('一行\n二行\n\n另一段');
    expect(kinds(blocks)).toEqual(['p', 'p']);
    expect(text((blocks[0] as { spans: MdSpan[] }).spans)).toBe('一行 二行');
  });

  it('标题与分隔线各自成块', () => {
    const blocks = parseMarkdown('# 一级\n\n---\n\n### 三级');
    expect(kinds(blocks)).toEqual(['h', 'hr', 'h']);
    expect((blocks[0] as { level: number }).level).toBe(1);
    expect((blocks[2] as { level: number }).level).toBe(3);
  });

  it('围栏代码整段保留（含空行与缩进），未闭合也照收', () => {
    const blocks = parseMarkdown('```ts\nconst a = 1;\n\n  b\n```\n尾巴');
    expect(kinds(blocks)).toEqual(['code', 'p']);
    expect((blocks[0] as { lines: string[] }).lines).toEqual(['const a = 1;', '', '  b']);
    expect(kinds(parseMarkdown('```\n裸的'))).toEqual(['code']);
  });

  it('列表：记号归一、任务框、嵌套层级、续行并入上一条', () => {
    const blocks = parseMarkdown('- 一条\n- [x] 做完\n  - 子项\n  续行');
    const items = (blocks[0] as { items: { marker: string; level: number; spans: MdSpan[] }[] }).items;
    expect(items.map((i) => i.marker)).toEqual(['•', '☑', '•']);
    expect(items.map((i) => i.level)).toEqual([0, 0, 1]);
    expect(text(items[2]!.spans)).toBe('子项 续行');
  });

  it('有序列表保留原文序号', () => {
    const blocks = parseMarkdown('3. 三\n4. 四');
    const items = (blocks[0] as { items: { marker: string }[] }).items;
    expect(items.map((i) => i.marker)).toEqual(['3.', '4.']);
  });

  it('引用按行收（空行也留一个空行）', () => {
    const blocks = parseMarkdown('> 一\n>\n> 二');
    expect(kinds(blocks)).toEqual(['quote']);
    const lines = (blocks[0] as { lines: MdSpan[][] }).lines;
    expect(lines.length).toBe(3);
    expect(text(lines[2]!)).toBe('二');
  });

  it('表格吃掉分隔行、格子里的行内记号照解、`\\|` 是字面竖线', () => {
    const blocks = parseMarkdown('| a | **b** |\n| --- | --- |\n| `x\\|y` | 2 |');
    expect(kinds(blocks)).toEqual(['table']);
    const rows = (blocks[0] as { rows: MdSpan[][][] }).rows;
    expect(rows.length).toBe(2);
    expect(rows[0]!.map(text)).toEqual(['a', 'b']);
    expect(rows[0]![1]!.map((s) => s.style)).toEqual(['strong']);
    expect(text(rows[1]![0]!)).toBe('x|y');
  });

  it('制表符按 4 空格摊开', () => {
    const blocks = parseMarkdown('a\tb');
    expect(text((blocks[0] as { spans: MdSpan[] }).spans)).toBe('a b');
  });
});
