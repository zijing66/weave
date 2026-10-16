/**
 * 拉动加载：贴边**不**加载，贴边后继续滚/拖才加载——「刚摸到边」是浏览到头的
 * 自然结果，不该顺手多拉一页。闸是纯函数（`createPullGate`），钩子只负责把滚轮
 * 与触摸的位移喂进去、把位移暴露给指示器。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type PullAxis = 'top' | 'bottom';

/** 越界拉动多远算「要更多」（两种输入共用同一门槛）。 */
export const PULL_FIRE_PX = 120;

/** 单次事件的位移上限：滚轮一格常有几百像素，按原值累积一拉就爆。 */
const STEP_MAX_PX = 40;

/** 手势停下（滚轮没有结束事件）后指示器收回去的时间。 */
const DECAY_MS = 500;

/** 滚轮增量 → 越界拉动像素（朝更早/更晚那头为正；反向归 0）。 */
export function wheelPull(deltaY: number, deltaMode: number, axis: PullAxis): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaY;
  const pull = axis === 'top' ? -px : px;
  return Math.max(0, Math.min(STEP_MAX_PX, pull));
}

/** 触摸位移（正 = 手指往下）→ 越界拉动像素。 */
export function touchPull(dy: number, axis: PullAxis): number {
  const pull = axis === 'top' ? dy : -dy;
  return Math.max(0, Math.min(STEP_MAX_PX, pull));
}

export interface PullGate {
  /** 边缘状态（false = 离开边缘：清零、允许下一次再放行）。 */
  setEdge(atEdge: boolean): void;
  /** 累积一次越界拉动，返回当前位移与是否放行。 */
  add(px: number): { value: number; fired: boolean };
  reset(): void;
}

export function createPullGate(threshold = PULL_FIRE_PX): PullGate {
  let acc = 0;
  let atEdge = false;
  /** 同一段贴边里放过一次就不再放（继续拉不重复加载；离边即重新武装）。 */
  let armed = false;
  return {
    setEdge(next) {
      atEdge = next;
      if (!next) {
        acc = 0;
        armed = false;
      }
    },
    add(px) {
      if (!atEdge || px <= 0) return { value: acc, fired: false };
      acc += px;
      if (armed || acc < threshold) return { value: acc, fired: false };
      armed = true;
      acc = 0;
      return { value: 0, fired: true };
    },
    reset() {
      acc = 0;
      armed = false;
    },
  };
}

export interface PullLoadHandlers {
  /** 滚动时同步边缘状态（离边清零、可再次放行）。 */
  syncEdge: () => void;
  wheel: (deltaY: number, deltaMode: number) => void;
  touchStart: (y: number) => void;
  touchMove: (y: number) => void;
  touchEnd: () => void;
}

export interface PullLoadOpts {
  axis: PullAxis;
  /** 此刻是否贴在那头上：每次事件现算（贴边看的是容器当下的位置）。 */
  getEdge: () => boolean;
  onFire: () => void;
  /** 比如「已经翻到头」「正在加载」——关掉时不累积也不显示位移。 */
  enabled?: boolean;
}

export function usePullLoad(opts: PullLoadOpts): PullLoadHandlers & { px: number } {
  const [px, setPx] = useState(0);
  const gate = useRef<PullGate>(createPullGate());
  const lastY = useRef<number | null>(null);
  const decay = useRef<number | null>(null);
  // 每次渲染刷新：省掉把回调塞进依赖里（事件是按 DOM 绑的，不需要重挂）
  const live = useRef(opts);
  live.current = opts;

  const collapse = useCallback((): void => {
    if (decay.current !== null) {
      window.clearTimeout(decay.current);
      decay.current = null;
    }
    gate.current.reset();
    setPx(0);
  }, []);

  const step = useCallback(
    (amount: number): void => {
      if (!live.current.enabled) return;
      if (amount <= 0) return;
      const g = gate.current;
      g.setEdge(live.current.getEdge());
      const r = g.add(amount);
      if (r.fired) {
        collapse();
        live.current.onFire();
        return;
      }
      setPx(r.value);
      if (decay.current !== null) window.clearTimeout(decay.current);
      decay.current = window.setTimeout(collapse, DECAY_MS);
    },
    [collapse],
  );

  const touchMove = useCallback(
    (y: number): void => {
      const prev = lastY.current;
      lastY.current = y;
      if (prev === null) return;
      step(touchPull(y - prev, live.current.axis));
    },
    [step],
  );

  // 关掉（翻到头 / 正在加载）时把手上的位移一并收掉，别留一条挂着的空隙
  useEffect(() => {
    if (!opts.enabled) collapse();
  }, [opts.enabled, collapse]);

  return {
    px,
    syncEdge: useCallback((): void => gate.current.setEdge(live.current.getEdge()), []),
    wheel: useCallback(
      (deltaY: number, deltaMode: number): void =>
        step(wheelPull(deltaY, deltaMode, live.current.axis)),
      [step],
    ),
    touchStart: useCallback((y: number): void => {
      lastY.current = y;
    }, []),
    touchMove,
    touchEnd: useCallback((): void => {
      lastY.current = null;
      collapse();
    }, [collapse]),
  };
}
