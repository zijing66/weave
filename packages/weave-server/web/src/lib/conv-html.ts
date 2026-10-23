/**
 * 对话 → **单页自包含 HTML**（纯函数）。所有内容内联：样式进 `<style>`、图进
 * `data:` URL、mermaid 内联成 SVG、字体用系统栈——**不引用任何外部资源**（无
 * `<link>`、无 `<script src>`、无 CDN），单个 .html 拷到哪都能看。
 *
 * 正文解析复用 `conv-markdown`（与画布导出同一份知识），这里只做块 → 语义标签。
 * **所有文本与属性值一律转义**：正文来自模型输出，进 HTML 文件就不能留注入面；
 * 链接目标只放行 http(s)/mailto/相对路径，`javascript:` 一律降成纯文本。
 *
 * 自定义头（`head`）按用户配置**原样**插在 `</head>` 之前——那是「让导出页带上
 * 自己的样式/脚本」的口子，只在导出文件里生效，绝不进 dashboard 的渲染面。
 */
import { parseMarkdown, type MdBlock, type MdItem, type MdSpan } from './conv-markdown';

/** 导出需要的条目形状（`ConvEntry` 结构上满足它；纯函数不绑组件类型）。 */
export interface ConvHtmlEntry {
  role: 'user' | 'assistant' | 'compaction';
  at: string;
  text: string;
  plan?: boolean;
  failed?: boolean;
  fromWeave?: boolean;
  fromName?: string | null;
  /** 随附文件：图内联成 data URL，其余只列文件名（不做 PDF/音频之类的内联）。 */
  attachments?: Array<{ id: string; name: string; mediaType?: string }>;
}

export interface HtmlExportOpts {
  /** 会话显示名（标题与文件名都用它）。 */
  title: string;
  /** 角色文案（i18n 不进纯函数）。 */
  labels: { user: string; assistant: string; plan: string };
  /** 自定义头（原样注入）；空 = 不带。 */
  head?: string | null;
  /** imageId → data URL（没给到的图退回占位文本，不摆裂图）。 */
  assets?: Map<string, string>;
  /** mermaid 源码 → 已渲染的 SVG（没给到的回落成代码块）。 */
  diagrams?: Map<string, string>;
  exportedAt?: Date;
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 文本/属性值转义（同一份判据，属性里也够用）。 */
export function escHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESC[c]!);
}

/** 链接只放行这几类：`javascript:` / `data:` 之类一律不出 `<a>`。 */
function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:|#|\/)/i.test(url) ? url : null;
}

/** 本地时刻 `YYYY-MM-DD HH:mm:ss`（与文本导出同形）。 */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function spansHtml(spans: readonly MdSpan[]): string {
  return spans
    .map((s) => {
      const inner = escHtml(s.text);
      switch (s.style) {
        case 'strong':
          return `<strong>${inner}</strong>`;
        case 'em':
          return `<em>${inner}</em>`;
        case 'strongEm':
          return `<strong><em>${inner}</em></strong>`;
        case 'code':
          return `<code>${inner}</code>`;
        case 'del':
          return `<del>${inner}</del>`;
        case 'link': {
          const href = s.href ? safeHref(s.href) : null;
          return href
            ? `<a href="${escHtml(href)}" target="_blank" rel="noreferrer">${inner}</a>`
            : inner;
        }
        default:
          return inner;
      }
    })
    .join('');
}

/** 列表：按 `level` 递归建嵌套 `<ul>`/`<ol>`（首项的记号决定序号样式）。 */
function listHtml(items: readonly MdItem[]): string {
  let i = 0;
  const build = (level: number): string => {
    const rows: string[] = [];
    let ordered = false;
    while (i < items.length) {
      const item = items[i]!;
      if (item.level < level) break;
      if (item.level > level) {
        // 子列表挂进上一项；没有上一项（层级跳变）就当同级处理
        const sub = build(item.level);
        if (rows.length > 0) rows[rows.length - 1] += sub;
        else rows.push(`<li>${sub}</li>`);
        continue;
      }
      if (rows.length === 0) ordered = /^\d/.test(item.marker);
      i++;
      const bullet = /^[•*+-]$/.test(item.marker) ? '' : `<span class="li-mark">${escHtml(item.marker)}</span> `;
      let row = `<li>${bullet}${spansHtml(item.spans)}`;
      if (i < items.length && items[i]!.level > level) row += build(items[i]!.level);
      rows.push(`${row}</li>`);
    }
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}>${rows.join('')}</${tag}>`;
  };
  return items.length > 0 ? build(items[0]!.level) : '';
}

function blockHtml(block: MdBlock, diagrams?: Map<string, string>): string {
  switch (block.kind) {
    case 'p':
      return `<p>${spansHtml(block.spans)}</p>`;
    case 'h': {
      const level = Math.min(6, Math.max(1, block.level));
      return `<h${level}>${spansHtml(block.spans)}</h${level}>`;
    }
    case 'code': {
      const code = block.lines.join('\n');
      const svg = block.lang === 'mermaid' ? diagrams?.get(code) : undefined;
      if (svg) return `<figure class="diagram">${svg}</figure>`;
      const cls = block.lang ? ` class="language-${escHtml(block.lang)}"` : '';
      return `<pre><code${cls}>${escHtml(code)}</code></pre>`;
    }
    case 'list':
      return listHtml(block.items);
    case 'quote':
      return `<blockquote>${block.lines.map((l) => `<p>${spansHtml(l)}</p>`).join('')}</blockquote>`;
    case 'table': {
      if (block.rows.length === 0) return '';
      const rowHtml = (cells: readonly MdSpan[][], tag: 'th' | 'td'): string =>
        `<tr>${cells.map((c) => `<${tag}>${spansHtml(c)}</${tag}>`).join('')}</tr>`;
      const [head, ...body] = block.rows;
      return (
        `<table><thead>${rowHtml(head ?? [], 'th')}</thead>` +
        `<tbody>${body.map((r) => rowHtml(r, 'td')).join('')}</tbody></table>`
      );
    }
    case 'hr':
      return '<hr>';
  }
}

function bodyHtml(text: string, diagrams?: Map<string, string>): string {
  return parseMarkdown(text)
    .map((b) => blockHtml(b, diagrams))
    .join('\n');
}

function entryHtml(
  entry: ConvHtmlEntry,
  opts: HtmlExportOpts,
): string {
  const tags: string[] = [];
  if (entry.fromWeave) tags.push('<span class="tag">weave</span>');
  else if (entry.fromName) tags.push(`<span class="tag">${escHtml(entry.fromName)}</span>`);
  if (entry.plan) tags.push(`<span class="tag">${escHtml(opts.labels.plan)}</span>`);
  if (entry.failed) tags.push('<span class="tag tag-failed">✕</span>');

  let imgN = 0;
  const images = (entry.attachments ?? [])
    .map((a) => {
      const isImage = (a.mediaType ?? '').startsWith('image/');
      if (!isImage) return `<p class="file">[File] ${escHtml(a.name)}</p>`;
      imgN++;
      const data = opts.assets?.get(a.id);
      return data
        ? `<figure class="image"><img src="${data}" alt="${escHtml(a.name)}"></figure>`
        : `<p class="image-missing">[Image #${imgN}] ${escHtml(a.name)}</p>`;
    })
    .join('\n');

  const role = entry.role === 'user' ? opts.labels.user : opts.labels.assistant;
  return [
    `<article class="msg ${entry.role === 'user' ? 'from-user' : 'from-assistant'}${entry.failed ? ' failed' : ''}">`,
    `  <header><span class="role">${escHtml(role)}</span><time>${escHtml(stamp(entry.at))}</time>${tags.join('')}</header>`,
    `  <div class="body">${bodyHtml(entry.text, opts.diagrams)}</div>`,
    images ? `  ${images}` : '',
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 自包含样式：只用系统字体、无外链；深/浅色跟随系统。 */
const STYLE = `
:root {
  color-scheme: dark light;
  --bg: #0b0b0c; --fg: #e6e6e6; --muted: #8b8b90; --line: #26262a;
  --card: #141416; --user: #17233a; --accent: #7aa2f7; --code: #0e0e10; --code-fg: #d5d5d8;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #fafafa; --fg: #1f2328; --muted: #6b7076; --line: #e2e2e5;
    --card: #ffffff; --user: #eef3fb; --accent: #2563eb; --code: #f4f4f6; --code-fg: #24292f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg);
  font: 14px/1.65 system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
}
main { max-width: 880px; margin: 0 auto; }
.doc { margin: 0 0 20px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.doc h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
.doc .meta { margin: 0; color: var(--muted); font-size: 12px; }
.msg { margin: 0 0 14px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); max-width: 88%; }
.msg.from-user { margin-left: auto; background: var(--user); }
.msg.failed { border-color: #7f1d1d; }
.msg header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; color: var(--muted); font-size: 11px; }
.msg header .role { color: var(--fg); font-weight: 600; }
.msg header time { font-variant-numeric: tabular-nums; }
.tag { padding: 0 4px; border: 1px solid var(--line); border-radius: 4px; }
.tag-failed { color: #f87171; border-color: #7f1d1d; }
.body > :first-child { margin-top: 0; }
.body > :last-child { margin-bottom: 0; }
.body p { margin: 6px 0; }
.body h1, .body h2, .body h3, .body h4, .body h5, .body h6 { margin: 14px 0 6px; line-height: 1.35; }
.body h1 { font-size: 18px; } .body h2 { font-size: 16px; } .body h3 { font-size: 15px; }
.body ul, .body ol { margin: 6px 0; padding-left: 22px; }
.body li { margin: 2px 0; }
.li-mark { color: var(--muted); }
.body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: var(--code); padding: 1px 4px; border-radius: 4px; }
.body pre { margin: 8px 0; padding: 10px; overflow-x: auto; background: var(--code); border: 1px solid var(--line); border-radius: 8px; }
.body pre code { padding: 0; background: none; color: var(--code-fg); }
.body blockquote { margin: 8px 0; padding: 2px 0 2px 10px; border-left: 2px solid var(--line); color: var(--muted); }
.body table { width: 100%; margin: 8px 0; border-collapse: collapse; font-size: 13px; }
.body th, .body td { padding: 4px 8px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
.body th { background: var(--code); font-weight: 600; }
.body a { color: var(--accent); }
.body hr { margin: 14px 0; border: 0; border-top: 1px solid var(--line); }
.diagram { margin: 8px 0; padding: 8px; overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--code); }
.diagram svg { display: block; margin: 0 auto; max-width: 100%; height: auto; }
.image { margin: 8px 0; }
.image img { display: block; max-width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--line); }
.image-missing { color: var(--muted); font-size: 12px; }
`;

/** 条目（压缩分隔跳过——它不是谁说的话，与文本/图片导出同口径）→ 完整单页文档。 */
export function conversationHtml(
  entries: readonly ConvHtmlEntry[],
  opts: HtmlExportOpts,
): string {
  const at = opts.exportedAt ?? new Date();
  const shown = entries.filter((e) => e.role !== 'compaction');
  const parts = shown.map((e) => entryHtml(e, opts));
  const count = shown.length;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(opts.title)} · ${escHtml(stamp(at.toISOString()))}</title>
<style>${STYLE}</style>
${opts.head ?? ''}
</head>
<body>
<main>
<header class="doc">
<h1>${escHtml(opts.title)}</h1>
<p class="meta">${escHtml(stamp(at.toISOString()))} · ${count}</p>
</header>
${parts.join('\n')}
</main>
</body>
</html>
`;
}

/** 导出文件名：`weave-<safe>-YYYYMMDD-HHmmss.html`（与图片导出同形）。 */
export function htmlFileName(label: string, at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const safe = label.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const ts =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `weave-${safe || 'conversation'}-${ts}.html`;
}
