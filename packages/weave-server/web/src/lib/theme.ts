import { useSyncExternalStore } from 'react';

/**
 * 深色 / 浅色主题：色值全在 CSS 变量里（`tailwind.config.js` 的 themeTokens 插件），
 * 这里只负责把 `data-theme` 落到 `<html>` 上并记住用户的选择。
 *
 * 没选过就跟系统走——`index.html` 的内联脚本先按同一套规则落一次，首屏不闪白。
 */
export type Theme = 'dark' | 'light';

const KEY = 'weave:theme';
const META_COLOR: Record<Theme, string> = { dark: '#0a0a0a', light: '#fafafa' };

function stored(): Theme | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === 'dark' || raw === 'light' ? raw : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

let current: Theme = stored() ?? systemTheme();
const listeners = new Set<() => void>();

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLOR[theme]);
}

export function theme(): Theme {
  return current;
}

export function toggleTheme(): void {
  current = current === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(KEY, current);
  } catch {
    // 隐私模式写不进去：本次会话内照样生效，下次开页面回落到系统主题
  }
  applyTheme(current);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, theme);
}

/** 单测（node）里没有 document：那里只 import 类型，不落主题。 */
if (typeof document !== 'undefined') applyTheme(current);
