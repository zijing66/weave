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
        // 卡片元信息层基准 = text-10：徽标与旁边的时刻/计数同级，不再大一号
        'inline-flex items-center rounded-full px-1.5 py-0.5 text-10 font-medium tracking-tight',
        variants[variant] ?? variants.default,
        className,
      )}
      {...props}
    />
  );
}
