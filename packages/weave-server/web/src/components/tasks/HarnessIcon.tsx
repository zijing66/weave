import { Asterisk, Hexagon, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * harness 图标：claude = 星芒、codex = 六边形（各 harness 一套形态），harness
 * 未知回退通用 spinner 形。running = 动效（index.css harness-run-*，即跑马灯）；
 * 非 running = 同形静态暗色——「有打开的会话」用它，与动效形成开/跑对照。
 */
export function HarnessIcon({
  harness,
  running = false,
  className,
}: {
  harness?: 'claude' | 'codex' | null;
  running?: boolean;
  className?: string;
}) {
  if (harness === 'codex') {
    return (
      <span className={cn('inline-flex shrink-0', running && 'harness-run-codex', className)}>
        <Hexagon className={cn('h-3.5 w-3.5', running ? 'text-cyan-400' : 'text-cyan-400/45')} />
      </span>
    );
  }
  if (harness === 'claude') {
    return (
      <span className={cn('inline-flex shrink-0', running && 'harness-run-claude', className)}>
        <Asterisk className={cn('h-3.5 w-3.5', running ? 'text-orange-400' : 'text-orange-400/45')} />
      </span>
    );
  }
  return (
    <Loader2
      className={cn(
        'h-3.5 w-3.5 shrink-0',
        running ? 'animate-spin text-orange-400' : 'text-neutral-500',
        className,
      )}
    />
  );
}
