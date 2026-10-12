/**
 * 前端反馈的纯逻辑（不含 React/JSX）：toast 队列规则 + 按钮三态状态机。
 * 单独成模块是为了能被纯 TS 测试直接引用——web 侧测试基建没有 jsdom/RTL，
 * 组件文件一律不进测试。
 */

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

/** 追加保序。 */
export function addToast(list: ToastItem[], item: ToastItem): ToastItem[] {
  return [...list, item];
}

/** 按 id 移除（手动关 / 自动到时）。 */
export function removeToast(list: ToastItem[], id: number): ToastItem[] {
  return list.filter((t) => t.id !== id);
}

/** 停留时长：错误留久一点（要看清），成功短一点。 */
export const TOAST_HOLD_MS: Record<ToastKind, number> = {
  success: 3_000,
  info: 4_000,
  error: 8_000,
};

/** 按钮反馈三态：idle → loading → success（保持 2s）→ idle。失败直接回 idle。 */
export type ActionState = 'idle' | 'loading' | 'success';

export const SUCCESS_HOLD_MS = 2_000;

/** 纯状态机：迟到/重复的结果不改变状态（只有 loading 态会被推进）。 */
export function reduceActionState(current: ActionState, event: 'start' | 'ok' | 'fail'): ActionState {
  if (event === 'start') return 'loading';
  if (current !== 'loading') return current;
  return event === 'ok' ? 'success' : 'idle';
}

/** 连点去重：loading 在途中的动作不接受新触发（success 停留期允许再次启动）。 */
export function canStartAction(current: ActionState): boolean {
  return current !== 'loading';
}
