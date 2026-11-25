import { useSyncExternalStore } from 'react';
import { routeToPath } from '@/lib/route';
import {
  type LayoutNode,
  decodeLayout,
  encodeLayout,
  paneIdsOf,
  placePane,
  removePane,
  adjustWeights as adjustWeightsTree,
} from './pane-layout';

/**
 * 弹出框架页的 storage 协议（schema 2）：一个框架页 = **一个项目**的多 pane 面
 * （wezterm 贴 pane 同款，最多 MAX_PANES 个；同项目的会话都挂这一页）。
 * 记录只存视图元信息（实例 id / 会话 id / 布局树），不存命令、输入、输出或凭据。
 * 主窗与弹出窗都经这里读写同一份记录（storage 事件回读），两窗状态天然同源。
 */

export const FRAME_MAX_PANES = 6;
/** 移动端（触屏 + 窄屏）框架页上限：一屏只容得下上下/左右两格。 */
export const FRAME_MAX_PANES_MOBILE = 2;

/** 移动端判据（触屏指针 + 窄视口；桌面大触屏不算——那有空间摆多格）。 */
export function isMobileViewport(): boolean {
  try {
    return (
      window.matchMedia('(hover: none), (pointer: coarse)').matches &&
      window.matchMedia('(max-width: 1023px)').matches
    );
  } catch {
    return false;
  }
}

/** 本端当前生效的 pane 上限（桌面 6 / 移动端 2；参数化口，别写死调用）。 */
export function frameMaxPanes(): number {
  return isMobileViewport() ? FRAME_MAX_PANES_MOBILE : FRAME_MAX_PANES;
}

/** 移动端落点侧：竖屏 = 上下叠（bottom），横屏 = 左右排（right）；桌面恒 right。 */
export function frameInsertSide(): 'right' | 'bottom' {
  if (!isMobileViewport()) return 'right';
  try {
    return window.matchMedia('(orientation: portrait)').matches ? 'bottom' : 'right';
  } catch {
    return 'bottom';
  }
}

/** 框架页内的一个视图（pane 内容）。 */
export type FrameView =
  | { kind: 'terminal'; instanceId: string; label: string; sessionId: string }
  | { kind: 'conversation'; label: string; sessionId: string };

export type PaneTransfer = {
  schema: 2;
  frameId: string;
  /** 归属项目（同项目会话全挂这一页；主窗据此路由终端按钮）。 */
  projectId: number;
  projectLabel: string;
  state: 'active' | 'returning';
  /** 打开时的首个视图（会话对话）。后续 pane 的增减走 views/layout。 */
  seedSessionId: string;
  label: string;
  /** paneId → 视图。paneId 即布局树叶子 id（`v:` 前缀 + 会话 id + kind）。 */
  views: Record<string, FrameView>;
  /** 布局树（encodeLayout 序列化）；null = 单 pane 免布局。 */
  layout: string | null;
};

type PaneInput = {
  projectId: number;
  projectLabel: string;
  sessionId: string;
  label: string;
};

const PREFIX = 'weave:pane-frame:';
const WINDOW_PREFIX = 'weave-pane:';
const CHANGE = 'weave:pane-frames-changed';
const windowRefs = new Map<string, Window>();
/** 主窗聚焦弹出窗用（只读视图；持有引用由 openPaneFrame 维护）。 */
export const windows: ReadonlyMap<string, Window> = windowRefs;

/** crypto.randomUUID 只在安全上下文有——HTTP 局域网访问没有。 */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function frameLayoutOf(frame: PaneTransfer): LayoutNode | null {
  const node = decodeLayout(frame.layout);
  // 布局里引用了缺失视图的叶子剔除（孤儿清扫，同 term-pane-store）
  let cur = node;
  const valid = new Set(Object.keys(frame.views));
  while (cur) {
    const orphans = paneIdsOf(cur).filter((id) => !valid.has(id));
    if (orphans.length === 0) break;
    cur = removePane(cur, orphans[0]!);
  }
  return cur;
}

export function validPaneTransfer(value: unknown): value is PaneTransfer {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<PaneTransfer>;
  if (p.schema !== 2 || typeof p.frameId !== 'string' || typeof p.label !== 'string') return false;
  if (p.state !== 'active' && p.state !== 'returning') return false;
  if (!Number.isInteger(p.projectId) || typeof p.projectLabel !== 'string' || typeof p.seedSessionId !== 'string') return false;
  if (!p.views || typeof p.views !== 'object') return false;
  for (const v of Object.values(p.views)) {
    if (!v || typeof v !== 'object') return false;
    const view = v as Partial<FrameView>;
    if (typeof view.label !== 'string' || typeof view.sessionId !== 'string') return false;
    if (view.kind === 'terminal' && (typeof view.instanceId !== 'string' || view.instanceId.length === 0)) return false;
    else if (view.kind !== 'conversation') return false;
  }
  return true;
}

export function readPaneTransfer(frameId = window.name.startsWith(WINDOW_PREFIX) ? window.name.slice(WINDOW_PREFIX.length) : ''): PaneTransfer | null {
  if (!frameId) return null;
  try {
    const p: unknown = JSON.parse(localStorage.getItem(PREFIX + frameId) ?? 'null');
    return validPaneTransfer(p) && p.frameId === frameId ? p : null;
  } catch {
    return null;
  }
}

function writeFrame(frame: PaneTransfer): void {
  localStorage.setItem(PREFIX + frame.frameId, JSON.stringify(frame));
  changed();
}

function frames(): PaneTransfer[] {
  const result: PaneTransfer[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    const frame = readPaneTransfer(key.slice(PREFIX.length));
    if (frame) result.push(frame);
  }
  return result;
}

function changed(): void {
  window.dispatchEvent(new Event(CHANGE));
}

export function subscribePaneFrames(listener: () => void): () => void {
  const storage = (event: StorageEvent): void => {
    if (event.key === null || event.key.startsWith(PREFIX)) listener();
  };
  window.addEventListener('storage', storage);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener('storage', storage);
    window.removeEventListener(CHANGE, listener);
  };
}

// 快照用序列化字符串保持引用稳定。
function snapshot(): string {
  return JSON.stringify(frames());
}

export function usePaneFrames(): PaneTransfer[] {
  return JSON.parse(useSyncExternalStore(subscribePaneFrames, snapshot)) as PaneTransfer[];
}

/** 某项目的框架页（active 态；同项目恒同一页——已有即复用，不另开窗）。 */
export function frameOfProject(projectId: number): PaneTransfer | null {
  return frames().find((p) => p.projectId === projectId && p.state === 'active') ?? null;
}

/** 会话的视图 paneId（一个会话可同时有对话 + 终端两个视图，kind 区分）。 */
export function viewIdOf(sessionId: string, kind: 'conversation' | 'terminal'): string {
  return `${kind}:${sessionId}`;
}

/** 落一个新的框架页（openPaneFrame 的「无已有页」路径抽出复用：溢出开新窗同走这里）。 */
function spawnPaneFrame(pane: PaneInput, features: string): string {
  const frameId = uuid();
  const viewId = viewIdOf(pane.sessionId, 'conversation');
  const descriptor: PaneTransfer = {
    schema: 2,
    frameId,
    projectId: pane.projectId,
    projectLabel: pane.projectLabel,
    state: 'active',
    seedSessionId: pane.sessionId,
    label: pane.label,
    views: { [viewId]: { kind: 'conversation', label: pane.label, sessionId: pane.sessionId } },
    layout: null,
  };
  localStorage.setItem(PREFIX + frameId, JSON.stringify(descriptor));
  const popup = window.open(routeToPath({ kind: 'pane-frame' }), WINDOW_PREFIX + frameId, features);
  if (!popup) {
    finishPaneFrame(frameId);
    throw new Error('浏览器阻止了弹出窗口，请允许本站弹窗后重试。');
  }
  windowRefs.set(frameId, popup);
  changed();
  // 只探浏览器窗口是否关闭，不把后台标签页的节流误判成失联。
  const timer = window.setInterval(() => {
    if (!popup.closed) return;
    window.clearInterval(timer);
    windowRefs.delete(frameId);
    finishPaneFrame(frameId);
  }, 1000);
  return frameId;
}

export function openPaneFrame(pane: PaneInput, features: string): string {
  const existing = frameOfProject(pane.projectId);
  if (existing) {
    // 同项目的第二扇对话：贴进已有框架页（幂等）再聚焦——只聚焦不贴的话，
    // 后续会话点「弹出」没反应，像是被第一扇挡死了。
    const res = attachFrameView(existing.frameId, { kind: 'conversation', label: pane.label, sessionId: pane.sessionId });
    windowRefs.get(existing.frameId)?.focus();
    // 满 6（移动端 2）：贴不进 = 另开一页容纳（一个项目的框架页可以有多扇）。
    if (!res.ok) return spawnPaneFrame(pane, features);
    return existing.frameId;
  }
  return spawnPaneFrame(pane, features);
}

/** 往框架页贴一个视图（wezterm 贴 pane）：挂在锚视图旁（缺省 = 最后一个叶子）。
 *  会话已有同 kind 视图 = 幂等（聚焦不重挂）；满上限拒绝（调用方决定是否另开窗）。
 *  上限与落点按设备形态现取（桌面 6 右插 / 移动端 2 上下叠）。 */
export function attachFrameView(
  frameId: string,
  view: FrameView,
  anchorPaneId?: string,
): { ok: boolean; reason?: 'limit' } {
  const frame = readPaneTransfer(frameId);
  if (!frame) return { ok: false };
  const viewId = viewIdOf(view.sessionId, view.kind);
  if (frame.views[viewId]) return { ok: true };
  if (Object.keys(frame.views).length >= frameMaxPanes()) return { ok: false, reason: 'limit' };
  const views = { ...frame.views, [viewId]: view };
  const layout = frameLayoutOf(frame);
  // 锚 = 已有 pane 的最后一个叶子；layout 为 null（单 pane 页）时兜底树也必须是
  // **已有视图**而非新视图——拿新视图当锚（或直接把布局写成只有新视图）会把旧
  // pane 挤出布局（新 pane「覆盖」旧 pane）。
  const anchor = anchorPaneId ?? paneIdsOf(layout ?? { kind: 'pane', paneId: Object.keys(frame.views)[0] ?? viewId }).at(-1)!;
  const nextLayout = placePane(
    layout ?? { kind: 'pane', paneId: anchor },
    anchor,
    null,
    frameInsertSide(),
    viewId,
    frameMaxPanes(),
  );
  if (!nextLayout) return { ok: false };
  writeFrame({ ...frame, views, layout: encodeLayout(nextLayout) });
  return { ok: true };
}

/** 从框架页摘掉一个视图（pane 关闭；单 pane 时只清布局）。 */
export function detachFrameView(frameId: string, viewPaneId: string): void {
  const frame = readPaneTransfer(frameId);
  if (!frame || !frame.views[viewPaneId]) return;
  const views = { ...frame.views };
  delete views[viewPaneId];
  const layout = removePane(frameLayoutOf(frame) ?? ({ kind: 'pane', paneId: viewPaneId } as LayoutNode), viewPaneId);
  writeFrame({ ...frame, views, layout: layout ? encodeLayout(layout) : null });
}

/** 分隔条拖动（path/index 来自 layoutGeometry 的 sep）。 */
export function adjustFrameWeights(frameId: string, path: number[], index: number, delta: number): void {
  const frame = readPaneTransfer(frameId);
  if (!frame) return;
  const layout = frameLayoutOf(frame);
  if (!layout) return;
  writeFrame({ ...frame, layout: encodeLayout(adjustWeightsTree(layout, path, index, delta)) });
}

export function reclaimPaneFrame(frameId: string): void {
  const frame = readPaneTransfer(frameId);
  if (!frame) return;
  localStorage.setItem(PREFIX + frameId, JSON.stringify({ ...frame, state: 'returning' }));
  changed();
}

/** 独立页卸载视图后确认归还；主窗收到记录删除才恢复原视图。 */
export function finishPaneFrame(frameId: string): void {
  localStorage.removeItem(PREFIX + frameId);
  changed();
}
