/**
 * Web 终端 pane 的窗口级 store（单向数据流：所有变更经这里的 action 走，
 * 组件只读快照）。两个摆放面共用一套 pane 账：右栏（panel）与全屏弹层（overlay）。
 * 同一实例全窗只允许一个 pane（PTY 几何单值，双 pane 互抢 resize）。
 * 持久化 = localStorage 快照（PTY 住在 Runtime Host、不随页面关——刷新后原样恢复）。
 */

import { useSyncExternalStore } from 'react';
import {
  MAX_PANES,
  type DropSide,
  type LayoutNode,
  decodeLayout,
  encodeLayout,
  paneIdsOf,
  placePane,
  removePane,
  adjustWeights as adjustWeightsTree,
} from './pane-layout';
import { paneSync } from './pane-sync';

export type PaneSlot = 'panel' | 'overlay';

export interface PaneRecord {
  paneId: string;
  instanceId: string;
  label: string;
  slot: PaneSlot;
  /** 绑定的会话（panel 面的会话终端）：pane 与会话同生命周期，切会话即让位。
   *  overlay 面（项目级 shell）不带。 */
  sessionId?: string;
  /** 归属项目（渲染端按项目过滤跨窗共享账；存量 pane 无此字段照显）。 */
  projectId?: number;
  /** 连上后一次性注入的命令（带 \r；转窗/恢复都不补发）。 */
  initialCommand?: string;
  /** 已弹出到独立窗口：本窗只留占位卡（不挂 xterm/WS），点切回即恢复。 */
  poppedOut?: boolean;
  /** 弹到哪个窗口（reclaim 定向 + 持窗失联自动恢复的判据）。 */
  poppedWinId?: string;
}

export interface TermPaneState {
  panes: Record<string, PaneRecord>;
  layouts: Record<PaneSlot, LayoutNode | null>;
  /** 每个摆放面的焦点 pane（键盘/输入权提示用）。 */
  active: Record<PaneSlot, string | null>;
}

const STORAGE_KEY = 'weave:term-panes';

let paneSeq = 0;
function newPaneId(): string {
  return `tp${Date.now().toString(36)}${(paneSeq++).toString(36)}`;
}

function emptyState(): TermPaneState {
  return { panes: {}, layouts: { panel: null, overlay: null }, active: { panel: null, overlay: null } };
}

function loadState(): TermPaneState {
  const state = emptyState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return state;
    const parsed = JSON.parse(raw) as {
      panes?: Record<string, PaneRecord>;
      layouts?: Record<string, string>;
      active?: Record<string, string | null>;
    };
    for (const slot of ['panel', 'overlay'] as PaneSlot[]) {
      const layout = decodeLayout(parsed.layouts?.[slot] ?? null);
      const ids = layout ? paneIdsOf(layout) : [];
      for (const paneId of ids) {
        const pane = parsed.panes?.[paneId];
        if (pane && typeof pane.instanceId === 'string') {
          state.panes[paneId] = { ...pane, paneId, slot };
        }
      }
      // 布局里引用了缺失 pane 的叶子剔除（孤儿清扫）
      let node = layout;
      const valid = new Set(Object.keys(state.panes).filter((id) => state.panes[id]!.slot === slot));
      while (node) {
        const orphans = paneIdsOf(node).filter((id) => !valid.has(id));
        if (orphans.length === 0) break;
        node = removePane(node, orphans[0]!);
      }
      state.layouts[slot] = node;
      state.active[slot] = null;
    }
  } catch {
    return emptyState();
  }
  return state;
}

let state: TermPaneState = typeof window === 'undefined' ? emptyState() : loadState();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function set(next: TermPaneState): void {
  state = next;
  for (const l of listeners) l();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const layouts: Record<string, string> = {};
    for (const slot of ['panel', 'overlay'] as PaneSlot[]) {
      if (state.layouts[slot]) layouts[slot] = encodeLayout(state.layouts[slot]!);
    }
    try {
      // poppedOut 不持久化：主窗刷新后 pane 回到本地显示（弹窗若还开着，两边同显
      // 由用户关掉一边；比「刷新后卡在占位、弹窗已死却无法恢复」安全）。
      const panes: Record<string, PaneRecord> = {};
      for (const [id, pane] of Object.entries(state.panes)) {
        panes[id] = { ...pane, poppedOut: false, poppedWinId: undefined };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ panes, layouts }));
    } catch {
      /* 私隐模式等写不进就算了——内存态照常 */
    }
  }, 300);
}

export function getTermPaneState(): TermPaneState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTermPanes(): TermPaneState {
  return useSyncExternalStore(subscribe, getTermPaneState);
}

export interface OpenPaneInput {
  instanceId: string;
  label: string;
  slot: PaneSlot;
  initialCommand?: string;
  sessionId?: string;
  projectId?: number;
}

export interface OpenPaneResult {
  ok: boolean;
  reason?: 'limit' | 'duplicate' | 'other-window';
  paneId?: string;
}

/** 开一个 pane（新终端）。同实例在本窗已有 pane → 聚焦它；在别的窗口 → 拒绝。 */
export function openPane(input: OpenPaneInput, opts?: { fromDrop?: boolean }): OpenPaneResult {
  const dup = Object.values(state.panes).find((p) => p.instanceId === input.instanceId);
  if (dup) {
    focusPane(dup.paneId);
    return { ok: false, reason: 'duplicate', paneId: dup.paneId };
  }
  // 跨窗投放进来时来源窗还挂着该实例（ack 后马上下）——presence 闸此时必假，跳过
  if (!opts?.fromDrop && paneSync.instanceShownElsewhere(input.instanceId)) return { ok: false, reason: 'other-window' };
  const panesOfSlot = Object.values(state.panes).filter((p) => p.slot === input.slot);
  if (panesOfSlot.length >= MAX_PANES) return { ok: false, reason: 'limit' };
  const paneId = newPaneId();
  const pane: PaneRecord = { paneId, ...input };
  const layout = state.layouts[input.slot];
  const nextLayout = layout
    ? placePane(layout, paneIdsOf(layout).at(-1)!, null, 'right', paneId)
    : ({ kind: 'pane', paneId } as LayoutNode);
  if (!nextLayout) return { ok: false, reason: 'limit' };
  set({
    ...state,
    panes: { ...state.panes, [paneId]: pane },
    layouts: { ...state.layouts, [input.slot]: nextLayout },
    active: { ...state.active, [input.slot]: paneId },
  });
  return { ok: true, paneId };
}

export function closePane(paneId: string): void {
  const pane = state.panes[paneId];
  if (!pane) return;
  const panes = { ...state.panes };
  delete panes[paneId];
  const layout = removePane(state.layouts[pane.slot] ?? ({ kind: 'pane', paneId } as LayoutNode), paneId);
  const active = { ...state.active };
  if (active[pane.slot] === paneId) {
    const rest = layout ? paneIdsOf(layout) : [];
    active[pane.slot] = rest[0] ?? null;
  }
  set({ ...state, panes, layouts: { ...state.layouts, [pane.slot]: layout }, active });
}

/** 标记弹出到独立窗口（本窗留占位、卸 xterm）／清除标记（切回或持窗失联）。
 *  poppedWinId = pane-transfer 的 frameId（记录存在 = 持窗在）。 */
export function setPanePopped(paneId: string, poppedWinId: string | null): void {
  const pane = state.panes[paneId];
  if (!pane) return;
  if (poppedWinId !== null) {
    set({
      ...state,
      panes: {
        ...state.panes,
        [paneId]: { ...pane, poppedOut: true, poppedWinId: poppedWinId || undefined },
      },
    });
  } else if (pane.poppedOut) {
    set({ ...state, panes: { ...state.panes, [paneId]: { ...pane, poppedOut: false, poppedWinId: undefined } } });
  }
}

/** 跨窗收进已退役（弹出 = 独立终端页，不进别窗 grid）——保留最小判据给入口。 */
export function paneOfInstance(instanceId: string): PaneRecord | null {
  return Object.values(state.panes).find((p) => p.instanceId === instanceId) ?? null;
}

/** 同窗内拖拽落点（新开场景走 openPane + appendInto，见下）。 */
export function movePane(dragPaneId: string, targetPaneId: string, side: DropSide): void {
  const drag = state.panes[dragPaneId];
  const target = state.panes[targetPaneId];
  if (!drag || !target || drag.slot !== target.slot) return;
  const layout = state.layouts[drag.slot];
  if (!layout) return;
  const next = placePane(layout, targetPaneId, dragPaneId, side);
  if (!next) return;
  set({ ...state, layouts: { ...state.layouts, [drag.slot]: next } });
}

/** 把已有 pane 换到指定 slot（面板 ↔ 弹层）。 */
export function setPaneSlot(paneId: string, slot: PaneSlot): void {
  const pane = state.panes[paneId];
  if (!pane || pane.slot === slot) return;
  if (Object.values(state.panes).filter((p) => p.slot === slot).length >= MAX_PANES) return;
  movePaneBetweenSlots(paneId, slot);
}

function movePaneBetweenSlots(paneId: string, slot: PaneSlot): void {
  const pane = state.panes[paneId]!;
  const from = pane.slot;
  const fromLayout = removePane(state.layouts[from] ?? ({ kind: 'pane', paneId } as LayoutNode), paneId);
  const toLayout = state.layouts[slot];
  const nextTo = toLayout
    ? placePane(toLayout, paneIdsOf(toLayout).at(-1)!, null, 'right', paneId)
    : ({ kind: 'pane', paneId } as LayoutNode);
  if (!nextTo) return;
  const active = { ...state.active };
  const rest = fromLayout ? paneIdsOf(fromLayout) : [];
  if (active[from] === paneId) active[from] = rest[0] ?? null;
  active[slot] = paneId;
  set({
    panes: { ...state.panes, [paneId]: { ...pane, slot } },
    layouts: { ...state.layouts, [from]: fromLayout, [slot]: nextTo },
    active,
  });
}

/** 分隔条拖动：path/index 来自 layoutGeometry 的 sep。 */
export function adjustPaneWeights(slot: PaneSlot, path: number[], index: number, delta: number): void {
  const layout = state.layouts[slot];
  if (!layout) return;
  set({ ...state, layouts: { ...state.layouts, [slot]: adjustWeightsTree(layout, path, index, delta) } });
}

export function focusPane(paneId: string): void {
  const pane = state.panes[paneId];
  if (!pane || state.active[pane.slot] === paneId) return;
  set({ ...state, active: { ...state.active, [pane.slot]: paneId } });
}

/** 会话面板（panel）与对话同区：切到别的会话时，不属于它的 pane 让位（detach，
 *  TUI 进程照跑——回来再点终端按钮即恢复）。恢复这条会话自己的 pane（有 = 聚焦，
 *  没有 = 调用方照常走 openPane）。 */
export function focusSessionPanes(sessionId: string): void {
  const mine: string[] = [];
  const others: string[] = [];
  for (const pane of Object.values(state.panes)) {
    if (pane.slot !== 'panel') continue;
    (pane.sessionId === sessionId || !pane.sessionId ? mine : others).push(pane.paneId);
  }
  // 存量 pane（无 sessionId）不赶：旧账无法归属，仍按窗口级保活
  if (others.length > 0) for (const paneId of others) closePane(paneId);
  const focus = mine[0];
  if (focus && state.active.panel !== focus) focusPane(focus);
}
