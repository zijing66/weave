/**
 * 移动端返回键/侧滑的弹层劫持：打开时压一枚带标记的历史记录，`popstate` 到来
 * 先作用于弹层自己（`onBack`），退完了才落回路由——URL 恒不动，路由返回原样。
 *
 * 多层叠加走**栈**：后挂的先退（返回键永远先归最上层）。栈非空时返回一律归栈
 * 顶、不看落点条目带不带标记——守卫压在当前位置**上方**，生产单次挂载下返回
 * 的落点是它下面那条无标记的路由条目（dev 的 StrictMode 双挂载才会恰好落在
 * 守卫上）。`onBack` 返回 false = 这次返回被消费但层没退完（如文件选择器还有
 * 上一级），钩子再压一枚补位，让下一次返回继续归它；返回 true = 层已退完，
 * 这枚历史记录就此消费。
 *
 * StrictMode 双挂载：effect 跑两遍，栈里始终只留一枚（卸载不 back，见 cleanup）。
 */
import { useEffect, useRef } from 'react';

export const BACK_POP_MARK = 'weaveBackPop';

type OnBack = () => boolean;

/**
 * 栈的 popstate 处理（与 window/history 解耦，纯逻辑可测）：栈非空时返回先归
 * 最上层（不看落点条目带不带标记，理由见文件头）；`onBack` 返回 false = 层没
 * 退完，压一枚补位让下一次返回继续归它。
 */
export function createBackPopStack(push: (state: Record<string, unknown>) => void) {
  const stack: { onBack: OnBack }[] = [];
  return {
    /** 挂一层（弹层打开时）：返回栈里的那枚（卸载时原样交回 `unmount`）。 */
    mount(onBack: OnBack): { onBack: OnBack } {
      const entry = { onBack };
      stack.push(entry);
      push({ [BACK_POP_MARK]: true });
      return entry;
    },
    /** 卸一层（弹层关闭时）。`owned` = 它压的那枚还没被 popstate 消费（要退回去）。 */
    unmount(entry: { onBack: OnBack }): boolean {
      const at = stack.indexOf(entry);
      if (at < 0) return false;
      stack.splice(at, 1);
      return true;
    },
    /** popstate 到来：返回 `'consumed'`（层退完）/ `'pushed'`（补了位）/ `'ignored'`。 */
    pop(_state: unknown): 'consumed' | 'pushed' | 'ignored' {
      const top = stack[stack.length - 1];
      if (!top) return 'ignored';
      if (top.onBack()) {
        // 层退完：出栈（这枚历史记录就此消费，组件的 cleanup 不再退它）
        stack.pop();
        return 'consumed';
      }
      push({ [BACK_POP_MARK]: true });
      return 'pushed';
    },
  };
}

/** 全站共用的那一具栈（模块级：多层弹窗跨组件叠加靠它排先后）。 */
const shared = createBackPopStack((state) => history.pushState(state, ''));

/** 挂一层：`active` 为 false 时不压历史（弹层关着）。 */
export function useBackPop(active: boolean, onBack: () => boolean): void {
  const cb = useRef(onBack);
  cb.current = onBack;
  useEffect(() => {
    if (!active) return;
    const entry = shared.mount(() => cb.current());
    const onPop = (e: PopStateEvent): void => {
      shared.pop(e.state);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // 卸载时**不 history.back()**：back 是异步的，会与紧接着的 pushState 竞态
      // （StrictMode 双挂载、快速关了再开，都会让迟到的 popstate 打到新层头上
      // ——表现为「弹层一打开就被返回关掉」）。留下的那枚标记条目无害：下一次
      // 返回落在它上面时由栈顶层照常消费（关下一层）；层都关光了就是一次同
      // URL 的空 popstate，路由侧 setPath 同值早退，用户无感。
      shared.unmount(entry);
    };
  }, [active]);
}
