import { describe, expect, it } from 'vitest';
import { commitOf, indexOf, labelVisible } from '../enum-slider-core';

/**
 * 离散档位 slider 的纯逻辑回归（web 侧没有 jsdom/RTL，组件不测、逻辑抽出来——
 * 先例：feedback-core）。
 */
describe('commitOf（提交裁决）', () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('值没变不提交（拖回原位松手不该给宿主打命令）', () => {
    expect(commitOf(levels, 'low', 0)).toBeNull();
    expect(commitOf(levels, 'high', 2)).toBeNull();
  });

  it('值变了给目标档位；越界钳回词表内', () => {
    expect(commitOf(levels, 'low', 2)).toBe('high');
    // 钳回后与当前值相同 = 没变（拖出下界回到原位）
    expect(commitOf(levels, 'low', -1)).toBeNull();
    expect(commitOf(levels, 'low', 99)).toBe('max');
  });

  it('空词表不提交；value 为 null 时第一档也算变更（用户特意拨过去的）', () => {
    expect(commitOf([], 'low', 1)).toBeNull();
    expect(commitOf(levels, null, 0)).toBe('low');
    expect(commitOf(levels, null, 2)).toBe('high');
  });
});

describe('indexOf（选中索引）', () => {
  const levels = ['low', 'medium', 'high'];

  it('在词表内取位次；不在（含 null）停第一档', () => {
    expect(indexOf(levels, 'medium')).toBe(1);
    expect(indexOf(levels, 'ultra')).toBe(0);
    expect(indexOf(levels, null)).toBe(0);
  });
});

describe('labelVisible（刻度文字可见性）', () => {
  it('只显示当前档相邻的两档（|i - shown| ≤ 1），远档只留刻度点', () => {
    expect(labelVisible(2, 1)).toBe(true);
    expect(labelVisible(2, 2)).toBe(true);
    expect(labelVisible(2, 3)).toBe(true);
    expect(labelVisible(2, 0)).toBe(false);
    expect(labelVisible(2, 4)).toBe(false);
    // 边界档：只有一侧有邻居
    expect(labelVisible(0, 1)).toBe(true);
    expect(labelVisible(0, 2)).toBe(false);
  });
});
