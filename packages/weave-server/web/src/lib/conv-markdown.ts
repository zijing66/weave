/**
 * 会话正文的 markdown → 块（纯函数、零依赖）。分享出去的图片要跟窗口里那套预览
 * （`AssistantMarkdown` = react-markdown + remark-gfm）**看着一致**，所以只覆盖它
 * 真会渲染的那套：标题 / 段落 / 列表（含任务列表）/ 围栏代码 / 引用 / 表格 /
 * 分隔线，行内粗体 / 斜体 / 行内代码 / 链接（含裸链接）/ 删除线。
 *
 * 不是完整 GFM：解析不出的记号原样留在文本里——宁可露出记号，也不吞掉内容。
 * 链接只画标签（与窗口同），标签与目标不同则补一个 `(目标)`：图片点不动，不写出来
 * 这条链接就等于丢了。
 */

export type MdStyle = 'plain' | 'strong' | 'em' | 'strongEm' | 'code' | 'link' | 'del';

export interface MdSpan {
  text: string;
  style: MdStyle;
}

export interface MdItem {
  /** 行首记号：`•` / `☐` / `☑` / `3.`（序号保留原文）。 */
  marker: string;
  /** 嵌套层级（缩进每 2 空格一级，最多 3 级）。 */
  level: number;
  spans: MdSpan[];
}

export type MdBlock =
  | { kind: 'p'; spans: MdSpan[] }
  | { kind: 'h'; level: number; spans: MdSpan[] }
  /** 围栏块：`lang` 取围栏 info 串的第一个词（小写）；没有 info 串即 null。 */
  | { kind: 'code'; lang: string | null; lines: string[] }
  | { kind: 'list'; items: MdItem[] }
  | { kind: 'quote'; lines: MdSpan[][] }
  | { kind: 'table'; rows: MdSpan[][][] }
  | { kind: 'hr' };

/** 嵌套只保留「视觉上可控」的组合：代码/链接吃掉内层样式，粗+斜合成一档。 */
function combine(outer: MdStyle, inner: MdStyle): MdStyle {
  if (outer === 'plain') return inner;
  if (inner === 'plain') return outer;
  if (outer === 'code' || inner === 'code') return 'code';
  if (outer === 'link' || inner === 'link') return 'link';
  if (outer === 'del' || inner === 'del') return 'del';
  return 'strongEm';
}

const INLINE =
  /(`+)([\s\S]*?)\1|~{2}([\s\S]+?)~{2}|\*{2}([\s\S]+?)\*{2}|_{2}([\s\S]+?)_{2}|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]\n]*)\]\(([^)\s]*)\)|(https?:\/\/[^\s<>()]+)|(\\(?:[\\`*_~{}[\]()#+\-.!>|]))/;

/** 行内记号 → 扁平 span（嵌套记号递归解析，样式按 `combine` 合成）。 */
export function parseInline(text: string, outer: MdStyle = 'plain'): MdSpan[] {
  const out: MdSpan[] = [];
  let plain = '';
  let rest = text;
  const flush = (): void => {
    if (plain !== '') {
      out.push({ text: plain, style: outer });
      plain = '';
    }
  };
  while (rest !== '') {
    const m = INLINE.exec(rest);
    if (!m || m.index === undefined) break;
    plain += rest.slice(0, m.index);
    const g = m.slice(1);
    if (g[1] !== undefined) {
      flush();
      out.push({ text: g[1], style: combine(outer, 'code') });
    } else if (g[2] !== undefined) {
      flush();
      out.push(...parseInline(g[2], combine(outer, 'del')));
    } else if (g[3] !== undefined || g[4] !== undefined) {
      flush();
      out.push(...parseInline(g[3] ?? g[4]!, combine(outer, 'strong')));
    } else if (g[5] !== undefined || g[6] !== undefined) {
      flush();
      out.push(...parseInline(g[5] ?? g[6]!, combine(outer, 'em')));
    } else if (g[7] !== undefined) {
      const label = g[7];
      const url = g[8] ?? '';
      flush();
      const text2 = url !== '' && url !== label ? `${label || url} (${url})` : label || url;
      if (text2 !== '') out.push(...parseInline(text2, combine(outer, 'link')));
    } else if (g[9] !== undefined) {
      // 裸链接：句末标点不属于它，退回正文
      const trail = /[.,;:!?]+$/.exec(g[9])?.[0] ?? '';
      const url = g[9].slice(0, g[9].length - trail.length);
      flush();
      out.push({ text: url, style: combine(outer, 'link') });
      plain = trail;
    } else if (g[10] !== undefined) {
      plain += g[10].slice(1);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  plain += rest;
  flush();
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const FENCE_END = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** 围栏 info 串的第一个词（` ```mermaid title=… ` → `mermaid`）；没有即 null。 */
function fenceLang(info: string | undefined): string | null {
  const word = (info ?? '').trim().split(/\s+/)[0] ?? '';
  return word ? word.toLowerCase() : null;
}
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
/** 这些开头另起一块——列表项续行遇到它们就不算续行了。 */
const STARTS_BLOCK = /^ {0,3}(#{1,6}\s|>|`{3,}|~{3,}|[-*+]\s|\d{1,9}[.)]\s)/;

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  const last = cells[cells.length - 1]!;
  if (cells.length > 1 && last.trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

function isTableSep(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitCells(line);
  return cells.length >= 1 && cells.every((c) => /^:?-+:?$/.test(c));
}

function readTable(lines: readonly string[], start: number, out: MdBlock[]): number {
  const rows: MdSpan[][][] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '' || !line.includes('|')) break;
    i++;
    if (isTableSep(line)) continue;
    rows.push(splitCells(line).map((c) => parseInline(c)));
  }
  if (rows.length > 0) out.push({ kind: 'table', rows });
  return i;
}

function readList(lines: readonly string[], start: number, out: MdBlock[]): number {
  const items: MdItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (!bullet && !ordered) {
      // 续行：比记号更缩进、且不另起一块 → 并进上一条（软换行按空格接）
      const cont = items[items.length - 1];
      if (cont && line.trim() !== '' && /^\s{2,}/.test(line) && !STARTS_BLOCK.test(line)) {
        cont.spans = [...cont.spans, { text: ' ', style: 'plain' }, ...parseInline(line.trim())];
        i++;
        continue;
      }
      break;
    }
    const level = Math.min(3, Math.floor((bullet ?? ordered)![1]!.length / 2));
    let marker: string;
    let rest: string;
    if (bullet) {
      const task = TASK.exec(bullet[3]!);
      if (task) {
        marker = task[1]!.toLowerCase() === 'x' ? '☑' : '☐';
        rest = task[2]!;
      } else {
        marker = '•';
        rest = bullet[3]!;
      }
    } else {
      marker = `${ordered![2]}.`;
      rest = ordered![3]!;
    }
    items.push({ marker, level, spans: parseInline(rest) });
    i++;
  }
  out.push({ kind: 'list', items });
  return i;
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const out: MdBlock[] = [];
  const para: string[] = [];
  const flushPara = (): void => {
    if (para.length > 0) {
      // 行内空白按窗口那样折叠（HTML 折叠连续空白与换行）
      out.push({ kind: 'p', spans: parseInline(para.join(' ').replace(/ {2,}/g, ' ')) });
      para.length = 0;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const end = FENCE_END.exec(lines[i]!);
        if (end && end[1]![0] === fence[1]![0] && end[1]!.length >= fence[1]!.length) {
          i++;
          break;
        }
        body.push(lines[i]!);
        i++;
      }
      out.push({ kind: 'code', lang: fenceLang(fence[2]), lines: body });
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      out.push({ kind: 'h', level: heading[1]!.length, spans: parseInline(heading[2]!) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      flushPara();
      out.push({ kind: 'hr' });
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      flushPara();
      i = readTable(lines, i, out);
      continue;
    }
    if (QUOTE.test(line)) {
      flushPara();
      const q: MdSpan[][] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]!);
        if (!m) break;
        q.push(m[1]!.trim() === '' ? [] : parseInline(m[1]!));
        i++;
      }
      out.push({ kind: 'quote', lines: q });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      flushPara();
      i = readList(lines, i, out);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out;
}
