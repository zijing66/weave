import typography from '@tailwindcss/typography';
import colors from 'tailwindcss/colors';

/** 参与主题翻转的色系（`bg-neutral-800` 这类类名照旧写，值换成 CSS 变量）。 */
const FAMILIES = [
  'neutral',
  'amber',
  'blue',
  'cyan',
  'emerald',
  'fuchsia',
  'indigo',
  'lime',
  'orange',
  'pink',
  'purple',
  'red',
  'rose',
  'sky',
  'slate',
  'teal',
  'violet',
];
const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];

/** 浅色下 neutral 不走镜像：100–600 在暗色里是文字、700–950 是底色，
 *  浅色里要的是「文字变深、底色变浅」，逐档指定比公式准。 */
const NEUTRAL_LIGHT = {
  50: '#ffffff',
  100: '#0a0a0a',
  200: '#171717',
  300: '#262626',
  400: '#404040',
  500: '#525252',
  600: '#666666',
  700: '#d4d4d4',
  800: '#e5e5e5',
  900: '#f5f5f5',
  950: '#fafafa',
};
/** 彩色系按「文字侧 ↔ 底色侧」对调：100–400 是暗色上的字、800–950 是暗色的底，
 *  500–700 作实心底与描边两界通吃，保持原档。
 *  文字侧退到 700/800 是为了浅色底上的对比度——600 只有 ~3:1，偏黄的色系 700 也才 ~4:1。 */
const FLIP = { 50: '950', 100: '950', 200: '900', 300: '800', 400: '700', 500: '500', 600: '600', 700: '700', 800: '200', 900: '100', 950: '50' };
const WEAK = new Set(['amber', 'cyan', 'emerald', 'lime', 'orange', 'teal']);
const flipShade = (family, shade) => (shade === '400' && WEAK.has(family) ? '800' : FLIP[shade]);

const triple = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(' ');
};

const varsFor = (theme) => {
  const vars = { '--w-edge': theme === 'light' ? '0 0 0' : '255 255 255' };
  for (const family of FAMILIES) {
    for (const shade of SHADES) {
      const value =
        family === 'neutral' && theme === 'light'
          ? NEUTRAL_LIGHT[shade]
          : colors[family][theme === 'light' ? flipShade(family, shade) : shade];
      vars[`--w-${family}-${shade}`] = triple(value);
    }
  }
  return vars;
};

/** 主题令牌：暗色 = Tailwind 原值，浅色 = 上表的对调结果；两套都落在 CSS 变量上，
 *  组件只写 `bg-neutral-900` / `border-edge/10`，不再逐个加 `dark:` 变体。 */
const themeTokens = ({ addBase }) => {
  addBase({
    ':root, [data-theme="dark"]': { ...varsFor('dark'), 'color-scheme': 'dark' },
    '[data-theme="light"]': { ...varsFor('light'), 'color-scheme': 'light' },
  });
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SF Mono', 'Cascadia Code', 'Menlo', 'monospace'],
      },
      colors: {
        mac: {
          accent: '#0A84FF',
          red: '#FF5F57',
          yellow: '#FEBC2E',
          green: '#28C840',
        },
        // 半透明白（描边/浮层）换成语义 token：浅色下它得是墨色，纯白会消失
        edge: 'rgb(var(--w-edge) / <alpha-value>)',
        ...Object.fromEntries(
          FAMILIES.map((family) => [
            family,
            Object.fromEntries(SHADES.map((shade) => [shade, `rgb(var(--w-${family}-${shade}) / <alpha-value>)`])),
          ]),
        ),
      },
      boxShadow: {
        mac: '0 8px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)',
        'mac-sm': '0 2px 8px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.04)',
      },
      transitionTimingFunction: {
        mac: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
      },
    },
  },
  plugins: [typography, themeTokens],
};
