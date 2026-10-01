import { Badge } from '@/components/ui/badge';
import type { AssetAgent } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Which runtime an asset belongs to, shown on every card that can hold either
 * agent's copy.
 *
 * Both are rendered explicitly, in the Tasks panel's source-tag colours
 * (claude = orange, codex = cyan) so one hue means one agent everywhere.
 *
 * The cards used to badge only Codex, which left
 * "this is Claude's" implicit — invisible until you noticed a Codex entry was
 * the one that looked different.
 */
export function AgentBadge({ agent, className }: { agent?: AssetAgent; className?: string }) {
  const codex = agent === 'codex';
  return (
    <Badge
      className={cn(
        'shrink-0',
        codex
          ? 'border-cyan-800/50 bg-cyan-900/40 text-cyan-300'
          : 'border-orange-800/50 bg-orange-900/40 text-orange-300',
        className,
      )}
    >
      {codex ? 'codex' : 'claude'}
    </Badge>
  );
}
