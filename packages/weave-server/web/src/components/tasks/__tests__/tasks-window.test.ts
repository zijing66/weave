import { describe, it, expect } from 'vitest';
import { windowGroups } from '../TasksPanel';
import type { LifecycleGroup } from '../build-lifecycle-groups';

/** 只用到 id，其余字段与窗口选择无关。 */
const g = (id: string): LifecycleGroup => ({ id }) as unknown as LifecycleGroup;
const all = ['t1', 't2', 't3', 't4'].map(g);
const ids = (list: readonly LifecycleGroup[]): string[] => list.map((x) => x.id);

describe('windowGroups（折叠条渲染窗口）', () => {
  it('没有展开组 = 最新 size 组', () => {
    expect(ids(windowGroups(all, 2, ''))).toEqual(['t3', 't4']);
  });

  it('展开组被新组挤出窗口 → 窗口往前扩到它（画布不随行卸载）', () => {
    expect(ids(windowGroups(all, 2, 't2'))).toEqual(['t2', 't3', 't4']);
  });

  it('展开组本来就在窗口里 → 窗口不变', () => {
    expect(ids(windowGroups(all, 3, 't3'))).toEqual(['t2', 't3', 't4']);
  });

  it('展开组已不在组表里（滚出事件窗口）→ 回落最新 size 组', () => {
    expect(ids(windowGroups(all, 2, 'gone'))).toEqual(['t3', 't4']);
  });
});
