import { useSyncExternalStore } from 'react';
import { MAIN_CATEGORIES, type MainCategory } from '@/components/CategoryBar';

/**
 * 前端路由（三级：项目 / 功能卡片 / 卡片内会话）。
 *
 * `/`                                未选项目
 * `/p/<projectId>/<category>`        项目 + 卡片
 * `/p/<projectId>/<category>/<sid>`  再带会话
 * `/g/<category>`                    全局模式（机器级 pseudo 项目，没有会话级）
 *
 * 只做**位置**：卡片内的开关（资源管理的视图、claude/codex 页签、文件预览、
 * 移动端抽屉）是页面内状态，不进 URL。深链能直接打开靠 daemon 的 SPA 兜底
 * （`serveStatic` 找不到文件回落 index.html），dev 下靠 Vite 的 history fallback。
 */

export type Route =
  | { kind: 'none' }
  | { kind: 'global'; category: MainCategory }
  | { kind: 'project'; projectId: number; category: MainCategory; sessionId: string | null };

const DEFAULT_CATEGORY: MainCategory = 'tasks';
const CATEGORY_KEYS: readonly string[] = MAIN_CATEGORIES.map((c) => c.key);

/** 未知分类回落默认卡：老链接、手改地址都不该白屏。 */
function categoryOf(raw: string | undefined): MainCategory {
  return raw !== undefined && CATEGORY_KEYS.includes(raw) ? (raw as MainCategory) : DEFAULT_CATEGORY;
}

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'g') return { kind: 'global', category: categoryOf(parts[1]) };
  if (parts[0] === 'p') {
    const projectId = Number(parts[1]);
    if (!Number.isInteger(projectId) || projectId <= 0) return { kind: 'none' };
    return {
      kind: 'project',
      projectId,
      category: categoryOf(parts[2]),
      sessionId: parts[3] ? decodeURIComponent(parts[3]) : null,
    };
  }
  return { kind: 'none' };
}

export function routeToPath(route: Route): string {
  if (route.kind === 'none') return '/';
  if (route.kind === 'global') return `/g/${route.category}`;
  const base = `/p/${route.projectId}/${route.category}`;
  return route.sessionId === null ? base : `${base}/${encodeURIComponent(route.sessionId)}`;
}

let path = typeof window === 'undefined' ? '/' : window.location.pathname;
const listeners = new Set<() => void>();

function setPath(next: string): void {
  if (path === next) return;
  path = next;
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  // 后退/前进只搬运位置；把「位置 → 状态」交给订阅方
  window.addEventListener('popstate', () => setPath(window.location.pathname));
}

export function currentPath(): string {
  return path;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRoutePath(): string {
  return useSyncExternalStore(subscribe, currentPath);
}

/** 写 URL 的唯一入口（组件不自拼路径）。`replace` = 纠正/落地，不占历史。 */
export function navigate(route: Route, opts?: { replace?: boolean }): void {
  const next = routeToPath(route);
  if (typeof window === 'undefined' || next === window.location.pathname) {
    setPath(next);
    return;
  }
  if (opts?.replace) window.history.replaceState(null, '', next);
  else window.history.pushState(null, '', next);
  setPath(next);
}
