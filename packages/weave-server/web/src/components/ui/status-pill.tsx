import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * 状态 pill（SkillGrid「已生效 x/y」那款的通用版）：**绿 = 全部生效 / 琥珀 = 部分 /
 * 灰 = 空**。折叠条与分组标题统一用它，别再各写一套配色。
 */

export type StatusTone = 'ok' | 'partial' | 'none';

/** 由 (完成, 总数) 得配色档：空集给灰（"没有可计数的"）。 */
export function statusTone(done: number, total: number): StatusTone {
  if (total === 0) return 'none';
  return done === total ? 'ok' : 'partial';
}

const TONE: Record<StatusTone, string> = {
  ok: 'bg-emerald-900/40 text-emerald-300',
  partial: 'bg-amber-900/30 text-amber-300',
  none: 'bg-neutral-800 text-neutral-500',
};

export function StatusPill({
  tone,
  title,
  children,
}: {
  tone: StatusTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums',
        TONE[tone],
      )}
      title={title}
    >
      {children}
    </span>
  );
}
