import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { api } from '@/lib/api';
import { HexRadar } from './HexRadar';

/**
 * 成长榜（RPG-3）：/rpg/board 派生面，XP 降序；行内 = 名次、等级、境界、
 * 成就数。首名展开六维雷达（榜单级只摆一行雷达——竞技化呈现留给后续场景）。
 * 零角色 = 不渲染（调用方判）。
 */

export function GrowthBoard() {
  const t = useT();
  const board = useQuery({
    queryKey: ['rpg-board'],
    queryFn: () => api.growthBoard(),
    staleTime: 15_000,
  });

  const rows = board.data?.board;
  if (rows == null || rows.length === 0) return null;

  return (
    <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.growthBoard')}</div>
      <div className="flex flex-col gap-1">
        {rows.map((row, i) => (
          <div
            key={row.roleId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded px-2 py-1 text-xs odd:bg-[var(--w-surface-2)]"
          >
            <span className="w-6 text-center font-medium text-[var(--w-text-dim)]">#{i + 1}</span>
            <span className="min-w-24 font-medium">{row.name}</span>
            <span className="text-[var(--w-text-dim)]">{row.archetype ?? '—'}</span>
            <span>{t('rpg.levelN', { n: String(row.level) })}</span>
            <span className="rounded bg-[var(--w-surface-3)] px-1.5 py-0.5 text-[11px] text-[var(--w-text-dim)]">
              {row.realm}
            </span>
            <span className="text-[var(--w-text-dim)]">
              {t('rpg.xpTotal', { n: String(row.total) })}
            </span>
            <span className="text-[var(--w-text-dim)]">
              ★ {row.achievements}
            </span>
            {i === 0 && row.dims && <HexRadar dims={row.dims} scale={1} />}
          </div>
        ))}
      </div>
    </div>
  );
}
