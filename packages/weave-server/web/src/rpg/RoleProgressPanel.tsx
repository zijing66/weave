import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { api } from '@/lib/api';
import { HexRadar } from './HexRadar';

/**
 * 角色详情成长面板（RPG-3）：XP/等级/境界 + 成就清单 + 六维雷达。数据 =
 * /rpg/roles/:id/progress 派生面（读侧派生，解锁事实由服务端落 RPG 域快照）。
 * 只摆有数据的——零素材角色如实显示 0 级，不摆空壳分数。
 */

export function RoleProgressPanel({ roleId }: { roleId: number }) {
  const t = useT();
  const progress = useQuery({
    queryKey: ['rpg-progress', roleId],
    queryFn: () => api.progressOf(roleId),
    staleTime: 15_000,
  });

  if (progress.isLoading) {
    return <div className="p-4 text-sm text-[var(--w-text-dim)]">…</div>;
  }
  const p = progress.data?.progress;
  if (!p) return null;

  return (
    <div className="flex flex-col gap-3">
      {/* XP / 等级 / 境界 */}
      <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-medium">
            {t('rpg.levelN', { n: String(p.xp.level) })}
          </span>
          <span className="rounded bg-[var(--w-surface-3)] px-1.5 py-0.5 text-xs text-[var(--w-text-dim)]">
            {p.xp.realm}
          </span>
          <span className="text-xs text-[var(--w-text-dim)]">
            {t('rpg.xpTotal', { n: String(p.xp.total) })} · {t('rpg.xpToNext', { n: String(p.xp.remaining) })}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--w-text-dim)]">
          <span>{t('rpg.xpQuest')}: {p.xp.breakdown.quest}</span>
          <span>{t('rpg.xpTurns')}: {p.xp.breakdown.turns}</span>
          <span>{t('rpg.xpCultivation')}: {p.xp.breakdown.cultivation}</span>
          {p.xp.breakdown.collaboration > 0 && (
            <span>{t('rpg.xpCollaboration')}: {p.xp.breakdown.collaboration}</span>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* 六维雷达（含实战修正说明） */}
        <div className="flex flex-col items-center gap-2 rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
          <div className="self-start text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.hexagon')}</div>
          <HexRadar dims={p.hexagon.dims} bonus={p.hexagon.bonus} />
          <div className="text-[11px] text-[var(--w-text-dim)]" title={p.hexagon.reason}>
            {t('rpg.hexBonusNote')}
          </div>
        </div>

        {/* 成就（解锁在前；未解锁置灰显示口径，不摆假进度） */}
        <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
          <div className="mb-2 text-xs uppercase tracking-wide text-[var(--w-text-dim)]">
            {t('rpg.achievements')} · {p.achievements.filter((a) => a.at != null).length}/{p.achievements.length}
          </div>
          <div className="flex max-h-64 flex-col gap-1 overflow-auto">
            {p.achievements.map((a) => (
              <div
                key={a.key}
                className={
                  'rounded px-2 py-1 text-xs ' +
                  (a.at != null
                    ? 'bg-[var(--w-surface-2)] text-[var(--w-text)]'
                    : 'text-[var(--w-text-dim)] opacity-60')
                }
                title={a.stats ?? undefined}
              >
                {a.at != null ? '★ ' : '☆ '}
                {t(`rpg.ach.${a.key}` as 'rpg.ach.firstKill')}
                {a.at != null && (
                  <span className="ml-1 text-[10px] text-[var(--w-text-dim)]">
                    {new Date(a.at).toLocaleDateString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
