import { describe, expect, it } from 'vitest';
import {
  MAX_PANES,
  adjustWeights,
  decodeLayout,
  encodeLayout,
  layoutGeometry,
  paneCount,
  paneIdsOf,
  placePane,
  removePane,
  type LayoutNode,
} from '../pane-layout';

const leaf = (id: string): LayoutNode => ({ kind: 'pane', paneId: id });

describe('placePane（落点插入）', () => {
  it('单 pane 右侧插入 → row split', () => {
    const next = placePane(leaf('a'), 'a', null, 'right', 'b');
    expect(next).toEqual({
      kind: 'split',
      dir: 'row',
      children: [leaf('a'), expect.objectContaining({ kind: 'pane' })],
      weights: [0.5, 0.5],
    });
  });

  it('下方插入 → col split', () => {
    const next = placePane(leaf('a'), 'a', null, 'bottom')!;
    expect(next.kind).toBe('split');
    expect((next as { dir: string }).dir).toBe('col');
    expect(paneCount(next)).toBe(2);
  });

  it('超上限拒绝（返回原判断点之前）', () => {
    let node: LayoutNode = leaf('p0');
    for (let i = 1; i < MAX_PANES; i++) node = placePane(node, 'p0', null, 'right')!;
    expect(paneCount(node)).toBe(MAX_PANES);
    expect(placePane(node, 'p0', null, 'right')).toBeNull();
    // 移动不增数：同窗内重排不受上限约束（drag ≠ target）
    const last = paneIdsOf(node).at(-1)!;
    expect(placePane(node, 'p0', last, 'right')).not.toBeNull();
  });

  it('同向且 target 在边缘 → 并进父层（孩子数 +1 而不是嵌套）', () => {
    const two = placePane(leaf('a'), 'a', null, 'right', 'b')!;
    // 在 b 的右侧再插：应并入同一层
    const three = placePane(two, 'b', null, 'right', 'c')!;
    expect(three.kind).toBe('split');
    expect((three as { children: LayoutNode[] }).children.length).toBe(3);
    expect(paneIdsOf(three).length).toBe(3);
  });

  it('移动：drag 已在树里 → 先删后插，数量不变', () => {
    // a | b 横排 → 把 a 挪到 b 下方
    const two = placePane(leaf('a'), 'a', null, 'right', 'b')!;
    const next = placePane(two, 'b', 'a', 'bottom')!;
    expect(paneCount(next)).toBe(2);
    expect(paneIdsOf(next).sort()).toEqual(['a', 'b']);
    // b 在 row 层只有一个 pane、a 在下方 → 结构应是 col(b, a)
    expect(next).toMatchObject({ kind: 'split', dir: 'col', children: [leaf('b'), leaf('a')] });
  });

  it('center = 交换位置', () => {
    const two = placePane(leaf('a'), 'a', null, 'right', 'b')!;
    const swapped = placePane(two, 'b', 'a', 'center')!;
    expect(swapped).toMatchObject({ kind: 'split', dir: 'row', children: [leaf('b'), leaf('a')] });
  });

  it('target 不在树里 → null', () => {
    expect(placePane(leaf('a'), 'zz', null, 'right')).toBeNull();
  });
});

describe('removePane（删除与清理）', () => {
  it('删到单 pane 时提升、删空返回 null', () => {
    const two = placePane(leaf('a'), 'a', null, 'right', 'b')!;
    expect(removePane(two, 'b')).toEqual(leaf('a'));
    expect(removePane(leaf('a'), 'a')).toBeNull();
  });

  it('删中间孩子：权重归一并保留其余', () => {
    let node: LayoutNode = leaf('a');
    node = placePane(node, 'a', null, 'right', 'b')!;
    node = placePane(node, 'b', null, 'right')!;
    const after = removePane(node, 'b')!;
    expect(paneIdsOf(after)).toEqual(['a', expect.any(String)]);
    const weights = (after as { weights: number[] }).weights;
    expect(weights.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });
});

describe('adjustWeights / layoutGeometry', () => {
  const two = placePane(leaf('a'), 'a', null, 'right', 'b')!;

  it('矩形覆盖全容器且互不重叠', () => {
    const g = layoutGeometry(two);
    expect(g.panes).toHaveLength(2);
    expect(g.seps).toHaveLength(1);
    expect(g.panes.reduce((s, p) => s + p.w * p.h, 0)).toBeCloseTo(1);
    const [a, b] = [...g.panes].sort((p, q) => p.x - q.x);
    expect(a.w).toBeCloseTo(0.5);
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.w - 0.001);
  });

  it('分隔条 path/index 指向本 split，拖动改相邻两档', () => {
    const g = layoutGeometry(two);
    const sep = g.seps[0]!;
    expect(sep.path).toEqual([]);
    expect(sep.index).toBe(0);
    const moved = adjustWeights(two, sep.path, sep.index, 0.2)!;
    const weights = (moved as { weights: number[] }).weights;
    expect(weights[0]).toBeCloseTo(0.7);
    expect(weights[1]).toBeCloseTo(0.3);
  });

  it('钳制：不给压死任何一侧', () => {
    const moved = adjustWeights(two, [], 0, 10)!;
    const weights = (moved as { weights: number[] }).weights;
    expect(weights[1]).toBeGreaterThan(0);
    expect(weights[0]).toBeLessThan(1);
  });
});

describe('序列化', () => {
  it('roundtrip', () => {
    let node: LayoutNode = leaf('a');
    node = placePane(node, 'a', null, 'right', 'b')!;
    node = placePane(node, 'a', null, 'bottom')!;
    expect(decodeLayout(encodeLayout(node))).toEqual(node);
  });

  it('坏输入返回 null', () => {
    expect(decodeLayout(null)).toBeNull();
    expect(decodeLayout('not json')).toBeNull();
    expect(decodeLayout('{"v":99,"node":{"kind":"pane","paneId":"a"}}')).toBeNull();
    expect(decodeLayout('{"v":1,"node":{"kind":"split","dir":"row","children":[]}}')).toBeNull();
  });
});
