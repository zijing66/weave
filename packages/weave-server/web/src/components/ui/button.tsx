import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const variants = {
  default: 'bg-neutral-100 text-neutral-900 hover:bg-neutral-200',
  outline: 'border border-neutral-700 text-neutral-100 hover:bg-neutral-800',
  ghost: 'text-neutral-100 hover:bg-neutral-800',
} as const;

const sizes = {
  default: 'h-8 px-3 text-sm',
  sm: 'h-7 px-2 text-xs',
  icon: 'h-8 w-8',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition-all duration-200 ease-mac focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mac-accent/50 disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
