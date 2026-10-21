/**
 * 对话导出成图片：canvas 卡片（零依赖）。排版与配色**照抄对话面板**——同一套气泡色
 * （回复中性灰、发送深蓝、终端手敲浅蓝、失败红）、同一套字色（正文/粗体/行内码/
 * 链接/引用全取 `AssistantMarkdown` 的 class），meta 行也在气泡内（时刻 + 消息 tag）。
 * 面板上的页面外壳（标题、项目名、分隔线）不是对话内容，不进图。
 *
 * 正文解析归 `conv-markdown.ts`，这里只管排版与绘制。排版是纯函数：量宽由调用方注入，
 * 每个 span 的宽度都算进布局，绘制阶段只按布局落笔。
 */

import { parseMarkdown, type MdSpan, type MdStyle } from './conv-markdown';
import type { Theme } from './theme';

export type ConvRole = 'user' | 'assistant';

/** 消息自身的 tag（与面板 meta 行那几枚一一对应：weave 来源 / 发送方名 / 计划）。 */
export type ConvImageTagKind = 'weave' | 'name' | 'plan';

export interface ConvImageTag {
  kind: ConvImageTagKind;
  text: string;
}

export interface ConvImageEntry {
  role: ConvRole;
  at: string;
  text: string;
  /** 气泡里的 tag（面板上有哪几枚就传哪几枚，顺序即绘制顺序）。 */
  tags?: ConvImageTag[];
  /** weave 投递的（深蓝气泡）；终端里手敲的 = 不带（浅蓝气泡）。 */
  viaWeave?: boolean;
  /** 这一轮以失败收尾（`lifecycle.closeFailed`）：红气泡红字，与面板同色。 */
  failed?: boolean;
}

/** 逻辑像素（画布按 scale 倍率放大）。 */
export const IMG_WIDTH = 880;
const PAD = 24;
const BUBBLE_PAD = 10;
const BUBBLE_GAP = 12;
const BUBBLE_MAX = Math.round((IMG_WIDTH - PAD * 2) * 0.78);
const TEXT_MAX = BUBBLE_MAX - BUBBLE_PAD * 2;

/** 行高/间距对齐窗口那套紧凑排版（正文 text-xs + leading-relaxed ≈ 19）。 */
const BODY_LH = 19;
const SMALL_LH = 16;
const H1_LH = 21;
const PARA_GAP = 4;
const BLOCK_GAP = 8;
const ITEM_GAP = 2;
const INDENT_PX = 16;
const CODE_PAD = 8;
const QUOTE_PAD = 6;
const QUOTE_BAR = 2;
const TABLE_PAD = 6;
const TABLE_MIN_COL = 44;

/** meta 行在气泡内：10px 文本行 + `mb-0.5`；tag 之间 `gap-x-1.5`。 */
const META_LH = 14;
const META_GAP = 2;
const TAG_GAP = 6;
/** 气泡内容区从 meta 行之后开始（绘制与断言都要这半个偏移）。 */
export const META_ROW_H = META_LH + META_GAP;

/** 画布总像素上限（iOS Safari 约 1670 万）：超了降倍率，不缩内容。 */
const MAX_CANVAS_PIXELS = 16_000_000;

export type ConvFont = 'meta' | 'body' | 'small' | 'strong' | 'em' | 'strongEm' | 'h1' | 'h3' | 'mono';

const SANS = 'ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei", monospace';

const FONTS: Record<ConvFont, string> = {
  meta: `10px ${SANS}`,
  body: `12px ${SANS}`,
  small: `11px ${SANS}`,
  strong: `600 12px ${SANS}`,
  em: `italic 12px ${SANS}`,
  strongEm: `600 italic 12px ${SANS}`,
  h1: `600 13px ${SANS}`,
  h3: `500 12px ${SANS}`,
  mono: `11px ${MONO}`,
};

export type Measure = (font: ConvFont, text: string) => number;

export interface ConvImageOpts {
  stamp: (iso: string) => string;
  /** 导出图跟随窗口当下的深浅模式（色值与 `tailwind.config.js` 的令牌表同源）。 */
  theme: Theme;
  scale?: number;
}

export interface Palette {
  fg: string;
  strong: string;
  code: string;
  codeBg: string;
  codeBorder: string;
  link: string;
  quote: string;
  quoteBar: string;
  tableBorder: string;
  tableHeadBg: string;
}

export type BubbleVariant = 'assistant' | 'user' | 'userTyped' | 'failed';

const BUBBLE_SKIN: Record<Theme, Record<BubbleVariant, { fill: string; stroke: string }>> = {
  dark: {
    // 回复：`bg-neutral-800/50` + `border-edge/[0.08]`
    assistant: { fill: 'rgba(38,38,38,0.5)', stroke: 'rgba(255,255,255,0.08)' },
    // weave 投递：`bg-blue-500/[0.12]` + `border-blue-500/30`
    user: { fill: 'rgba(59,130,246,0.12)', stroke: 'rgba(59,130,246,0.3)' },
    // 终端里手敲：同色再淡一档（`/[0.05]` + `/15`）
    userTyped: { fill: 'rgba(59,130,246,0.05)', stroke: 'rgba(59,130,246,0.15)' },
    // 失败：`bg-red-950/20` + `border-red-500/30`
    failed: { fill: 'rgba(69,10,10,0.2)', stroke: 'rgba(239,68,68,0.3)' },
  },
  light: {
    assistant: { fill: 'rgba(229,229,229,0.5)', stroke: 'rgba(0,0,0,0.08)' },
    user: { fill: 'rgba(59,130,246,0.12)', stroke: 'rgba(59,130,246,0.3)' },
    userTyped: { fill: 'rgba(59,130,246,0.05)', stroke: 'rgba(59,130,246,0.15)' },
    failed: { fill: 'rgba(254,242,242,0.2)', stroke: 'rgba(239,68,68,0.3)' },
  },
};

/** 画布底色 = 面板所在的内容面（`bg-neutral-950` 上叠 `bg-neutral-900/40`）。 */
const PAGE: Record<Theme, string> = { dark: '#0f0f0f', light: '#f8f8f8' };

/** 正文配色：与 `AssistantMarkdown` 的 class 逐条对齐（两种角色同一个组件 = 同一套字色）。 */
const TEXT: Record<Theme, Palette> = {
  dark: {
    fg: '#e5e5e5', // neutral-200
    strong: '#f5f5f5', // neutral-100
    code: '#d4d4d4', // neutral-300
    codeBg: 'rgba(10,10,10,0.6)', // neutral-950/60
    codeBorder: 'rgba(255,255,255,0.06)', // edge/[0.06]
    link: '#60a5fa', // blue-400
    quote: '#a3a3a3', // neutral-400
    quoteBar: '#404040', // neutral-700
    tableBorder: 'rgba(255,255,255,0.08)',
    tableHeadBg: 'rgba(10,10,10,0.4)', // neutral-950/40
  },
  light: {
    fg: '#171717',
    strong: '#0a0a0a',
    code: '#262626',
    codeBg: 'rgba(250,250,250,0.6)',
    codeBorder: 'rgba(0,0,0,0.06)',
    link: '#1d4ed8',
    quote: '#404040',
    quoteBar: '#d4d4d4',
    tableBorder: 'rgba(0,0,0,0.08)',
    tableHeadBg: 'rgba(250,250,250,0.4)',
  },
};

/** meta 行：时刻（neutral-600）与三类 tag（weave = 蓝底、名字 = 描边、计划 = 琥珀底）。 */
const META_INK: Record<
  Theme,
  {
    time: string;
    weaveFg: string;
    weaveBg: string;
    nameFg: string;
    nameBorder: string;
    planFg: string;
    planBg: string;
    failed: string;
  }
> = {
  dark: {
    time: '#525252',
    weaveFg: '#93c5fd',
    weaveBg: 'rgba(59,130,246,0.15)',
    nameFg: '#a3a3a3',
    nameBorder: 'rgba(255,255,255,0.12)',
    planFg: '#fcd34d',
    planBg: 'rgba(245,158,11,0.15)',
    failed: '#fca5a5', // red-300
  },
  light: {
    time: '#666666',
    weaveFg: '#1e40af',
    weaveBg: 'rgba(59,130,246,0.15)',
    nameFg: '#404040',
    nameBorder: 'rgba(0,0,0,0.12)',
    planFg: '#92400e',
    planBg: 'rgba(245,158,11,0.15)',
    failed: '#991b1b',
  },
};

/** 某主题下的正文配色（排版与绘制都从这里取；测试也用它，免得手抄一份 Palette）。 */
export function paletteFor(theme: Theme): Palette {
  return TEXT[theme];
}

export interface ConvImageSpan {
  text: string;
  font: ConvFont;
  fg: string;
  /** 已量好的宽度（绘制不再碰 measure）。 */
  w: number;
  bg?: string;
  border?: string;
  underline?: boolean;
  strike?: boolean;
}

export interface ConvImageLine {
  spans: ConvImageSpan[];
  /** 该行左缩进（列表层级 / 代码块内边距）。 */
  indent: number;
  /** 行首记号（列表项第一行；正文起点 = indent + marker.w）。 */
  marker?: { text: string; font: ConvFont; fg: string; w: number };
  lh: number;
  /** 该行之前额外留的空（列表项之间）。 */
  gap: number;
}

interface BlockBase {
  y: number;
  gap: number;
  h: number;
  w: number;
}

export interface FlowBlock extends BlockBase {
  kind: 'flow';
  lines: ConvImageLine[];
}

export interface BoxBlock extends BlockBase {
  kind: 'box';
  fill?: string;
  border?: string;
  leftBar?: string;
  /** 内容相对块顶的内边距（代码块 = 内衬、引用 = 上下留白的一半）。 */
  pad: number;
  lines: ConvImageLine[];
}

export interface TableBlock extends BlockBase {
  kind: 'table';
  colW: number[];
  rows: { head: boolean; h: number; cells: ConvImageLine[][] }[];
}

export interface RuleBlock extends BlockBase {
  kind: 'rule';
}

export type ConvImageBlock = FlowBlock | BoxBlock | TableBlock | RuleBlock;

/** 排版阶段的块：位置与间距由 `add` 统一填。 */
type BlockDraft = {
  [K in ConvImageBlock['kind']]: Omit<Extract<ConvImageBlock, { kind: K }>, 'y' | 'gap'>;
}[ConvImageBlock['kind']];

/** meta 行：发送侧 tag 靠左、时刻贴右（两侧各一组，宽度已量好）。 */
export interface ConvImageMeta {
  left: ConvImageSpan[];
  right: ConvImageSpan[];
  w: number;
}

export interface ConvImageBubble {
  role: ConvRole;
  variant: BubbleVariant;
  meta: ConvImageMeta;
  x: number;
  y: number;
  w: number;
  h: number;
  blocks: ConvImageBlock[];
}

export interface ConvImageLayout {
  width: number;
  height: number;
  scale: number;
  theme: Theme;
  bubbles: ConvImageBubble[];
}

/** 行内样式 → 字体与色（对齐窗口里 `AssistantMarkdown` 的那套 class）。 */
function styleOf(style: MdStyle, pal: Palette, base?: ConvFont): Omit<ConvImageSpan, 'text' | 'w'> {
  switch (style) {
    case 'strong':
      return { font: base ?? 'strong', fg: pal.strong };
    case 'em':
      return { font: base ? base : 'em', fg: pal.fg };
    case 'strongEm':
      return { font: base ?? 'strongEm', fg: pal.strong };
    case 'code':
      return { font: 'mono', fg: pal.code, bg: pal.codeBg };
    case 'link':
      return { font: base ?? 'body', fg: pal.link, underline: true };
    case 'del':
      return { font: base ?? 'body', fg: pal.fg, strike: true };
    default:
      return { font: base ?? 'body', fg: pal.fg };
  }
}

/** 拉丁串整体不折（URL/路径断在半截更难看），中日韩任意处可折。 */
const TOKEN = /[A-Za-z0-9@._/:%+~=?#&$'"-]+|\s+|[\s\S]/g;

function sameStyle(a: ConvImageSpan, b: Omit<ConvImageSpan, 'text' | 'w'>): boolean {
  return (
    a.font === b.font &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.border === b.border &&
    a.underline === b.underline &&
    a.strike === b.strike
  );
}

export interface WrapOpts {
  /** 正文基础字体（标题/表格各换一档）。 */
  base?: ConvFont;
  /** 保留行首空白（代码块要）。 */
  keepSpace?: boolean;
}

/** 行内 span → 折好的行（同款式片段合并、行尾空白吃掉）。 */
export function wrapSpans(
  measure: Measure,
  spans: readonly MdSpan[],
  pal: Palette,
  maxWidth: number,
  lh: number,
  opts: WrapOpts = {},
): ConvImageLine[] {
  const lines: ConvImageLine[] = [];
  let cur: ConvImageSpan[] = [];
  let curW = 0;
  const emit = (): void => {
    const last = cur[cur.length - 1];
    if (last) {
      const trimmed = last.text.replace(/\s+$/, '');
      if (trimmed === '') cur.pop();
      else if (trimmed !== last.text) {
        last.w -= measure(last.font, last.text.slice(trimmed.length));
        last.text = trimmed;
      }
    }
    lines.push({ spans: cur, indent: 0, lh, gap: 0 });
    cur = [];
    curW = 0;
  };
  const put = (text: string, st: Omit<ConvImageSpan, 'text' | 'w'>, w: number): void => {
    const last = cur[cur.length - 1];
    if (last && sameStyle(last, st)) {
      last.text += text;
      last.w += w;
      return;
    }
    cur.push({ ...st, text, w });
  };
  for (const s of spans) {
    const st = styleOf(s.style, pal, opts.base);
    for (const tk of s.text.match(TOKEN) ?? []) {
      const space = /^\s+$/.test(tk);
      if (space && cur.length === 0 && !opts.keepSpace) continue;
      const w = measure(st.font, tk);
      if (cur.length > 0 && curW + w > maxWidth) {
        emit();
        if (space && !opts.keepSpace) continue;
      }
      if (cur.length === 0 && w > maxWidth) {
        // 没空格的长串（URL）逐字硬断，不让它撑出气泡
        for (const ch of tk) {
          const cw = measure(st.font, ch);
          if (cur.length > 0 && curW + cw > maxWidth) emit();
          put(ch, st, cw);
          curW += cw;
        }
        continue;
      }
      put(tk, st, w);
      curW += w;
    }
  }
  if (cur.length > 0 || lines.length === 0) emit();
  return lines;
}

function lineWidth(line: ConvImageLine): number {
  return line.indent + (line.marker?.w ?? 0) + line.spans.reduce((n, s) => n + s.w, 0);
}

function linesHeight(lines: readonly ConvImageLine[]): number {
  return lines.reduce((n, l) => n + l.gap + l.lh, 0);
}

/** 块与块之间：代码块/引用/表格/标题/分隔线松一档，段落与列表紧一档。 */
function gapFor(kind: BlockDraft['kind']): number {
  return kind === 'flow' ? PARA_GAP : BLOCK_GAP;
}

/** meta 行：时刻 + tag（不折行——tag 都是短语，宽度并进气泡的内宽）。 */
function metaRow(
  measure: Measure,
  theme: Theme,
  at: string,
  tags: readonly ConvImageTag[],
  role: ConvRole,
  opts: ConvImageOpts,
): ConvImageMeta {
  const ink = META_INK[theme];
  const stampSpan: ConvImageSpan = {
    text: opts.stamp(at),
    font: 'meta',
    fg: ink.time,
    w: measure('meta', opts.stamp(at)),
  };
  const tagSpans: ConvImageSpan[] = [];
  for (const [i, tag] of tags.entries()) {
    if (i > 0) tagSpans.push({ text: '', font: 'meta', fg: ink.time, w: TAG_GAP });
    const w = measure('meta', tag.text);
    tagSpans.push(
      tag.kind === 'weave'
        ? { text: tag.text, font: 'meta', fg: ink.weaveFg, bg: ink.weaveBg, w }
        : tag.kind === 'plan'
          ? { text: tag.text, font: 'meta', fg: ink.planFg, bg: ink.planBg, w }
          : { text: tag.text, font: 'meta', fg: ink.nameFg, border: ink.nameBorder, w },
    );
  }
  const gapSpan: ConvImageSpan = { text: '', font: 'meta', fg: ink.time, w: TAG_GAP };
  // 发送侧（右）：tag 靠左、时刻贴右（`ml-auto`）；回复侧（左）：时刻在前、tag 随后
  const left =
    role === 'user'
      ? tagSpans
      : [stampSpan, ...(tagSpans.length > 0 ? [gapSpan, ...tagSpans] : [])];
  const right = role === 'user' ? [stampSpan] : [];
  const w =
    left.reduce((n, s) => n + s.w, 0) +
    (right.length ? TAG_GAP + right.reduce((n, s) => n + s.w, 0) : 0);
  return { left, right, w };
}

/** markdown 块 → 带位置的块（y 相对气泡内容区；宽度已按 TEXT_MAX 量过）。 */
function layoutBlocks(measure: Measure, text: string, pal: Palette): ConvImageBlock[] {
  const out: ConvImageBlock[] = [];
  let y = 0;
  const add = (draft: BlockDraft): void => {
    const gap = out.length === 0 ? 0 : gapFor(draft.kind);
    out.push({ ...draft, y, gap });
    y += gap + draft.h;
  };
  const flow = (lines: ConvImageLine[]): BlockDraft => ({
    kind: 'flow',
    h: linesHeight(lines),
    w: Math.max(0, ...lines.map(lineWidth)),
    lines,
  });
  for (const b of parseMarkdown(text)) {
    switch (b.kind) {
      case 'hr':
        add({ kind: 'rule', h: 1, w: TEXT_MAX });
        break;
      case 'h': {
        const base: ConvFont = b.level === 1 ? 'h1' : b.level === 2 ? 'strong' : 'h3';
        add(flow(wrapSpans(measure, b.spans, pal, TEXT_MAX, base === 'h1' ? H1_LH : BODY_LH, { base })));
        break;
      }
      case 'p':
        add(flow(wrapSpans(measure, b.spans, pal, TEXT_MAX, BODY_LH)));
        break;
      case 'list': {
        const lines: ConvImageLine[] = [];
        for (const item of b.items) {
          const marker = `${item.marker} `;
          const markerW = measure('body', marker);
          const left = item.level * INDENT_PX;
          const wrapped = wrapSpans(measure, item.spans, pal, TEXT_MAX - left - markerW, BODY_LH);
          wrapped.forEach((l, i) => {
            l.indent = i === 0 ? left : left + markerW;
            l.gap = i === 0 && lines.length > 0 ? ITEM_GAP : 0;
            if (i === 0) l.marker = { text: marker, font: 'body', fg: pal.fg, w: markerW };
            lines.push(l);
          });
        }
        add(flow(lines));
        break;
      }
      case 'quote': {
        const qpal: Palette = { ...pal, fg: pal.quote, strong: pal.quote };
        const lines: ConvImageLine[] = [];
        for (const [i, spans] of b.lines.entries()) {
          const wrapped = wrapSpans(measure, spans, qpal, TEXT_MAX - QUOTE_PAD - QUOTE_BAR, BODY_LH);
          wrapped.forEach((l, j) => {
            l.indent = QUOTE_PAD + QUOTE_BAR;
            l.gap = i > 0 && j === 0 ? ITEM_GAP : 0;
            lines.push(l);
          });
        }
        add({
          kind: 'box',
          h: linesHeight(lines) + QUOTE_PAD,
          w: Math.max(0, ...lines.map(lineWidth)),
          leftBar: pal.quoteBar,
          pad: QUOTE_PAD / 2,
          lines,
        });
        break;
      }
      case 'code': {
        const cpal: Palette = { ...pal, fg: pal.code };
        const lines: ConvImageLine[] = [];
        for (const line of b.lines.length > 0 ? b.lines : ['']) {
          const wrapped = wrapSpans(
            measure,
            [{ text: line, style: 'plain' }],
            cpal,
            TEXT_MAX - CODE_PAD * 2,
            SMALL_LH,
            { base: 'mono', keepSpace: true },
          );
          for (const l of wrapped) {
            l.indent = CODE_PAD;
            lines.push(l);
          }
        }
        add({
          kind: 'box',
          h: linesHeight(lines) + CODE_PAD * 2,
          w: Math.max(0, ...lines.map((l) => l.spans.reduce((n, s) => n + s.w, 0))) + CODE_PAD * 2,
          fill: pal.codeBg,
          border: pal.codeBorder,
          pad: CODE_PAD,
          lines,
        });
        break;
      }
      case 'table': {
        const rows = b.rows;
        if (rows.length === 0) break;
        const cols = Math.max(...rows.map((r) => r.length));
        const natural = Array.from({ length: cols }, (_, c) => {
          let w = 0;
          for (const row of rows) {
            const cell = row[c];
            if (!cell) continue;
            const one = wrapSpans(measure, cell, pal, Number.MAX_SAFE_INTEGER, SMALL_LH, {
              base: 'small',
            })[0];
            w = Math.max(w, one ? one.spans.reduce((n, s) => n + s.w, 0) : 0);
          }
          return w + TABLE_PAD * 2;
        });
        const total = natural.reduce((n, w) => n + w, 0);
        const shrink = total > TEXT_MAX ? TEXT_MAX / total : 1;
        const colW = natural.map((w) => Math.max(TABLE_MIN_COL, w * shrink));
        const cells = rows.map((row, ri) => {
          const cellLines = colW.map((w, c) =>
            wrapSpans(measure, row[c] ?? [], pal, Math.max(10, w - TABLE_PAD * 2), SMALL_LH, {
              base: 'small',
            }),
          );
          const h = Math.max(...cellLines.map((c) => c.length)) * SMALL_LH + TABLE_PAD * 2;
          return { head: ri === 0, h, cells: cellLines };
        });
        add({
          kind: 'table',
          h: cells.reduce((n, r) => n + r.h, 0),
          w: colW.reduce((n, w) => n + w, 0),
          colW,
          rows: cells,
        });
        break;
      }
    }
  }
  return out;
}

/** 倍率：默认 2 倍（高分屏清晰），画布总像素顶到上限就降 1 倍。 */
export function pickScale(width: number, height: number, preferred = 2): number {
  for (const s of [preferred, 1]) {
    if (width * s * height * s <= MAX_CANVAS_PIXELS) return s;
  }
  return 1;
}

export function variantOf(e: ConvImageEntry): BubbleVariant {
  if (e.failed === true) return 'failed';
  if (e.role === 'assistant') return 'assistant';
  return e.viaWeave === true ? 'user' : 'userTyped';
}

export function layoutConversation(
  measure: Measure,
  entries: readonly ConvImageEntry[],
  opts: ConvImageOpts,
): ConvImageLayout {
  const pal = TEXT[opts.theme];
  let y = PAD;
  const bubbles: ConvImageBubble[] = [];
  for (const e of entries) {
    const blocks = layoutBlocks(measure, e.text, pal);
    const meta = metaRow(measure, opts.theme, e.at, e.tags ?? [], e.role, opts);
    const contentW = Math.max(meta.w, 0, ...blocks.map((b) => b.w));
    const contentH = blocks.reduce((n, b) => n + b.gap + b.h, 0);
    const w = Math.min(BUBBLE_MAX, contentW + BUBBLE_PAD * 2);
    bubbles.push({
      role: e.role,
      variant: variantOf(e),
      meta,
      x: e.role === 'user' ? IMG_WIDTH - PAD - w : PAD,
      y,
      w,
      h: META_ROW_H + contentH + BUBBLE_PAD * 2,
      blocks,
    });
    y += META_ROW_H + contentH + BUBBLE_PAD * 2 + BUBBLE_GAP;
  }
  const height = Math.round(entries.length > 0 ? y - BUBBLE_GAP + PAD : y);
  return {
    width: IMG_WIDTH,
    height,
    scale: pickScale(IMG_WIDTH, height, opts.scale),
    theme: opts.theme,
    bubbles,
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSpan(
  ctx: CanvasRenderingContext2D,
  s: ConvImageSpan,
  x: number,
  y: number,
  lh: number,
): void {
  ctx.font = FONTS[s.font];
  if (s.bg || s.border) {
    roundRect(ctx, x - 2, y - 1, s.w + 4, lh - 4, 3);
    if (s.bg) {
      ctx.fillStyle = s.bg;
      ctx.fill();
    }
    if (s.border) {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = s.border;
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.fillStyle = s.fg;
  ctx.fillText(s.text, x, y);
  if (s.underline || s.strike) {
    ctx.strokeStyle = s.fg;
    ctx.beginPath();
    const ly = s.underline ? y + lh - 4 : y + lh / 2 + 1;
    ctx.moveTo(x, ly);
    ctx.lineTo(x + s.w, ly);
    ctx.stroke();
  }
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: readonly ConvImageLine[],
  x0: number,
  y0: number,
): void {
  let y = y0;
  for (const line of lines) {
    y += line.gap;
    if (line.marker) {
      ctx.font = FONTS[line.marker.font];
      ctx.fillStyle = line.marker.fg;
      ctx.fillText(line.marker.text, x0 + line.indent, y);
    }
    let x = x0 + line.indent + (line.marker?.w ?? 0);
    for (const s of line.spans) {
      drawSpan(ctx, s, x, y, line.lh);
      x += s.w;
    }
    y += line.lh;
  }
}

export function drawConversation(ctx: CanvasRenderingContext2D, layout: ConvImageLayout): void {
  const pal = TEXT[layout.theme];
  ctx.fillStyle = PAGE[layout.theme];
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
  for (const b of layout.bubbles) {
    const skin = BUBBLE_SKIN[layout.theme][b.variant];
    roundRect(ctx, b.x, b.y, b.w, b.h, 8);
    ctx.fillStyle = skin.fill;
    ctx.fill();
    ctx.strokeStyle = skin.stroke;
    ctx.stroke();
    const x0 = b.x + BUBBLE_PAD;
    const innerW = b.w - BUBBLE_PAD * 2;
    let mx = x0;
    for (const s of b.meta.left) {
      drawSpan(ctx, s, mx, b.y + BUBBLE_PAD, META_LH);
      mx += s.w;
    }
    mx = x0 + innerW - b.meta.right.reduce((n, s) => n + s.w, 0);
    for (const s of b.meta.right) {
      drawSpan(ctx, s, mx, b.y + BUBBLE_PAD, META_LH);
      mx += s.w;
    }
    const y0 = b.y + BUBBLE_PAD + META_ROW_H;
    for (const blk of b.blocks) {
      const by = y0 + blk.y;
      if (blk.kind === 'rule') {
        ctx.strokeStyle = pal.tableBorder;
        ctx.beginPath();
        ctx.moveTo(x0, by + 0.5);
        ctx.lineTo(x0 + innerW, by + 0.5);
        ctx.stroke();
        continue;
      }
      if (blk.kind === 'flow') {
        drawLines(ctx, blk.lines, x0, by);
        continue;
      }
      if (blk.kind === 'box') {
        if (blk.fill || blk.border) {
          roundRect(ctx, x0, by, blk.w, blk.h, 4);
          if (blk.fill) {
            ctx.fillStyle = blk.fill;
            ctx.fill();
          }
          if (blk.border) {
            ctx.strokeStyle = blk.border;
            ctx.stroke();
          }
        }
        if (blk.leftBar) {
          ctx.fillStyle = blk.leftBar;
          ctx.fillRect(x0, by, QUOTE_BAR, blk.h);
        }
        drawLines(ctx, blk.lines, x0, by + blk.pad);
        continue;
      }
      let ry = by;
      for (const row of blk.rows) {
        if (row.head) {
          ctx.fillStyle = pal.tableHeadBg;
          ctx.fillRect(x0, ry, blk.w, row.h);
        }
        let cellX = x0;
        row.cells.forEach((lines, i) => {
          lines.forEach((l, k) =>
            drawLines(ctx, [{ ...l, indent: TABLE_PAD, gap: 0 }], cellX, ry + TABLE_PAD + k * SMALL_LH),
          );
          cellX += blk.colW[i] ?? 0;
        });
        ctx.strokeStyle = pal.tableBorder;
        ctx.beginPath();
        ctx.moveTo(x0, ry + 0.5);
        ctx.lineTo(x0 + blk.w, ry + 0.5);
        ctx.moveTo(x0, ry + row.h + 0.5);
        ctx.lineTo(x0 + blk.w, ry + row.h + 0.5);
        ctx.stroke();
        ry += row.h;
      }
      let cx = x0;
      ctx.strokeStyle = pal.tableBorder;
      for (const cw of blk.colW) {
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, by);
        ctx.lineTo(cx + 0.5, by + blk.h);
        ctx.stroke();
        cx += cw;
      }
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, by);
      ctx.lineTo(cx + 0.5, by + blk.h);
      ctx.stroke();
    }
  }
}

export async function renderConversationImage(
  entries: readonly ConvImageEntry[],
  opts: ConvImageOpts,
): Promise<Blob> {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) throw new Error('canvas 2d context unavailable');
  const measure: Measure = (font, text) => {
    probe.font = FONTS[font];
    return probe.measureText(text).width;
  };
  const layout = layoutConversation(measure, entries, opts);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(layout.width * layout.scale);
  canvas.height = Math.round(layout.height * layout.scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.scale(layout.scale, layout.scale);
  drawConversation(ctx, layout);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('image encoding failed');
  return blob;
}

export function imageFileName(label: string, at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const safe = label.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const ts =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `weave-${safe || 'conversation'}-${ts}.png`;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // 立即 revoke 会让 Safari 拿不到数据，留一拍再释放
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
