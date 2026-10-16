/**
 * 对话导出成图片：canvas 纯文本卡片（零依赖）。正文按纯文本画，markdown 记号
 * 照原样出现——图片是「看得见的时刻戳 + 角色」，不是渲染器。
 * 排版与绘制分开：排版是纯函数（量宽由调用方注入），绘制才碰 canvas。
 */

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
const LINE_H = 19;
const BUBBLE_PAD = 10;
const BUBBLE_GAP = 12;
const BUBBLE_MAX = Math.round((IMG_WIDTH - PAD * 2) * 0.78);
const TEXT_MAX = BUBBLE_MAX - BUBBLE_PAD * 2;

/** 画布总像素上限（iOS Safari 约 1670 万）：超了降倍率，不缩内容。 */
const MAX_CANVAS_PIXELS = 16_000_000;

export type ConvFont = 'title' | 'meta' | 'body';

const FONTS: Record<ConvFont, string> = {
  title: '600 17px ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
  meta: '11px ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
  body: '13px ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei", monospace',
};

export type Measure = (font: ConvFont, text: string) => number;

export interface ConvImageOpts {
  title: string;
  subtitle: string;
  labels: { user: string; assistant: string };
  stamp: (iso: string) => string;
  scale?: number;
}

export interface ConvImageBubble {
  role: ConvRole;
  meta: string;
  metaY: number;
  lines: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ConvImageLayout {
  width: number;
  height: number;
  scale: number;
  header: { y: number; h: number; title: string; subtitle: string };
  bubbles: ConvImageBubble[];
}

/** 拉丁串整体不折（URL/路径这类断在半截更难看），中日韩任意处可折。 */
const TOKEN = /[A-Za-z0-9@._/:%+~=?#&$'"`-]+|\s+|[\s\S]/g;

export function wrapText(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '    ');
    if (line === '') {
      out.push('');
      continue;
    }
    let cur = '';
    for (const tk of line.match(TOKEN) ?? []) {
      const space = /^\s+$/.test(tk);
      if (cur === '' && space) continue;
      if (cur !== '' && measure(cur + tk) > maxWidth) {
        out.push(cur.trimEnd());
        cur = space ? '' : tk;
        continue;
      }
      if (cur === '' && measure(tk) > maxWidth) {
        // 单个超长串（没空格的长 URL）逐字硬断，不让它溢出气泡
        for (const ch of tk) {
          if (cur !== '' && measure(cur + ch) > maxWidth) {
            out.push(cur);
            cur = ch;
          } else cur += ch;
        }
        continue;
      }
      cur += tk;
    }
    out.push(cur.trimEnd());
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
  const bodyWidth = (t: string): number => measure('body', t);
  const headerH = TITLE_H + META_H + 8;
  const header = { y: PAD, h: headerH, title: opts.title, subtitle: opts.subtitle };
  let y = PAD + headerH;
  const bubbles: ConvImageBubble[] = [];
  for (const e of entries) {
    const lines = wrapText(bodyWidth, e.text, TEXT_MAX);
    const w = Math.min(
      BUBBLE_MAX,
      Math.max(...lines.map(bodyWidth), 0) + BUBBLE_PAD * 2,
    );
    const h = META_H + lines.length * LINE_H + BUBBLE_PAD * 2;
    bubbles.push({
      role: e.role,
      meta: `${opts.stamp(e.at)} · ${e.role === 'user' ? opts.labels.user : opts.labels.assistant}`,
      metaY: y,
      lines,
      x: e.role === 'user' ? IMG_WIDTH - PAD - w : PAD,
      y: y + META_H,
      w,
      h,
    });
    y += META_H + h + BUBBLE_GAP;
  }
  const height = Math.round(entries.length > 0 ? y - BUBBLE_GAP + PAD : y + PAD);
  return {
    width: IMG_WIDTH,
    height,
    scale: pickScale(IMG_WIDTH, height, opts.scale),
    header,
    bubbles,
  };
}

const BG = '#0a0a0a';
const FG = '#e5e5e5';
const META_FG = '#737373';
const TITLE_FG = '#f5f5f5';
const BUBBLE: Record<ConvRole, { fill: string; stroke: string; fg: string }> = {
  user: { fill: 'rgba(59,130,246,0.14)', stroke: 'rgba(59,130,246,0.35)', fg: '#dbeafe' },
  assistant: { fill: 'rgba(255,255,255,0.06)', stroke: 'rgba(255,255,255,0.10)', fg: FG },
};

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

export function drawConversation(ctx: CanvasRenderingContext2D, layout: ConvImageLayout): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const { y, h, title, subtitle } = layout.header;
  ctx.font = FONTS.title;
  ctx.fillStyle = TITLE_FG;
  ctx.fillText(title, PAD, y);
  ctx.font = FONTS.meta;
  ctx.fillStyle = META_FG;
  ctx.fillText(subtitle, PAD, y + TITLE_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, y + h);
  ctx.lineTo(layout.width - PAD, y + h);
  ctx.stroke();
  for (const b of layout.bubbles) {
    const c = BUBBLE[b.role];
    ctx.font = FONTS.meta;
    ctx.fillStyle = META_FG;
    ctx.textAlign = b.role === 'user' ? 'right' : 'left';
    ctx.fillText(b.meta, b.role === 'user' ? b.x + b.w : b.x, b.metaY);
    ctx.textAlign = 'left';
    roundRect(ctx, b.x, b.y, b.w, b.h, 8);
    ctx.fillStyle = c.fill;
    ctx.fill();
    ctx.strokeStyle = c.stroke;
    ctx.stroke();
    ctx.font = FONTS.body;
    ctx.fillStyle = c.fg;
    b.lines.forEach((line, i) => {
      ctx.fillText(line, b.x + BUBBLE_PAD, b.y + BUBBLE_PAD + i * LINE_H);
    });
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
