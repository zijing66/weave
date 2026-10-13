import { Badge } from '@/components/ui/badge';
import type { AssetAgent } from '@/lib/api';
import { harnessUiOf } from '@/lib/harness-meta';
import { cn } from '@/lib/utils';

/**
 * Which runtime an asset belongs to, shown on every card that can hold either
 * agent's copy.
 *
 * Colour comes from the single harness-meta table (claude = orange, codex = cyan,
 * unknown = neutral) so one hue means one agent everywhere; the label is the raw
 * harness id. A row with no agent renders nothing — the surface is a server fact,
 * the client does not guess one.
 */
export function AgentBadge({ agent, className }: { agent?: AssetAgent; className?: string }) {
  if (!agent) return null;
  return (
    <Badge className={cn('shrink-0', harnessUiOf(agent).badge, className)}>{agent}</Badge>
  );
}
