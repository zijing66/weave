import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import {
  FileCode,
  Server,
  Terminal,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

export type MainCategory = 'skills' | 'mcp' | 'commands' | 'personalization';

export const MAIN_CATEGORIES: {
  key: MainCategory;
  /** Dict key for the card label — module scope can't call hooks. */
  labelKey: MessageKey;
  icon: LucideIcon;
}[] = [
  { key: 'skills', labelKey: 'catbar.skills', icon: FileCode },
  { key: 'mcp', labelKey: 'catbar.mcp', icon: Server },
  // The count on this card is every project asset that is not a skill or MCP
  // (instructions, file assets, settings, helpers …), so the label says 文件
  // 资产 rather than implying it counts commands alone.
  { key: 'commands', labelKey: 'catbar.commands', icon: Terminal },
  { key: 'personalization', labelKey: 'catbar.personalization', icon: Sparkles },
];

export interface CategoryBarData {
  /** Installed skill count (project + global). */
  skills: number;
  /** MCP server count (project + global). */
  mcp: number;
  /** Commands + agents + helpers + settings + other file count. */
  commands: number;
  /** Number of outdated skills (update hint badge). */
  outdatedSkills: number;
  /** Number of outdated MCP servers. */
  outdatedMcp: number;
  /** Statusline source; null while not loaded (Claude card badge). */
  statuslineSource: 'global' | 'custom' | null;
}

export function CategoryBar({
  category,
  onSelect,
  data,
}: {
  category: MainCategory;
  onSelect: (c: MainCategory) => void;
  data: CategoryBarData;
}) {
  const t = useT();
  const countFor = (c: MainCategory): number => {
    switch (c) {
      case 'skills':
        return data.skills;
      case 'mcp':
        return data.mcp;
      case 'commands':
        return data.commands;
      case 'personalization':
        return 1; // the Claude statusline config is always present
    }
  };

  const badgeFor = (c: MainCategory): ReactNode => {
    switch (c) {
      case 'skills':
        return data.outdatedSkills > 0 ? (
          <Badge variant="warning">{t('catbar.updateBadge', { n: data.outdatedSkills })}</Badge>
        ) : null;
      case 'mcp':
        return data.outdatedMcp > 0 ? (
          <Badge variant="warning">{t('catbar.updateBadge', { n: data.outdatedMcp })}</Badge>
        ) : null;
      case 'personalization':
        return data.statuslineSource ? (
          <Badge variant={data.statuslineSource === 'custom' ? 'skill' : 'default'}>
            {data.statuslineSource === 'custom' ? t('catbar.custom') : t('catbar.followGlobal')}
          </Badge>
        ) : null;
      default:
        return null;
    }
  };

  return (
    // One row of cards, always. Each card keeps a sane minimum width; when the
    // row can no longer fit them all it scrolls sideways rather than squeezing
    // every card down to a width where its content collides.
    <div className="flex gap-2 p-2 border-b border-white/[0.06] overflow-x-auto">
      {MAIN_CATEGORIES.map(({ key, labelKey, icon: Icon }) => {
        const active = category === key;
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={cn(
              // flex-wrap keeps the card's own contents on one line when there
              // is room and lets them flow onto a second one when there is not
              // — the personalization card carries two badges, which would
              // otherwise collide with its label. The floor is low enough that
              // wrapping happens before the row has to scroll.
              'flex-1 min-w-[9rem] flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2.5 py-2 text-left',
              'border border-white/[0.08] transition-all duration-200 ease-mac',
              active
                ? 'bg-neutral-800/90 ring-1 ring-blue-500/50 shadow-mac-sm'
                : 'bg-neutral-900/40 hover:bg-neutral-800/60',
            )}
          >
            <Icon
              className={cn(
                'h-4 w-4 shrink-0',
                key === 'skills' && 'text-emerald-400',
                key === 'mcp' && 'text-blue-400',
                key === 'commands' && 'text-purple-400',
                key === 'personalization' && 'text-cyan-400',
              )}
            />
            {/* `flex-auto` (basis: auto) rather than `flex-1` (basis: 0) is
                load-bearing: with a zero basis the wrap decision sees this
                block as zero-width, so instead of the badges moving to their
                own line the label gets squeezed to nothing and disappears. */}
            <span className="min-w-0 flex-auto">
              <span className="block truncate text-sm font-medium">{t(labelKey)}</span>
              <span className="block truncate text-[11px] text-neutral-500">
                {t('catbar.items', { n: countFor(key) })}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-1">{badgeFor(key)}</span>
          </button>
        );
      })}
    </div>
  );
}
