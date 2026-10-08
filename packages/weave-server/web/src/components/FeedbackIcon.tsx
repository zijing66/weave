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
  if (state === 'loading') return <Loader2 className={cn('animate-spin', className)} />;
  if (state === 'success') return <Check className={cn('text-emerald-400', className)} />;
  return <>{icon ?? null}</>;
}
