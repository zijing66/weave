import { useSyncExternalStore } from 'react';

/**
 * 主题三态：`auto`（默认，跟系统）/ `dark` / `light`。色值全在 CSS 变量里
 * （`tailwind.config.js` 的 themeTokens 插件），这里只负责把 `data-theme`
 * 落到 `<html>` 上并记住用户的选择。
 *
 * `auto` 下监听系统的 `prefers-color-scheme` 变化实时跟随；`index.html` 的
 * 内联脚本先按同一套规则落一次，首屏不闪白。
 */
export type Theme = 'dark' | 'light';
export type ThemePreference = 'auto' | Theme;

const KEY = 'weave:theme';
const META_COLOR: Record<Theme, string> = { dark: '#0a0a0a', light: '#fafafa' };

function stored(): ThemePreference {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'dark' || raw === 'light' || raw === 'auto') return raw;
  } catch {
    /* 隐私模式读不到：回落 auto */
  }
  return 'auto';
}

function systemTheme(): Theme {
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** 偏好 → 实际落盘的主题（auto 解析到系统当前值）。 */
function resolveTheme(preference: ThemePreference): Theme {
  return preference === 'auto' ? systemTheme() : preference;
}

let preference: ThemePreference = stored();
let current: Theme = resolveTheme(preference);
const listeners = new Set<() => void>();

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLOR[theme]);
}

export function theme(): Theme {
  return current;
}

export function themePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 隐私模式写不进去：本次会话内照样生效，下次开页面回落 auto
  }
  current = resolveTheme(preference);
  applyTheme(current);
  for (const listener of listeners) listener();
}

/** 兼容旧入口：在 dark/light 间切换（auto 下从系统当前值出发）。 */
export function toggleTheme(): void {
  setThemePreference(current === 'dark' ? 'light' : 'dark');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, theme);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, themePreference);
}

// auto 下跟系统走：系统切换深浅时实时跟随（matchMedia 变化即重解析）。
// 旧 Safari 的 MediaQueryList 只有 addListener——可选链会静默不装，两挂兜底。
if (typeof globalThis.matchMedia === 'function') {
  const onSystemChange = (): void => {
    if (preference !== 'auto') return;
    current = resolveTheme('auto');
    applyTheme(current);
    for (const listener of listeners) listener();
  };
  const mql = globalThis.matchMedia('(prefers-color-scheme: light)');
  if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSystemChange);
  else mql.addListener?.(onSystemChange);
}

/** 单测（node）里没有 document：那里只 import 类型，不落主题。 */
if (typeof document !== 'undefined') applyTheme(current);
