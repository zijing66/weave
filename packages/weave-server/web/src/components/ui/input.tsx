import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * 统一文本输入框：bg-neutral-900 + border-edge 底、聚焦 mac-accent 描边——
 * 与 combobox 的触发钮同一套语言。裸 input 的浏览器默认聚焦 outline（黑框）
 * 与主题不搭，聚焦样式一律走这里。
 */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    const { className, ...rest } = props;
    return (
      <input
        ref={ref}
        {...rest}
        className={cn(
          'min-w-0 rounded-md border border-edge/[0.08] bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-mac-accent/50 disabled:opacity-40',
          className,
        )}
      />
    );
  },
);
