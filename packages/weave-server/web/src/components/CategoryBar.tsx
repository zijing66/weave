import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import {
  Terminal,
  Sparkles,
  Workflow,
  ListTodo,
  type LucideIcon,
} from 'lucide-react';

export type MainCategory = 'files' | 'personalization' | 'tasks' | 'weave';

export const MAIN_CATEGORIES: {
  key: MainCategory;
  /** Dict key for the card label — module scope can't call hooks. */
  labelKey: MessageKey;
  icon: LucideIcon;
}[] = [
  // The count on this card is every file asset (skills, MCP, instructions,
  // settings, helpers …), so the label says 资源管理 rather than implying it
  // counts any one of them alone.
  { key: 'files', labelKey: 'catbar.files', icon: Terminal },
  { key: 'personalization', labelKey: 'catbar.personalization', icon: Sparkles },
  { key: 'tasks', labelKey: 'catbar.tasks', icon: ListTodo },
  { key: 'weave', labelKey: 'catbar.hooks', icon: Workflow },
];

export interface CategoryBarData {
  /** Skills + MCP + other file assets — the merged 资源管理 card count. */
  files: number;
  /** Outdated skills + MCP servers, shown as one warning badge. */
  outdated: number;
  /** Hook rules effective in the current view (global rules + own rules). */
  hooksRules: number;
  /** 项目会话数（任务卡计数）。 */
  sessions: number;
  /** Statusline source; null while not loaded (Claude card badge). */
  statuslineSource: 'global' | 'custom' | null;
}

export function CategoryBar({
  category,
  onSelect,
  data,
  hidden,
}: {
  category: MainCategory;
  onSelect: (c: MainCategory) => void;
  data: CategoryBarData;
  /** 隐藏的分类卡（全局模式隐藏 tasks——任务视图仅项目级）。 */
  hidden?: ReadonlySet<MainCategory>;
}) {
  const t = useT();
  const countFor = (c: MainCategory): number => {
    switch (c) {
      case 'files':
        return data.files;
      case 'personalization':
        return 1; // the Claude statusline config is always present
      case 'weave':
        return data.hooksRules;
      case 'tasks':
        return data.sessions;
    }
  };

  const badgeFor = (c: MainCategory): ReactNode => {
    switch (c) {
      case 'files':
        return data.outdated > 0 ? (
          <Badge variant="warning">{t('catbar.updateBadge', { n: data.outdated })}</Badge>
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
    // Cards equal-fill a single row whenever they all fit (four cards fit a
    // 1280px viewport); below that the row wraps instead of clipping the
    // first/last card at the container edges.
    <div className="flex flex-wrap gap-2 p-2 border-b border-white/[0.06] overflow-x-auto">
      {MAIN_CATEGORIES.filter((c) => !hidden?.has(c.key)).map(({ key, labelKey, icon: Icon }) => {
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
              // the row wraps before labels start truncating.
              'flex-1 min-w-[6.5rem] flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-2 text-left',
              'border border-white/[0.08] transition-all duration-200 ease-mac',
              active
                ? 'bg-neutral-800/90 ring-1 ring-blue-500/50 shadow-mac-sm'
                : 'bg-neutral-900/40 hover:bg-neutral-800/60',
            )}
          >
            <Icon
              className={cn(
                'h-4 w-4 shrink-0',
                key === 'files' && 'text-purple-400',
                key === 'personalization' && 'text-cyan-400',
                key === 'tasks' && 'text-rose-400',
                key === 'weave' && 'text-amber-400',
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
