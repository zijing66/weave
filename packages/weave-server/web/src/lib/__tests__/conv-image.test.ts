import { describe, it, expect } from 'vitest';
import {
  IMG_WIDTH,
  imageFileName,
  layoutConversation,
  paletteFor,
  pickScale,
  wrapSpans,
  type BoxBlock,
  type ConvImageBlock,
  type ConvImageEntry,
  type FlowBlock,
  type Measure,
  type TableBlock,
} from '../conv-image';

/** 假量宽：中日韩字宽 13、其余 7（只为验证折行与排版规则，不追求真字宽）。 */
const width = (text: string): number =>
  [...text].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 13 : 7), 0);

const measure: Measure = (_font, text) => width(text);

const opts = {
  title: '会话 A',
  subtitle: 'proj · 导出',
  labels: { user: '我', assistant: '会话', plan: '计划' },
  stamp: (iso: string) => `T(${iso})`,
  theme: 'dark' as const,
};

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
  const pal = paletteFor('dark', 'assistant');

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

  it('时刻戳带角色文案；高度随条目与换行增长', () => {
    const one = layoutConversation(measure, entries.slice(0, 1), opts);
    const two = layoutConversation(measure, entries, opts);
    expect(two.height).toBeGreaterThan(one.height);
    expect(two.bubbles[0]!.meta).toContain('我');
    expect(two.bubbles[1]!.meta).toContain('会话');
    expect(two.bubbles[1]!.meta).toContain('2026-10-16T09:00:05.000Z');
    const plan = layoutConversation(measure, [{ role: 'assistant', at: AT, text: '计划正文', plan: true }], opts);
    expect(plan.bubbles[0]!.meta).toContain('计划');
    const taller = layoutConversation(measure, [{ ...entries[0]!, text: entries[0]!.text.repeat(20) }], opts);
    expect(taller.height).toBeGreaterThan(one.height);
    expect(taller.bubbles[0]!.w).toBeLessThanOrEqual(IMG_WIDTH - 48);
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

  it('气泡下方不留空行（文末换行不算块，meta 行不计入气泡高度）', () => {
    const b = layoutConversation(measure, [{ role: 'assistant', at: AT, text: '答案一行\n' }], opts).bubbles[0]!;
    expect(b.blocks.length).toBe(1);
    expect((b.blocks[0] as FlowBlock).lines.length).toBe(1);
    expect(b.h).toBe(19 + 20);
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
    // 气泡高度 = 内容 + 上下 padding（meta 行画在气泡上方，不算进去）
    expect(b.h).toBe(acc + 20);
    expect(b.y).toBe(b.metaY + 15);
    expect(layout.height).toBeGreaterThan(b.h);
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
    expect(blk.fill).toBe(paletteFor('light', 'assistant').codeBg);
    expect(blk.border).toBe(paletteFor('light', 'assistant').codeBorder);
  });

  it('两种角色都有两套配色（缺一边就会画成同色一片）', () => {
    for (const role of ['user', 'assistant'] as const) {
      expect(paletteFor('light', role).fg).not.toBe(paletteFor('dark', role).fg);
    }
  });
});
