import type { Theme } from './theme';

/**
 * mermaid 的唯一加载点（对话气泡内联渲染与导出图片共用）。渲染器是好几百 KB 的
 * 一坨（d3/cytoscape/katex…），只在真有图时才动态加载，进程内只加载一次。
 *
 * 图源来自模型输出 ⇒ `securityLevel: 'strict'`：mermaid 自己会把标签里的 HTML
 * 与脚本过滤掉。
 */
let loader: Promise<typeof import('mermaid').default> | null = null;
let seq = 0;

async function mermaidFor(theme: Theme): Promise<typeof import('mermaid').default> {
  loader ??= import('mermaid').then((m) => m.default);
  const mermaid = await loader;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'light' ? 'default' : 'dark',
    fontFamily: 'inherit',
  });
  return mermaid;
}

/** 图源 → SVG 字符串（渲染失败即抛，调用方自己决定回落成什么）。 */
export async function renderMermaidSvg(code: string, theme: Theme): Promise<string> {
  const mermaid = await mermaidFor(theme);
  // id 每次渲染都换：失败时 mermaid 可能留下同 id 的临时节点，复用会串
  const { svg } = await mermaid.render(`mmd-${++seq}`, code);
  return svg;
}

/** 画布用的图：位图 + 已经按可用宽度缩好的尺寸。 */
export interface MermaidImage {
  img: HTMLImageElement;
  w: number;
  h: number;
}

/**
 * 画布吃得下的 SVG：百分比宽高的 SVG 塞进 `<img>` 会量到 0 尺寸，故把宽高改写成
 * viewBox 的实际值。返回改写后的源码与实际尺寸。
 */
function sizedSvg(svg: string): { svg: string; w: number; h: number } {
  const box = /viewBox="([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)"/.exec(svg);
  const w = box ? Number(box[3]) : 640;
  const h = box ? Number(box[4]) : 400;
  const out = svg.replace(
    /<svg([^>]*)>/,
    (_tag, attrs: string) =>
      `<svg${attrs.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '')} width="${w}" height="${h}">`,
  );
  return { svg: out, w, h };
}

/** SVG 源码 → 同源 data: URL 的 `<img>`。
 *  **不能用 `blob:`**：那种 SVG 画进 canvas 会让画布 taint，`toBlob` 直接拒绝导出。 */
async function svgImage(svg: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  return img;
}

/**
 * 图源 → 可 `drawImage` 的位图（导出图片用）。先按 viewBox 得到实际尺寸，再按可用
 * 宽度/高度等比缩到目标尺寸。
 */
export async function renderMermaidImage(
  code: string,
  theme: Theme,
  maxW: number,
  maxH = 480,
): Promise<MermaidImage> {
  const sized = sizedSvg(await renderMermaidSvg(code, theme));
  const scale = Math.min(1, maxW / sized.w, maxH / sized.h);
  const img = await svgImage(sized.svg);
  return { img, w: Math.round(sized.w * scale), h: Math.round(sized.h * scale) };
}

/** 下载图的底色：与导出图片的页面底色同源（`conv-image` 的 PAGE）。 */
const DOWNLOAD_BG: Record<Theme, string> = { dark: '#0f0f0f', light: '#f8f8f8' };

/**
 * 给 SVG 垫一层底色。**必须垫**：mermaid 的 SVG 背景是透明的，深色主题下文字是
 * 浅色——单独打开（浏览器/看图器默认白底）就是「一片空白、字看不见」。
 */
function withBackground(sized: string, color: string): string {
  return sized.replace(/(<svg[^>]*>)/, `$1<rect x="0" y="0" width="100%" height="100%" fill="${color}"/>`);
}

/** 单块图的可下载文件（块头上的「下载」用，与导出图片共用同一套尺寸处理）。 */
export function mermaidSvgFile(svg: string, theme: Theme): Blob {
  const sized = sizedSvg(svg);
  return new Blob([withBackground(sized.svg, DOWNLOAD_BG[theme])], {
    type: 'image/svg+xml;charset=utf-8',
  });
}

/** PNG 版：按 `scale` 倍（缺省 2×，够屏显与贴文档）画到画布再编码。 */
export async function mermaidPngFile(svg: string, theme: Theme, scale = 2): Promise<Blob> {
  const sized = sizedSvg(svg);
  const img = await svgImage(withBackground(sized.svg, DOWNLOAD_BG[theme]));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sized.w * scale);
  canvas.height = Math.round(sized.h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  // 再铺一层画布底色：SVG 那层只盖到 viewBox，缩放后的边缘像素不至于透出
  ctx.fillStyle = DOWNLOAD_BG[theme];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, sized.w, sized.h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('image encoding failed');
  return blob;
}

/** 触发浏览器下载（同源 blob，不出网）。 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 下载文件名：`weave-mermaid-<YYYYMMDD-HHmmss>.<ext>`。 */
export function mermaidFileName(ext: 'svg' | 'png', at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const ts =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `weave-mermaid-${ts}.${ext}`;
}
