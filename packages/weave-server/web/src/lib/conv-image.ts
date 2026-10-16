/**
 * 对话导出成图片：canvas 卡片（零依赖）。正文按窗口里那套 markdown 预览的样子排
 * （解析归 `conv-markdown.ts`，这里只管排版与绘制）——同一种字号/行高/配色：正文无衬线、
 * 代码等宽、标题略大、列表带记号、代码块与引用各自成块、表格画格线。
 *
 * 排版是纯函数：量宽由调用方注入，每个 span 的宽度都算进布局，绘制阶段只按布局落笔。
 */

import { parseMarkdown, type MdSpan, type MdStyle } from './conv-markdown';

export type ConvRole = 'user' | 'assistant';

export interface ConvImageEntry {
  role: ConvRole;
  at: string;
  text: string;
}

/** 逻辑像素（画布按 scale 倍率放大）。 */
export const IMG_WIDTH = 880;
const PAD = 24;
const TITLE_H = 26;
const META_H = 15;
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

/** 画布总像素上限（iOS Safari 约 1670 万）：超了降倍率，不缩内容。 */
const MAX_CANVAS_PIXELS = 16_000_000;

export type ConvFont =
  | 'title'
  | 'meta'
  | 'body'
  | 'small'
  | 'strong'
  | 'em'
  | 'strongEm'
  | 'h1'
  | 'h3'
  | 'mono';

const SANS = 'ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei", monospace';

const FONTS: Record<ConvFont, string> = {
  title: `600 17px ${SANS}`,
  meta: `11px ${SANS}`,
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
  title: string;
  subtitle: string;
  labels: { user: string; assistant: string };
  stamp: (iso: string) => string;
  scale?: number;
}

interface Palette {
  fill: string;
  stroke: string;
  fg: string;
  strong: string;
  code: string;
  link: string;
  quote: string;
}

const META_FG = '#737373';
const TITLE_FG = '#f5f5f5';
const CODE_BG = 'rgba(0,0,0,0.45)';
const CODE_BORDER = 'rgba(255,255,255,0.06)';
const TABLE_BORDER = 'rgba(255,255,255,0.08)';
const TABLE_HEAD_BG = 'rgba(0,0,0,0.35)';
const QUOTE_BAR_FG = '#404040';
const RULE_FG = 'rgba(255,255,255,0.08)';

const BUBBLE: Record<ConvRole, Palette> = {
  user: {
    fill: 'rgba(59,130,246,0.14)',
    stroke: 'rgba(59,130,246,0.35)',
    fg: '#dbeafe',
    strong: '#eff6ff',
    code: '#bfdbfe',
    link: '#93c5fd',
    quote: 'rgba(219,234,254,0.75)',
  },
  assistant: {
    fill: 'rgba(255,255,255,0.06)',
    stroke: 'rgba(255,255,255,0.10)',
    fg: '#e5e5e5',
    strong: '#fafafa',
    code: '#d4d4d4',
    link: '#60a5fa',
    quote: '#a3a3a3',
  },
};

export interface ConvImageSpan {
  text: string;
  font: ConvFont;
  fg: string;
  /** 已量好的宽度（绘制不再碰 measure）。 */
  w: number;
  bg?: string;
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

export interface ConvImageBubble {
  role: ConvRole;
  meta: string;
  metaY: number;
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
  header: { y: number; h: number; title: string; subtitle: string };
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
      return { font: 'mono', fg: pal.code, bg: CODE_BG };
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
          leftBar: QUOTE_BAR_FG,
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
          fill: CODE_BG,
          border: CODE_BORDER,
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

export function layoutConversation(
  measure: Measure,
  entries: readonly ConvImageEntry[],
  opts: ConvImageOpts,
): ConvImageLayout {
  const headerH = TITLE_H + META_H + 8;
  const header = { y: PAD, h: headerH, title: opts.title, subtitle: opts.subtitle };
  let y = PAD + headerH + BUBBLE_GAP;
  const bubbles: ConvImageBubble[] = [];
  for (const e of entries) {
    const blocks = layoutBlocks(measure, e.text, BUBBLE[e.role]);
    const contentW = Math.max(0, ...blocks.map((b) => b.w));
    const contentH = blocks.reduce((n, b) => n + b.gap + b.h, 0);
    const w = Math.min(BUBBLE_MAX, contentW + BUBBLE_PAD * 2);
    const h = META_H + contentH + BUBBLE_PAD * 2;
    bubbles.push({
      role: e.role,
      meta: `${opts.stamp(e.at)} · ${e.role === 'user' ? opts.labels.user : opts.labels.assistant}`,
      metaY: y,
      x: e.role === 'user' ? IMG_WIDTH - PAD - w : PAD,
      y: y + META_H,
      w,
      h,
      blocks,
    });
    y += META_H + h + BUBBLE_GAP;
  }
  const height = Math.round(entries.length > 0 ? y - BUBBLE_GAP + PAD : y);
  return { width: IMG_WIDTH, height, scale: pickScale(IMG_WIDTH, height, opts.scale), header, bubbles };
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
      ctx.font = FONTS[s.font];
      if (s.bg) {
        ctx.fillStyle = s.bg;
        roundRect(ctx, x - 2, y - 1, s.w + 4, line.lh - 4, 3);
        ctx.fill();
      }
      ctx.fillStyle = s.fg;
      ctx.fillText(s.text, x, y);
      if (s.underline || s.strike) {
        ctx.strokeStyle = s.fg;
        ctx.beginPath();
        const ly = s.underline ? y + line.lh - 4 : y + line.lh / 2 + 1;
        ctx.moveTo(x, ly);
        ctx.lineTo(x + s.w, ly);
        ctx.stroke();
      }
      x += s.w;
    }
    y += line.lh;
  }
}

export function drawConversation(ctx: CanvasRenderingContext2D, layout: ConvImageLayout): void {
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
  const { y, h, title, subtitle } = layout.header;
  ctx.font = FONTS.title;
  ctx.fillStyle = TITLE_FG;
  ctx.fillText(title, PAD, y);
  ctx.font = FONTS.meta;
  ctx.fillStyle = META_FG;
  ctx.fillText(subtitle, PAD, y + TITLE_H);
  ctx.strokeStyle = RULE_FG;
  ctx.beginPath();
  ctx.moveTo(PAD, y + h + 0.5);
  ctx.lineTo(layout.width - PAD, y + h + 0.5);
  ctx.stroke();
  for (const b of layout.bubbles) {
    const pal = BUBBLE[b.role];
    ctx.font = FONTS.meta;
    ctx.fillStyle = META_FG;
    ctx.textAlign = b.role === 'user' ? 'right' : 'left';
    ctx.fillText(b.meta, b.role === 'user' ? b.x + b.w : b.x, b.metaY);
    ctx.textAlign = 'left';
    roundRect(ctx, b.x, b.y, b.w, b.h, 8);
    ctx.fillStyle = pal.fill;
    ctx.fill();
    ctx.strokeStyle = pal.stroke;
    ctx.stroke();
    const x0 = b.x + BUBBLE_PAD;
    const y0 = b.y + BUBBLE_PAD;
    for (const blk of b.blocks) {
      const by = y0 + blk.y;
      if (blk.kind === 'rule') {
        ctx.strokeStyle = RULE_FG;
        ctx.beginPath();
        ctx.moveTo(x0, by + 0.5);
        ctx.lineTo(x0 + b.w - BUBBLE_PAD * 2, by + 0.5);
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
          ctx.fillStyle = TABLE_HEAD_BG;
          ctx.fillRect(x0, ry, blk.w, row.h);
        }
        let cellX = x0;
        row.cells.forEach((lines, i) => {
          lines.forEach((l, k) =>
            drawLines(ctx, [{ ...l, indent: TABLE_PAD, gap: 0 }], cellX, ry + TABLE_PAD + k * SMALL_LH),
          );
          cellX += blk.colW[i] ?? 0;
        });
        ctx.strokeStyle = TABLE_BORDER;
        ctx.beginPath();
        ctx.moveTo(x0, ry + 0.5);
        ctx.lineTo(x0 + blk.w, ry + 0.5);
        ctx.moveTo(x0, ry + row.h + 0.5);
        ctx.lineTo(x0 + blk.w, ry + row.h + 0.5);
        ctx.stroke();
        ry += row.h;
      }
      let cx = x0;
      ctx.strokeStyle = TABLE_BORDER;
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
