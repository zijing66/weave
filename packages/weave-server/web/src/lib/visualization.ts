/**
 * 渲染块 materialize：把 HTML fragment 包成完整文档喂 sandbox iframe。
 * 结构 = CSP meta + 主题变量注入 + openai shim + resize 桥 + fragment 原文。
 * 除 `themeVarsOf` 读 computedStyle 外皆纯函数，单测覆盖。
 */

/** fragment 契约的 CDN 白名单（codex visualize 同清单，其余 origin 静默失败）。 */
const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="' +
  "default-src 'none'; " +
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com; " +
  "style-src 'unsafe-inline'; " +
  'font-src https://fonts.googleapis.com https://fonts.gstatic.com https://fonts.bunny.net; ' +
  'img-src data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; ' +
  "connect-src https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com\">";

/**
 * 语义别名 → weave 主题令牌名（`--w-<family>-<shade>`）。fragment 契约用
 * shadcn 风格语义变量（`--background` 等），weave 只有 `--w-*`——这里给两层
 * 映射：先按主题选出各别名的 weave 令牌名，materialize 时再把令牌名解析成
 * 实际色值写进 iframe 文档（srcdoc 是独立文档树，`var(--w-*)` 引用过去解析不到）。
 */
const THEME_ALIAS_TOKENS: Record<'dark' | 'light', Record<string, string>> = {
  dark: {
    '--background': '--w-neutral-950',
    '--foreground': '--w-neutral-50',
    '--card': '--w-neutral-900',
    '--card-foreground': '--w-neutral-50',
    '--popover': '--w-neutral-900',
    '--popover-foreground': '--w-neutral-50',
    '--muted': '--w-neutral-800',
    '--muted-foreground': '--w-neutral-400',
    '--border': '--w-neutral-700',
    '--input': '--w-neutral-700',
    '--ring': '--w-blue-500',
    '--primary': '--w-blue-500',
    '--primary-foreground': '--w-neutral-50',
    '--secondary': '--w-neutral-800',
    '--secondary-foreground': '--w-neutral-100',
    '--accent': '--w-neutral-800',
    '--accent-foreground': '--w-neutral-100',
    '--destructive': '--w-red-500',
    '--danger': '--w-red-500',
    '--success': '--w-emerald-500',
    '--warning': '--w-amber-500',
    '--info': '--w-sky-500',
  },
  light: {
    '--background': '--w-neutral-50',
    '--foreground': '--w-neutral-100',
    '--card': '--w-neutral-50',
    '--card-foreground': '--w-neutral-100',
    '--popover': '--w-neutral-50',
    '--popover-foreground': '--w-neutral-100',
    '--muted': '--w-neutral-200',
    '--muted-foreground': '--w-neutral-500',
    '--border': '--w-neutral-200',
    '--input': '--w-neutral-200',
    '--ring': '--w-blue-500',
    '--primary': '--w-blue-500',
    '--primary-foreground': '--w-neutral-50',
    '--secondary': '--w-neutral-100',
    '--secondary-foreground': '--w-neutral-900',
    '--accent': '--w-neutral-100',
    '--accent-foreground': '--w-neutral-900',
    '--destructive': '--w-red-500',
    '--danger': '--w-red-500',
    '--success': '--w-emerald-500',
    '--warning': '--w-amber-500',
    '--info': '--w-sky-500',
  },
};

/** 渲染块高度下限（空 fragment 也要有壳）与硬顶（超大视口不再长）。 */
export const VIZ_MIN_HEIGHT = 40;
export const VIZ_MAX_HEIGHT = 1200;
/** 气泡区占比：块再高也不占满整个对话区，上下留出上下文。 */
const VIZ_HEIGHT_RATIO = 0.7;
/** 极窄气泡区（手机横屏 / 右栏 / 分屏）的兜底：块再挤也给到这个高度，装不下就整区滚。 */
const VIZ_HEIGHT_FLOOR = 320;

/**
 * 渲染块高度上限 = 气泡区（对话滚动容器）可给的高度
 * `min(1200, max(320, 气泡区高 × 0.7))`。基准是**气泡区**不是窗口：右栏 / 手机抽屉里
 * 对话区远小于视口，按视口算出来的块会一屏都放不下。超出部分在 iframe 内部滚动；
 * 气泡区小到连兜底都装不下时宁可整区滚，也不把块压没。
 */
export function visualizationHeightCap(bubbleAreaHeight: number): number {
  return Math.min(VIZ_MAX_HEIGHT, Math.max(VIZ_HEIGHT_FLOOR, Math.round(bubbleAreaHeight * VIZ_HEIGHT_RATIO)));
}

/**
 * 对话气泡区的标记属性（挂在对话滚动容器上）。**不能靠「最近的滚动祖先」去猜**：
 * 气泡自己带 `overflow-x-auto`，按 CSS 规则那一轴的 `visible` 会算成 `auto`，
 * 猜出来的就是气泡本身——高度跟着块自己变，成了自锁环。
 */
export const CONV_SCROLLER_ATTR = 'data-conv-scroller';

export interface MaterializeOptions {
  /** 当前主题（`useTheme()` 的返回值；主题翻转时调用方重算 srcDoc）。 */
  theme: 'dark' | 'light';
  /** weave 令牌名 → 实际色值（`themeVarsOf` 的产物；注入前解析，srcdoc 里引用不到父页变量）。 */
  vars: Record<string, string>;
}

/**
 * 读当前文档里全部 `--w-*` 令牌的实际值（RGB triple 形如 `23 23 23`）。
 * 一次性读 188 个，主题翻转时由调用方重算。
 */
export function themeVarsOf(): Record<string, string> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return {};
  const vars: Record<string, string> = {};
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 跨域 stylesheet（理论上无）读不了规则，跳过
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const sel = rule.selectorText ?? '';
      if (!sel.includes('[data-theme') && sel !== ':root') continue;
      for (let i = 0; i < rule.style.length; i++) {
        const prop = rule.style.item(i)!;
        if (prop.startsWith('--w-')) vars[prop] = rule.style.getPropertyValue(prop).trim();
      }
      if (sel === ':root') break;
    }
  }
  return vars;
}

/**
 * fragment → 完整 HTML 文档。fragment 原文原样拼接（契约保证无 doctype/head/body）；
 * 主题别名解析成实际色值注入 `:root`（`--w-*` 值是 RGB triple，包一层 `rgb()`）。
 */
export function materialize(fragmentHtml: string, options: MaterializeOptions): string {
  const aliasTokens = THEME_ALIAS_TOKENS[options.theme];
  const varLines = Object.entries(aliasTokens)
    .map(([name, token]) => {
      const triple = options.vars[token];
      const value = triple ? `rgb(${triple})` : 'transparent';
      return `${name}: ${value};`;
    })
    .join('\n    ');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${CSP_META}
<style>
  :root {
    color-scheme: ${options.theme};
    ${varLines}
  }
  html, body { margin: 0; padding: 0; background: transparent; }
  body { color: var(--foreground); }
</style>
<script>
  window.openai = {
    setWidgetState: function () { return Promise.resolve(); },
    sendFollowUpMessage: function () {}
  };
</script>
<script>
  (function () {
    var last = -1;
    function post() {
      var h = Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0
      );
      if (h > 0 && h !== last) {
        last = h;
        parent.postMessage({ type: 'viz-resize', height: h }, '*');
      }
    }
    window.addEventListener('load', post);
    window.addEventListener('resize', post);
    setInterval(post, 400);
  })();
</script>
</head>
<body>
${fragmentHtml}
</body>
</html>`;
}
