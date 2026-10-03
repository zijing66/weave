import { type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const variants: Record<string, string> = {
  default: 'bg-neutral-800 text-neutral-100',
  skill: 'bg-blue-900/40 text-blue-300',
  command: 'bg-purple-900/40 text-purple-300',
  agent: 'bg-emerald-900/40 text-emerald-300',
  helper: 'bg-amber-900/40 text-amber-300',
  mcp: 'bg-pink-900/40 text-pink-300',
  settings: 'bg-cyan-900/40 text-cyan-300',
  warning: 'bg-orange-900/40 text-orange-300',
  other: 'bg-neutral-800 text-neutral-400',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: string;
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tracking-tight',
        variants[variant] ?? variants.default,
        className,
      )}
      {...props}
    />
  );
}
