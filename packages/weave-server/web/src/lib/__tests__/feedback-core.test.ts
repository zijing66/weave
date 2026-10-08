import { describe, it, expect } from 'vitest';
import {
  SUCCESS_HOLD_MS,
  TOAST_HOLD_MS,
  addToast,
  reduceActionState,
  removeToast,
  type ToastItem,
} from '../feedback-core';

/**
 * 反馈层的纯逻辑回归：按钮三态状态机 + toast 队列规则。
 * （组件本身不测——web 侧没有 jsdom/RTL，纯逻辑一律抽到 feedback-core。）
 */

describe('按钮反馈状态机', () => {
  it('idle → loading → success，成功保持 2s 后由调用方复原', () => {
    const loading = reduceActionState('idle', 'start');
    expect(loading).toBe('loading');
    expect(reduceActionState(loading, 'ok')).toBe('success');
    expect(SUCCESS_HOLD_MS).toBe(2_000);
  });

  it('失败直接回 idle（错误不在按钮上停留，走 toast）', () => {
    expect(reduceActionState('loading', 'fail')).toBe('idle');
  });

  it('迟到/重复的结果不改变状态', () => {
    expect(reduceActionState('success', 'ok')).toBe('success');
    expect(reduceActionState('success', 'fail')).toBe('success');
    expect(reduceActionState('idle', 'ok')).toBe('idle');
    expect(reduceActionState('idle', 'fail')).toBe('idle');
  });
});

describe('toast 队列', () => {
  const item = (id: number): ToastItem => ({ id, kind: 'info', message: `m${id}` });

  it('追加保序 + 按 id 移除；删不存在的 id 是空操作', () => {
    let list: ToastItem[] = [];
    list = addToast(list, item(1));
    list = addToast(list, item(2));
    expect(list.map((t) => t.id)).toEqual([1, 2]);

    list = removeToast(list, 1);
    expect(list.map((t) => t.id)).toEqual([2]);
    expect(removeToast(list, 99)).toEqual(list);
  });

  it('错误停留比成功久（要看清）', () => {
    expect(TOAST_HOLD_MS.error).toBeGreaterThan(TOAST_HOLD_MS.success);
  });
});
