import { Loader2 } from 'lucide-react';
import type { Harness } from '@weavecode/core/harness';
import { HARNESS_UI, harnessUiOf } from '@/lib/harness-meta';
import { cn } from '@/lib/utils';

/**
 * harness 图标：形状 / 配色 / 跑马灯动效全来自 harness-meta 单点表，未知 harness
 * 回落通用 spinner。running = 动效（index.css harness-run-*，即跑马灯）；非 running
 * = 同形静态暗色——「有打开的会话」用它，与动效形成开/跑对照。
 */
export function HarnessIcon({
  harness,
  running = false,
  className,
}: {
  harness?: Harness | null;
  running?: boolean;
  className?: string;
}) {
  if (harness && harness in HARNESS_UI) {
    const ui = HARNESS_UI[harness];
    const Icon = ui.icon;
    return (
      <span className={cn('inline-flex shrink-0', running && ui.runAnimation, className)}>
        <Icon className={cn('h-3.5 w-3.5', running ? ui.iconRunning : ui.iconIdle)} />
      </span>
    );
  }
  // 未知 harness（含 null/undefined）：通用 spinner，沿用旧回落配色（行为不变）。
  const fallback = harnessUiOf(null);
  return (
    <Loader2
      className={cn(
        'h-3.5 w-3.5 shrink-0',
        running ? 'animate-spin text-orange-400' : fallback.iconIdle,
        className,
      )}
    />
  );
}
