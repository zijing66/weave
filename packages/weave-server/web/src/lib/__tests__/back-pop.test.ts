import { describe, expect, it, vi } from 'vitest';
import { BACK_POP_MARK, createBackPopStack } from '../back-pop';

/**
 * 返回劫持的栈语义（`createBackPopStack`，与 window/history 解耦的纯逻辑）：
 * 只认带标记的 state、后挂的先退、false 补位、true 消费、卸载归还。
 */
describe('createBackPopStack', () => {
  const make = () => {
    const pushes: Record<string, unknown>[] = [];
    const stack = createBackPopStack((state) => pushes.push(state));
    return { stack, pushes };
  };
  const marked = (): Record<string, unknown> => ({ [BACK_POP_MARK]: true });

  it('① 不带标记的 state（路由自己的）= ignored，不惊动弹层', () => {
    const { stack } = make();
    const onBack = vi.fn(() => true);
    stack.mount(onBack);
    expect(stack.pop({ someRoute: 1 })).toBe('ignored');
    expect(stack.pop(null)).toBe('ignored');
    expect(stack.pop(undefined)).toBe('ignored');
    expect(onBack).not.toHaveBeenCalled();
  });

  it('② onBack 返回 true = consumed（层退完，历史记录就此消费）', () => {
    const { stack, pushes } = make();
    const onBack = vi.fn(() => true);
    stack.mount(onBack);
    expect(pushes).toHaveLength(1);
    expect(stack.pop(marked())).toBe('consumed');
    expect(onBack).toHaveBeenCalledTimes(1);
    // 不补位
    expect(pushes).toHaveLength(1);
  });

  it('③ onBack 返回 false = pushed（补一枚，返回键下一次继续归它）', () => {
    const { stack, pushes } = make();
    let done = false;
    stack.mount(() => done);
    expect(stack.pop(marked())).toBe('pushed');
    expect(pushes).toHaveLength(2);
    // 补位之后再按返回：这次层退完了
    done = true;
    expect(stack.pop(marked())).toBe('consumed');
    expect(pushes).toHaveLength(2);
  });

  it('④ 两层叠加：后挂的先退，退完才轮到先挂的', () => {
    const { stack } = make();
    const outer = vi.fn(() => true);
    const inner = vi.fn(() => true);
    stack.mount(outer);
    stack.mount(inner);
    expect(stack.pop(marked())).toBe('consumed');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    expect(stack.pop(marked())).toBe('consumed');
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('⑤ 空栈时带标记也 ignored（弹层都已关，返回落回路由）', () => {
    const { stack } = make();
    expect(stack.pop(marked())).toBe('ignored');
  });

  it('⑥ 卸载：在栈里摘掉、不在栈里幂等（卸载不 back，竞态类不存在）', () => {
    const { stack } = make();
    const entry = stack.mount(() => true);
    expect(stack.unmount(entry)).toBe(true);
    // 再卸一次（已不在栈里）：幂等
    expect(stack.unmount(entry)).toBe(false);
    // 卸载后带标记的返回落空（栈空 = ignored，路由照常）
    expect(stack.pop(marked())).toBe('ignored');
  });
});
