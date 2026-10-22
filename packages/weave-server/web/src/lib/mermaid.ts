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
 * 图源 → 可 `drawImage` 的位图（导出图片用）。画布吃不下百分比宽高的 SVG——
 * `<img>` 拿到的尺寸会是 0——故先把宽高改写为 viewBox 的实际值，再按可用宽度
 * 等比缩到目标尺寸。
 */
export async function renderMermaidImage(
  code: string,
  theme: Theme,
  maxW: number,
  maxH = 480,
): Promise<MermaidImage> {
  const svg = await renderMermaidSvg(code, theme);
  const box = /viewBox="([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)"/.exec(svg);
  const iw = box ? Number(box[3]) : 640;
  const ih = box ? Number(box[4]) : 400;
  const scale = Math.min(1, maxW / iw, maxH / ih);
  const sized = svg.replace(
    /<svg([^>]*)>/,
    (_tag, attrs: string) =>
      `<svg${attrs.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '')} width="${iw}" height="${ih}">`,
  );
  // 必须用 data: URL：blob: 的 SVG 画进 canvas 会让画布 taint（实测 toBlob 直接
  // 拒绝导出），data: 视为同源内联内容，画布保持可导出。
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  await img.decode();
  return { img, w: Math.round(iw * scale), h: Math.round(ih * scale) };
}
