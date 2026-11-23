import { useSyncExternalStore } from 'react';
import { routeToPath } from '@/lib/route';

export type PaneTransfer = {
  schema: 1;
  frameId: string;
  paneId: string;
  label: string;
  state: 'active' | 'returning';
} & (
  | { kind: 'terminal'; instanceId: string }
  | { kind: 'conversation'; sessionId: string; projectId: number; projectLabel: string }
);
type PaneInput =
  | { kind: 'terminal'; paneId: string; instanceId: string; label: string }
  | { kind: 'conversation'; paneId: string; sessionId: string; projectId: number; label: string; projectLabel: string };

const PREFIX = 'weave:pane-frame:';
const WINDOW_PREFIX = 'weave-pane:';
const CHANGE = 'weave:pane-frames-changed';
const windows = new Map<string, Window>();

export function validPaneTransfer(value: unknown): value is PaneTransfer {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<PaneTransfer>;
  if (p.schema !== 1 || typeof p.frameId !== 'string' || typeof p.paneId !== 'string' || typeof p.label !== 'string') return false;
  if (p.state !== 'active' && p.state !== 'returning') return false;
  return p.kind === 'terminal'
    ? typeof p.instanceId === 'string' && p.instanceId.length > 0
    : p.kind === 'conversation' && typeof p.sessionId === 'string' && Number.isInteger(p.projectId) && typeof p.projectLabel === 'string';
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

// 快照用序列化字符串保持引用稳定；数据只存视图元信息，不存命令、输入、输出或凭据。
function snapshot(): string {
  return JSON.stringify(frames());
}

export function usePaneFrames(): PaneTransfer[] {
  return JSON.parse(useSyncExternalStore(subscribePaneFrames, snapshot)) as PaneTransfer[];
}

export function openPaneFrame(pane: PaneInput, features: string): string {
  const existing = frames().find((p) => p.paneId === pane.paneId || (p.kind === 'terminal' && pane.kind === 'terminal' && p.instanceId === pane.instanceId));
  if (existing) {
    windows.get(existing.frameId)?.focus();
    return existing.frameId;
  }
  const frameId = crypto.randomUUID();
  const descriptor: PaneTransfer = { ...pane, schema: 1, frameId, state: 'active' };
  localStorage.setItem(PREFIX + frameId, JSON.stringify(descriptor));
  const popup = window.open(routeToPath({ kind: 'pane' }), WINDOW_PREFIX + frameId, features);
  if (!popup) {
    finishPaneFrame(frameId);
    throw new Error('浏览器阻止了弹出窗口，请允许本站弹窗后重试。');
  }
  windows.set(frameId, popup);
  changed();
  // 只探浏览器窗口是否关闭，不把后台标签页的节流误判成失联。
  const timer = window.setInterval(() => {
    if (!popup.closed) return;
    window.clearInterval(timer);
    windows.delete(frameId);
    finishPaneFrame(frameId);
  }, 1000);
  return frameId;
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
