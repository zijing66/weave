import { useSyncExternalStore } from 'react';

/**
 * 界面缩放：CSS zoom 落在 `<html>` 上，文字/间距/弹层整体等比（与浏览器 Ctrl±
 * 同语义，css-viewport 标准属性）。纯本机显示偏好——localStorage 记忆、不进
 * daemon settings；index.html 的内联脚本在样式表生效前先落一次，首屏不跳尺寸。
 */
const KEY = 'weave:fontScale';
export const FONT_SCALE_MIN = 85;
export const FONT_SCALE_MAX = 125;
export const FONT_SCALE_STEP = 5;
export const FONT_SCALE_DEFAULT = 100;

const clamp = (n: number): number =>
  Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(n)));

function stored(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n !== 0 ? clamp(n) : FONT_SCALE_DEFAULT;
  } catch {
    return FONT_SCALE_DEFAULT;
  }
}

let current = FONT_SCALE_DEFAULT;
const listeners = new Set<() => void>();

export function applyFontScale(scale: number): void {
  document.documentElement.style.zoom = scale === FONT_SCALE_DEFAULT ? '' : String(scale / 100);
}

export function fontScale(): number {
  return current;
}

export function setFontScale(scale: number): void {
  current = clamp(scale);
  try {
    localStorage.setItem(KEY, String(current));
  } catch {
    // 隐私模式写不进去：本次会话内照样生效，下次开页面回到默认
  }
  applyFontScale(current);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFontScale(): number {
  return useSyncExternalStore(subscribe, fontScale);
}

/**
 * fixed 弹层坐标换算（全站唯一换算点）：`getBoundingClientRect` 给的是**视觉 px**，
 * 而根 zoom 会把 fixed 元素的 CSS 值再乘一次——写进 style 前一律除回来，
 * 否则缩放 ≠100% 时弹层整体飞离锚点（左定位偏 left×25%、右定位偏得少但同样错）。
 * 锚点矩形、视口宽高（innerWidth/innerHeight 本就是视觉 px）全程用视觉值算，
 * 只在最终落 style 那一步过这里。
 */
export function cssPx(visual: number): number {
  const z = current / 100;
  return z === 1 ? visual : visual / z;
}

/** 单测（node）里没有 document：那里只 import 类型，不落缩放。 */
if (typeof document !== 'undefined') {
  current = stored();
  applyFontScale(current);
}
