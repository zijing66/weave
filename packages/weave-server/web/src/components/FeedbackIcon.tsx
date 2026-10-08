import { Check, Loader2 } from 'lucide-react';
import type { ActionState } from '../lib/action-feedback';
import { cn } from '../lib/utils';

/**
 * 按钮图标的三态呈现（统一反馈的唯一落点）：loading 转圈 → success 打勾（保持
 * 2s）→ 还原原图标。所有按钮都走这里，避免每个按钮各写一遍三态判断。
 */
export function FeedbackIcon({
  state,
  icon,
  className,
}: {
  state: ActionState;
  /** 静止态的图标；纯文字按钮（如顶栏 pill）可省略。 */
  icon?: React.ReactNode;
  className?: string;
}) {
  // pointer-events-none：图标是一块独立的 SVG 盒子，光标落在它上面时它就是 hover
  // 目标——某些引擎下按钮的 title 不会回退显示。让图标对指针透明，按钮任意位置的
  // 目标都只有一个（按钮本身），tooltip/点击/悬停样式才一致。
  return (
    <span className="pointer-events-none inline-flex items-center">
      {state === 'loading' ? (
        <Loader2 className={cn('animate-spin', className)} />
      ) : state === 'success' ? (
        <Check className={cn('text-emerald-400', className)} />
      ) : (
        (icon ?? null)
      )}
    </span>
  );
}
