/**
 * 离散档位 slider 的纯逻辑（web 侧没有 jsdom/RTL，组件不测、逻辑抽出来——
 * 先例：feedback-core）。
 */

/**
 * 拖动/键盘改档后的提交裁决：`next` 是 slider 的目标索引。**值没变不提交**
 * （拖回原位松手不该给宿主打命令）；越界钳回词表内。返回要提交的档位，null =
 * 不提交。
 */
export function commitOf(levels: readonly string[], value: string | null, next: number): string | null {
  if (levels.length === 0) return null;
  const clamped = Math.min(levels.length - 1, Math.max(0, next));
  const level = levels[clamped]!;
  return level === value ? null : level;
}

/** 当前选中索引（value 不在词表内 = 没有选中态，滑块停第一档）。 */
export function indexOf(levels: readonly string[], value: string | null): number {
  return Math.max(0, levels.indexOf(value ?? ''));
}

/**
 * 刻度文字的可见性：**只显示当前档相邻的两档**（i ∈ [shown-1, shown+1]）——
 * 五个档名一字排开放不进控制行，挤在一起反而读不清；远档只留刻度点。
 */
export function labelVisible(shown: number, i: number): boolean {
  return Math.abs(i - shown) <= 1;
}
