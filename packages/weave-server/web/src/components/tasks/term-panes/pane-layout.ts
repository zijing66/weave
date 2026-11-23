/**
 * 终端分屏布局（纯函数，可单测）：叶子 = pane，内节点 = split（row/col）。
 * 每个浏览器窗口最多 MAX_PANES 个 pane；同一实例在一个窗口的布局里只允许出现一次
 * （同实例多 pane 由调用方在入口处拦截，这里只做去重防御）。
 *
 * 布局渲染成「扁平绝对定位」而不是递归 DOM：所有 pane 以稳定 key 渲染在同一父层，
 * 拖拽/重排只改坐标，绝不 unmount xterm（否则 detach→attach→重放→gap 闪烁）。
 */

/** 每个浏览器窗口的分屏上限（用户裁决 2026-11-22）。 */
export const MAX_PANES = 6;

/** 分隔条最小拖拽占比：低于它 pane 会被压死（xterm 最小 2 列都放不下）。 */
export const MIN_WEIGHT = 0.08;

export type SplitDir = 'row' | 'col';

export type LayoutNode =
  | { kind: 'pane'; paneId: string }
  | { kind: 'split'; dir: SplitDir; children: LayoutNode[]; weights: number[] };

export type DropSide = 'left' | 'right' | 'top' | 'bottom' | 'center';

/** 布局里的全部 pane（含重复防御用的计数）。 */
export function paneIdsOf(node: LayoutNode): string[] {
  if (node.kind === 'pane') return [node.paneId];
  return node.children.flatMap(paneIdsOf);
}

export function paneCount(node: LayoutNode): number {
  return paneIdsOf(node).length;
}

/** 把某 pane 换成另一个 paneId（中心落点 = 原位交换）。 */
function replacePane(node: LayoutNode, from: string, to: string): LayoutNode {
  if (node.kind === 'pane') return node.paneId === from ? { kind: 'pane', paneId: to } : node;
  return { ...node, children: node.children.map((c) => replacePane(c, from, to)) };
}

/** 删除 pane 并清理空 split / 单子提升；根被删空 = null。 */
export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === 'pane') return node.paneId === paneId ? null : node;
  const kept: { child: LayoutNode; weight: number }[] = [];
  node.children.forEach((child, i) => {
    const pruned = removePane(child, paneId);
    if (pruned) kept.push({ child: pruned, weight: node.weights[i] ?? 1 });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!.child;
  return { kind: 'split', dir: node.dir, children: kept.map((k) => k.child), weights: normalize(kept.map((k) => k.weight)) };
}

/** 在 targetPane 的某侧插入新 pane；center = 换位（to 占据 target 的位置）。
 * 返回 null = 拒绝（超上限 / 重复实例 / 目标不在树里）。 */
export function placePane(
  node: LayoutNode,
  targetPaneId: string,
  dragPaneId: string | null,
  side: DropSide,
  newPaneId?: string,
): LayoutNode | null {
  // 交换：两个 pane 都已在树里，直接换位，不增数量。
  if (side === 'center' && dragPaneId) {
    if (!paneIdsOf(node).includes(targetPaneId) || !paneIdsOf(node).includes(dragPaneId)) return null;
    return swapPanes(node, targetPaneId, dragPaneId);
  }
  if (!paneIdsOf(node).includes(targetPaneId)) return null;
  // 新 pane（drag 为 null）才计数上限；移动不增数。
  if (dragPaneId == null && paneCount(node) >= MAX_PANES) return null;
  // 移动且 drag 已在树里：先删再插，数量不变。
  const base = dragPaneId != null ? removePane(node, dragPaneId) : node;
  if (base == null) return null; // 树只有 drag 一个 pane，无处可落——调用方不该走到这
  if (dragPaneId != null && paneIdsOf(base).includes(targetPaneId) === false) return null;
  return insertBeside(base, targetPaneId, dragPaneId ?? newPaneId ?? `pane-${nextSeq()}`, side);
}

function swapPanes(node: LayoutNode, a: string, b: string): LayoutNode {
  const withA = replacePane(node, a, '\0a');
  const withB = replacePane(withA, b, a);
  return replacePane(withB, '\0a', b);
}

/** 往 target 旁边塞一个新 pane（target 必须还在树里）。 */
function insertBeside(node: LayoutNode, targetPaneId: string, newPaneId: string, side: DropSide): LayoutNode | null {
  const horizontal = side === 'left' || side === 'right';
  const after = side === 'right' || side === 'bottom';
  if (node.kind === 'pane') {
    if (node.paneId !== targetPaneId) return node;
    return {
      kind: 'split',
      dir: horizontal ? 'row' : 'col',
      children: after ? [node, { kind: 'pane', paneId: newPaneId }] : [{ kind: 'pane', paneId: newPaneId }, node],
      weights: [0.5, 0.5],
    };
  }
  // target 在某个子树里 → 沿途在命中子树的父 split 就近插入；方向一致且 target
  // 是该子树的最外/最内叶子时可直接并进本层，否则下钻。
  const hit = node.children.findIndex((c) => paneIdsOf(c).includes(targetPaneId));
  if (hit < 0) return null;
  const sameDir = (node.dir === 'row') === horizontal;
  if (sameDir) {
    const targetIsEdgeLeaf =
      isEdgeLeaf(node.children[hit]!, after) && node.children[hit]!.kind === 'pane';
    if (targetIsEdgeLeaf) {
      const children = [...node.children];
      const weights = [...node.weights];
      children.splice(after ? hit + 1 : hit, 0, { kind: 'pane', paneId: newPaneId });
      weights.splice(after ? hit + 1 : hit, 0, MIN_WEIGHT);
      return { ...node, children, weights: normalize(weights) };
    }
  }
  const children = [...node.children];
  const drilled = insertBeside(children[hit]!, targetPaneId, newPaneId, side);
  if (drilled == null) return null;
  children[hit] = drilled;
  return { ...node, children };
}

/** 子树在 after 方向上是否只有（edge）一个叶子（决定能否把新 pane 直接并进父层）。 */
function isEdgeLeaf(node: LayoutNode, after: boolean): boolean {
  if (node.kind === 'pane') return true;
  return isEdgeLeaf(after ? node.children[node.children.length - 1]! : node.children[0]!, after);
}

let seq = 0;
function nextSeq(): number {
  return ++seq;
}

export function normalizeWeights(weights: number[]): number[] {
  return normalize(weights);
}

function normalize(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 1 / values.length);
  return values.map((v) => v / total);
}

/** 相邻两档 weight 增减（分隔条拖动）：px 换算归调用方，这里只做钳制与归一。 */
export function adjustWeights(node: LayoutNode, path: number[], index: number, delta: number): LayoutNode {
  if (node.kind === 'pane') return node;
  if (path.length === 0) {
    const weights = [...node.weights];
    const lo = MIN_WEIGHT;
    const a = weights[index] ?? 0.5;
    const b = weights[index + 1] ?? 0.5;
    const d = Math.max(Math.min(delta, b - lo), lo - a);
    weights[index] = a + d;
    weights[index + 1] = b - d;
    return { ...node, weights };
  }
  const [head, ...rest] = path;
  const children = [...node.children];
  children[head] = adjustWeights(children[head]!, rest, index, delta);
  return { ...node, children };
}

// ---------------------------------------------------------------------------
// 扁平渲染几何：一次递归算出每个 pane 的矩形与每条分隔条的矩形（全部 0–1 分数）。
// ---------------------------------------------------------------------------

export interface PaneRect {
  paneId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SepRect {
  /** 稳定 id：分隔条随布局重排允许重挂（它不持 xterm 状态）。 */
  key: string;
  /** 到该 split 节点的孩子索引路径（adjustWeights 用）。 */
  path: number[];
  index: number;
  dir: SplitDir;
  /** 分隔线位置（分数）：row = 边界 x，col = 边界 y；渲染端定宽居中。 */
  bx: number;
  by: number;
  /** 覆盖区域（分数），渲染端取 top/height 或 left/width。 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutGeometry {
  panes: PaneRect[];
  seps: SepRect[];
}

export function layoutGeometry(node: LayoutNode, keyPrefix = 's'): LayoutGeometry {
  return walk(node, 0, 0, 1, 1, keyPrefix);
}

function walk(node: LayoutNode, x: number, y: number, w: number, h: number, key: string): LayoutGeometry {
  if (node.kind === 'pane') return { panes: [{ paneId: node.paneId, x, y, w, h }], seps: [] };
  const weights = node.weights.length === node.children.length ? normalizeWeights(node.weights) : node.children.map(() => 1 / node.children.length);
  const panes: PaneRect[] = [];
  const seps: SepRect[] = [];
  let cursor = 0;
  node.children.forEach((child, i) => {
    const span = weights[i]!;
    const childKey = `${key}/${i}`;
    if (node.dir === 'row') {
      const cx = x + cursor * w;
      const cw = span * w;
      const g = walk(child, cx, y, cw, h, childKey);
      panes.push(...g.panes);
      seps.push(...g.seps);
      if (i > 0) {
        seps.push({ key: `${key}:${i - 1}`, path: pathOf(key), index: i - 1, dir: 'row', bx: cx, by: y, x: cx, y, w: 0, h });
      }
    } else {
      const cy = y + cursor * h;
      const ch = span * h;
      const g = walk(child, x, cy, w, ch, childKey);
      panes.push(...g.panes);
      seps.push(...g.seps);
      if (i > 0) {
        seps.push({ key: `${key}:${i - 1}`, path: pathOf(key), index: i - 1, dir: 'col', bx: x, by: cy, x, y: cy, w, h: 0 });
      }
    }
    cursor += span;
  });
  return { panes, seps };
}

/** key 's/0/2' → path [0, 2]（相对 root；含本 split 自身的孩子索引）。 */
function pathOf(key: string): number[] {
  return key.split('/').slice(1).map(Number);
}

// ---------------------------------------------------------------------------
// 序列化（localStorage 快照用）。
// ---------------------------------------------------------------------------

export const PANE_LAYOUT_SCHEMA = 1;

export function encodeLayout(node: LayoutNode): string {
  return JSON.stringify({ v: PANE_LAYOUT_SCHEMA, node });
}

export function decodeLayout(raw: string | null): LayoutNode | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: number; node?: LayoutNode };
    if (parsed.v !== PANE_LAYOUT_SCHEMA || !parsed.node) return null;
    return validNode(parsed.node) ? parsed.node : null;
  } catch {
    return null;
  }
}

function validNode(node: unknown): node is LayoutNode {
  if (typeof node !== 'object' || node === null) return false;
  const n = node as Record<string, unknown>;
  if (n.kind === 'pane') return typeof n.paneId === 'string';
  if (n.kind !== 'split') return false;
  if (n.dir !== 'row' && n.dir !== 'col') return false;
  if (!Array.isArray(n.children) || n.children.length < 2) return false;
  return n.children.every(validNode);
}
