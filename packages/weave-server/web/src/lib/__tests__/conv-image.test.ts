import { describe, it, expect } from 'vitest';
import {
  IMG_WIDTH,
  META_ROW_H,
  drawConversation,
  imageFileName,
  layoutConversation,
  paletteFor,
  pickScale,
  variantOf,
  wrapSpans,
  type BoxBlock,
  type ConvImageBlock,
  type ConvImageEntry,
  type ConvImageMeta,
  type FlowBlock,
  type Measure,
  type TableBlock,
} from '../conv-image';

/** 假量宽：中日韩字宽 13、其余 7（只为验证折行与排版规则，不追求真字宽）。 */
const width = (text: string): number =>
  [...text].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 13 : 7), 0);

const measure: Measure = (_font, text) => width(text);

const opts = {
  stamp: (iso: string) => `T(${iso})`,
  theme: 'dark' as const,
};

/** meta 行的全部文本（左组 + 右组，按绘制顺序）。 */
const metaText = (m: ConvImageMeta): string => [...m.left, ...m.right].map((s) => s.text).join('');

const AT = '2026-10-16T09:00:00.000Z';

const blocksOf = (text: string, role: 'user' | 'assistant' = 'assistant'): ConvImageBlock[] =>
  layoutConversation(measure, [{ role, at: AT, text }], opts).bubbles[0]!.blocks;

const boxOf = (text: string): BoxBlock => {
  const blk = blocksOf(text)[0]!;
  expect(blk.kind).toBe('box');
  return blk as BoxBlock;
};

describe('pickScale', () => {
  it('低画布走 2 倍、超上限降 1 倍', () => {
    expect(pickScale(IMG_WIDTH, 3000)).toBe(2);
    expect(pickScale(IMG_WIDTH, 12000)).toBe(1);
  });
});

describe('wrapSpans', () => {
  const pal = paletteFor('dark');

  it('中日韩任意处可折，拉丁词整体不折', () => {
    const cjk = wrapSpans(measure, [{ text: '这是一段中文说明文字', style: 'plain' }], pal, 26, 19);
    expect(cjk.map((l) => l.spans.map((s) => s.text).join(''))).toEqual(['这是', '一段', '中文', '说明', '文字']);
    const latin = wrapSpans(measure, [{ text: 'hello world foo', style: 'plain' }], pal, 40, 19);
    expect(latin.map((l) => l.spans.map((s) => s.text).join(''))).toEqual(['hello', 'world', 'foo']);
  });

  it('单个超长串逐字硬断，不溢出', () => {
    const lines = wrapSpans(measure, [{ text: 'https://example.com/averyverylongpath', style: 'plain' }], pal, 35, 19);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(width(l.spans.map((s) => s.text).join(''))).toBeLessThanOrEqual(35);
  });

  it('行首空白吃掉、行尾不留空；代码块要保留缩进', () => {
    const prose = wrapSpans(measure, [{ text: 'aaaa   bbbb', style: 'plain' }], pal, 30, 19);
    expect(prose.map((l) => l.spans.map((s) => s.text).join(''))).toEqual(['aaaa', 'bbbb']);
    const code = wrapSpans(measure, [{ text: '  x', style: 'plain' }], pal, 100, 16, { keepSpace: true });
    expect(code[0]!.spans.map((s) => s.text).join('')).toBe('  x');
  });

  it('行内样式带进 span（代码带底色、链接带下划线）', () => {
    const lines = wrapSpans(
      measure,
      [
        { text: '粗', style: 'strong' },
        { text: '码', style: 'code' },
        { text: '链', style: 'link' },
      ],
      pal,
      999,
      19,
    );
    const spans = lines[0]!.spans;
    expect(spans.map((s) => s.font)).toEqual(['strong', 'mono', 'body']);
    expect(spans[1]!.bg).toBeTruthy();
    expect(spans[2]!.underline).toBe(true);
  });
});

describe('layoutConversation', () => {
  const entries: ConvImageEntry[] = [
    { role: 'user', at: AT, text: '我发的很长的消息' },
    { role: 'assistant', at: '2026-10-16T09:00:05.000Z', text: '回复' },
  ];

  it('自己发的贴右、回复贴左，恰好留出页边距', () => {
    const layout = layoutConversation(measure, entries, opts);
    const [user, assistant] = layout.bubbles;
    expect(user!.role).toBe('user');
    expect(user!.x + user!.w).toBe(IMG_WIDTH - 24);
    expect(assistant!.x).toBe(24);
    expect(layout.width).toBe(IMG_WIDTH);
  });

  it('meta 行在气泡里：回复「时刻 + tag」靠左、发送「tag + 时刻」贴右', () => {
    const one = layoutConversation(measure, entries.slice(0, 1), opts);
    const two = layoutConversation(measure, entries, opts);
    expect(two.height).toBeGreaterThan(one.height);
    const [user, assistant] = two.bubbles;
    expect(metaText(assistant!.meta)).toBe(`T(2026-10-16T09:00:05.000Z)`);
    expect(metaText(user!.meta)).toBe(`T(${AT})`);
    // 发送侧的时刻贴右：右组就是时刻本身
    expect(user!.meta.right.reduce((n, s) => n + s.w, 0)).toBe(width(`T(${AT})`));
    const tagged = layoutConversation(
      measure,
      [
        { role: 'user', at: AT, text: '我发的', tags: [{ kind: 'weave', text: 'weave' }] },
        { role: 'assistant', at: AT, text: '回复', tags: [{ kind: 'plan', text: '计划' }] },
      ],
      opts,
    );
    expect(metaText(tagged.bubbles[0]!.meta)).toBe(`weaveT(${AT})`);
    expect(metaText(tagged.bubbles[1]!.meta)).toBe(`T(${AT})计划`);
    const taller = layoutConversation(measure, [{ ...entries[0]!, text: entries[0]!.text.repeat(20) }], opts);
    expect(taller.height).toBeGreaterThan(one.height);
    expect(taller.bubbles[0]!.w).toBeLessThanOrEqual(IMG_WIDTH - 48);
  });

  it('气泡配色按面板那四种分：weave 投递 / 手敲 / 失败 / 回复', () => {
    expect(variantOf({ role: 'user', at: AT, text: '', viaWeave: true })).toBe('user');
    expect(variantOf({ role: 'user', at: AT, text: '' })).toBe('userTyped');
    expect(variantOf({ role: 'user', at: AT, text: '', failed: true })).toBe('failed');
    expect(variantOf({ role: 'assistant', at: AT, text: '' })).toBe('assistant');
    const v = layoutConversation(measure, [{ role: 'assistant', at: AT, text: '', failed: true }], opts);
    expect(v.bubbles[0]!.variant).toBe('failed');
  });

  it('正文按 markdown 排：标题用标题字重、行内代码带底色', () => {
    const blocks = blocksOf('## 小标题\n\n正文带 `码` 与 **粗**。');
    const head = blocks[0]! as FlowBlock;
    expect(head.kind).toBe('flow');
    expect(head.lines[0]!.spans[0]!.font).toBe('strong');
    const body = blocks[1]! as FlowBlock;
    expect(body.kind).toBe('flow');
    expect(body.lines[0]!.spans.some((s) => s.font === 'mono' && s.bg)).toBe(true);
  });

  it('围栏代码自成一块（等宽 + 底色），行内换行不并进正文', () => {
    const box = boxOf('```\nconst a = 1\n```');
    expect(box.fill).toBeTruthy();
    expect(box.lines.length).toBe(1);
    expect(box.lines[0]!.spans[0]!.font).toBe('mono');
    expect(box.lines[0]!.spans.map((s) => s.text).join('')).toBe('const a = 1');
    expect(box.h).toBeGreaterThan(16);
  });

  it('列表出记号、续行对齐到正文起点', () => {
    const list = blocksOf('- 一条\n- 两条')[0]! as FlowBlock;
    expect(list.kind).toBe('flow');
    expect(list.lines.map((l) => l.marker?.text)).toEqual(['• ', '• ']);
    expect(list.lines[0]!.indent).toBe(0);
    const long = Array.from({ length: 8 }, () => `- ${'很长'.repeat(40)}`).join('\n');
    const wrapped = blocksOf(long)[0]! as FlowBlock;
    const hold = wrapped.lines.find((l) => !l.marker)!;
    expect(hold.indent).toBe(width('• '));
  });

  it('引用画左竖线、表格画格线', () => {
    const quote = boxOf('> 引用一行');
    expect(quote.leftBar).toBeTruthy();
    expect(quote.fill).toBeUndefined();
    const table = blocksOf('| a | b |\n| - | - |\n| 1 | 2 |')[0]! as TableBlock;
    expect(table.kind).toBe('table');
    expect(table.colW.length).toBe(2);
    expect(table.rows.map((r) => r.head)).toEqual([true, false]);
    expect(table.rows.every((r) => r.cells.length === 2)).toBe(true);
  });

  it('气泡下方不留空行（文末换行不算块；高度 = meta 行 + 正文 + 上下内衬）', () => {
    const b = layoutConversation(measure, [{ role: 'assistant', at: AT, text: '答案一行\n' }], opts).bubbles[0]!;
    expect(b.blocks.length).toBe(1);
    expect((b.blocks[0] as FlowBlock).lines.length).toBe(1);
    expect(b.h).toBe(19 + 20 + META_ROW_H);
  });

  it('块不撑破气泡内宽（超长串硬断）', () => {
    const long = 'x'.repeat(400);
    const layout = layoutConversation(measure, [{ role: 'assistant', at: AT, text: long }], opts);
    const b = layout.bubbles[0]!;
    for (const blk of b.blocks) expect(blk.w).toBeLessThanOrEqual(b.w - 20);
    const flow = b.blocks[0]! as FlowBlock;
    for (const line of flow.lines) {
      expect(line.spans.reduce((n, s) => n + s.w, 0)).toBeLessThanOrEqual(b.w - 20);
    }
  });

  it('整篇 markdown 排版自洽：块首尾相接、每行不超气泡内宽、气泡不超上限', () => {
    const rich = [
      '## 标题 **粗**',
      '',
      '段落带 `码`、[链接](https://a.b/c) 与裸链接 https://x.y/z。',
      '',
      '- 一\n- [x] 二\n  - 三',
      '',
      '> 引用一行',
      '',
      '```ts\nconst a = 1;\n  const b = 2;\n```',
      '',
      '| 列 A | 列 B |',
      '| --- | --- |',
      '| 一 | 二 |',
      '',
      '---',
    ].join('\n');
    const layout = layoutConversation(measure, [{ role: 'assistant', at: AT, text: rich }], opts);
    const b = layout.bubbles[0]!;
    const inner = b.w - 20;
    expect(b.w).toBeLessThanOrEqual(Math.round((IMG_WIDTH - 48) * 0.78));
    let acc = 0;
    for (const blk of b.blocks) {
      expect(blk.y).toBe(acc);
      expect(blk.gap).toBe(acc === 0 ? 0 : blk.kind === 'flow' ? 4 : 8);
      acc += blk.gap + blk.h;
      expect(blk.w).toBeLessThanOrEqual(inner);
      const lines =
        blk.kind === 'flow' || blk.kind === 'box'
          ? blk.lines
          : blk.kind === 'table'
            ? blk.rows.flatMap((r) => r.cells.flat())
            : [];
      for (const l of lines) {
        const w = l.indent + (l.marker?.w ?? 0) + l.spans.reduce((n, s) => n + s.w, 0);
        expect(w).toBeLessThanOrEqual(inner);
      }
    }
    // 气泡高度 = meta 行 + 内容 + 上下 padding
    expect(b.h).toBe(acc + 20 + META_ROW_H);
    expect(b.y).toBe(24);
    expect(layout.height).toBeGreaterThan(b.h);
  });
});

describe('drawConversation', () => {
  /** 只记落到画布上的填充与文字（几何细节不值得断言，能画完才是这层的下限）。 */
  const fakeCtx = (): { ctx: CanvasRenderingContext2D; calls: string[] } => {
    const calls: string[] = [];
    const ctx = {
      fillStyle: '',
      strokeStyle: '',
      font: '',
      textBaseline: '',
      textAlign: '',
      lineWidth: 1,
      fillRect: () => calls.push('fill'),
      fillText: (t: string) => calls.push(`text:${t}`),
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      arcTo: () => {},
      closePath: () => {},
      fill: () => calls.push('fill'),
      stroke: () => {},
      save: () => {},
      restore: () => {},
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  };

  it('整张图画得完：每条气泡一层底色，meta 与正文都落笔', () => {
    const layout = layoutConversation(
      measure,
      [
        { role: 'user', at: AT, text: '我发的', viaWeave: true, tags: [{ kind: 'weave', text: 'weave' }] },
        { role: 'assistant', at: AT, text: '回复' },
      ],
      opts,
    );
    const { ctx, calls } = fakeCtx();
    expect(() => drawConversation(ctx, layout)).not.toThrow();
    expect(calls.filter((c) => c === 'fill').length).toBeGreaterThanOrEqual(layout.bubbles.length);
    expect(calls).toContain(`text:${`T(${AT})`}`);
    expect(calls).toContain('text:weave');
    expect(calls).toContain('text:我发的');
    expect(calls).toContain('text:回复');
  });
});

describe('imageFileName', () => {
  it('剥掉路径不友好字符', () => {
    const name = imageFileName('a/b:c*d', new Date(2026, 9, 16, 9, 8, 7));
    expect(name).toBe('weave-a-b-c-d-20261016-090807.png');
  });
});

describe('深浅主题', () => {
  const lightBlocks = (text: string): ConvImageBlock[] =>
    layoutConversation(measure, [{ role: 'assistant', at: AT, text }], { ...opts, theme: 'light' })
      .bubbles[0]!.blocks;

  it('布局记下主题（绘制按它取底色）', () => {
    expect(layoutConversation(measure, [], opts).theme).toBe('dark');
    expect(layoutConversation(measure, [], { ...opts, theme: 'light' }).theme).toBe('light');
  });

  it('代码块底色/描边跟着主题走', () => {
    const blk = lightBlocks('```\nx\n```')[0] as BoxBlock;
    expect(blk.fill).toBe(paletteFor('light').codeBg);
    expect(blk.border).toBe(paletteFor('light').codeBorder);
  });

  it('正文配色两套（两种角色共用同一套：面板里都是同一个 AssistantMarkdown）', () => {
    expect(paletteFor('light').fg).not.toBe(paletteFor('dark').fg);
  });
});
