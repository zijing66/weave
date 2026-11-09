import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { api, type RpgCropView, type RpgRoleView } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';

/**
 * 修炼动作面板（G3，G线设计 §七）：修炼点热点（World 场景）唤起——
 * - **种田** = skill：下种（角色仓 crops/<名>/ 落田）→ 长出来后收菜验收（品阶
 *   保守评定）→ 灵品+ 可收进角色仓 `.claude/skills/` → 晋升三档（级2 确认 =
 *   ConfirmDialog 呈确认，绝不自动）。
 * - **钓鱼** = 插件：同一下种/验收收口（kind='fishing'），产物落角色仓由既有
 *   插件通道消费；照料介入（构建失败「该浇水了」）走既有 watch/notify 通道。
 * - **锻造** = 角色：纯入口，导向 Home 统一控制台的角色创建 tab。
 */

type Entry = 'farm' | 'fish' | 'forge';

const GRADE_BADGE: Record<string, string> = {
  凡: 'bg-[var(--w-surface-3)] text-[var(--w-text-dim)]',
  灵: 'bg-sky-900/60 text-sky-200',
  仙: 'bg-violet-900/60 text-violet-200',
  天: 'bg-amber-800/70 text-amber-100',
};

const TIER_LABEL_KEYS = ['rpg.trainingTier1', 'rpg.trainingTier2', 'rpg.trainingTier3'] as const;

export function TrainingPanel({ roles, onClose }: { roles: RpgRoleView[]; onClose: () => void }) {
  const t = useT();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [roleId, setRoleId] = useState<number | null>(roles[0]?.id ?? null);
  const role = roles.find((r) => r.id === roleId) ?? roles[0] ?? null;

  return (
    <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.trainingTitle')}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
        >
          ✕
        </button>
      </div>
      {roles.length === 0 ? (
        <p className="text-xs text-[var(--w-text-dim)]">{t('rpg.trainingNoRoles')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ['farm', 'rpg.trainingFarm'],
                ['fish', 'rpg.trainingFish'],
                ['forge', 'rpg.trainingForge'],
              ] as Array<[Entry, string]>
            ).map(([key, labelKey]) => (
              <button
                key={key}
                type="button"
                onClick={() => setEntry(key)}
                className={
                  'rounded px-3 py-1.5 text-xs ' +
                  (entry === key
                    ? 'bg-[var(--w-accent)] text-white'
                    : 'bg-[var(--w-surface-2)] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)]')
                }
              >
                {t(labelKey as 'rpg.trainingFarm')}
              </button>
            ))}
            <select
              value={role?.id ?? ''}
              onChange={(e) => setRoleId(Number(e.target.value))}
              className="rounded border border-[var(--w-border)] bg-[var(--w-surface-2)] px-2 py-1 text-xs"
              aria-label={t('rpg.trainingPickRole')}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          {entry === 'forge' ? (
            <p className="text-xs text-[var(--w-text-dim)]">{t('rpg.trainingForgeHint')}</p>
          ) : entry != null && role ? (
            <CropWorkbench roleId={role.id} kind={entry === 'farm' ? 'farming' : 'fishing'} />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 一块田的完整生命周期（种田/钓鱼同构，kind 区分词表）。 */
function CropWorkbench({ roleId, kind }: { roleId: number; kind: 'farming' | 'fishing' }) {
  const t = useT();
  const qc = useQueryClient();
  const { show } = useToast();
  const [name, setName] = useState('');
  const [promoting, setPromoting] = useState<RpgCropView | null>(null);
  const crops = useQuery({
    queryKey: ['rpg-crops', roleId],
    queryFn: () => api.listCrops(roleId),
    staleTime: 10_000,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['rpg-crops', roleId] });
    void qc.invalidateQueries({ queryKey: ['rpg-growth', roleId] });
  };
  const plant = useMutation({
    mutationFn: () => api.plantCrop(roleId, kind, name.trim()),
    onSuccess: () => {
      setName('');
      invalidate();
    },
    onError: (e) => show('error', String(e)),
  });
  const assess = useMutation({
    mutationFn: (crop: RpgCropView) => api.assessCrop(crop.id, {}),
    onSuccess: (r) => {
      invalidate();
      show('info', t('rpg.trainingAssessed', { grade: r.crop.grade ?? t('rpg.trainingGradeNone') }));
    },
    onError: (e) => show('error', String(e)),
  });
  const harvest = useMutation({
    mutationFn: (crop: RpgCropView) => api.harvestCrop(crop.id),
    onSuccess: () => {
      invalidate();
      show('info', t('rpg.trainingHarvested'));
    },
    onError: (e) => show('error', String(e)),
  });
  const promote = useMutation({
    mutationFn: (tier: 1 | 2 | 3) => api.promoteCrop(promoting!.id, tier),
    onSuccess: () => {
      setPromoting(null);
      invalidate();
      show('info', t('rpg.trainingPromoted'));
    },
    onError: (e) => show('error', String(e)),
  });
  const nameOk = /^[a-z][a-z0-9-]{0,63}$/.test(name.trim());
  const rows = (crops.data?.crops ?? []).filter((c) => c.kind === kind);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t(kind === 'farming' ? 'rpg.trainingCropName' : 'rpg.trainingFishName')}
          className="w-48"
          aria-label={t(kind === 'farming' ? 'rpg.trainingCropName' : 'rpg.trainingFishName')}
        />
        <button
          type="button"
          disabled={!nameOk || plant.isPending}
          onClick={() => plant.mutate()}
          className="rounded bg-[var(--w-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t(kind === 'farming' ? 'rpg.trainingPlant' : 'rpg.trainingCast')}
        </button>
        {!nameOk && name.trim() !== '' && (
          <span className="text-[11px] text-[var(--w-text-dim)]">{t('rpg.roleNameInvalid')}</span>
        )}
      </div>
      {rows.length === 0 && <p className="text-xs text-[var(--w-text-dim)]">{t('rpg.trainingNoCrops')}</p>}
      {rows.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2 rounded border border-[var(--w-border)] bg-[var(--w-surface-2)] p-2">
          <span className="text-sm">{c.name}</span>
          <span className={'rounded px-1.5 py-0.5 text-[11px] ' + (c.grade ? (GRADE_BADGE[c.grade] ?? '') : 'bg-[var(--w-surface-3)] text-[var(--w-text-dim)]')}>
            {c.grade ?? t('rpg.trainingGradeNone')}
          </span>
          <span className="text-[11px] text-[var(--w-text-dim)]">{t(`rpg.trainingStatus${cap(c.status)}` as 'rpg.trainingStatusGrowing')}</span>
          <span className="text-[11px] text-[var(--w-text-dim)]">
            {t('rpg.trainingMetrics', {
              artifact: c.hasArtifact ? '✓' : '✗',
              tests: c.hasTests ? '✓' : '✗',
              lint: c.lintOk ? '✓' : '✗',
              docs: c.docsOk ? '✓' : '✗',
            })}
          </span>
          <span className="ml-auto flex gap-1">
            {c.status === 'growing' && (
              <button type="button" onClick={() => assess.mutate(c)} className="rounded bg-[var(--w-surface-3)] px-2 py-0.5 text-[11px] hover:bg-[var(--w-accent)] hover:text-white">
                {t(kind === 'fishing' ? 'rpg.trainingReelIn' : 'rpg.trainingAssess')}
              </button>
            )}
            {c.status === 'harvested' && c.kind === 'farming' && (
              <button type="button" onClick={() => harvest.mutate(c)} className="rounded bg-[var(--w-surface-3)] px-2 py-0.5 text-[11px] hover:bg-[var(--w-accent)] hover:text-white">
                {t('rpg.trainingHarvest')}
              </button>
            )}
            {c.status === 'harvested' && (
              <button type="button" onClick={() => setPromoting(c)} className="rounded bg-[var(--w-surface-3)] px-2 py-0.5 text-[11px] hover:bg-[var(--w-accent)] hover:text-white">
                {t('rpg.trainingPromote')}
              </button>
            )}
          </span>
        </div>
      ))}
      {/* 级2 人工裁决：晋升呈 ConfirmDialog 确认，绝不自动 */}
      <ConfirmDialog
        open={promoting != null}
        title={t('rpg.trainingPromoteTitle', { name: promoting?.name ?? '' })}
        message={t('rpg.trainingPromoteConfirm')}
        confirmLabel={t('rpg.trainingPromoteGo')}
        onConfirm={() => {
          if (promoting) promote.mutate(1);
        }}
        onClose={() => setPromoting(null)}
      />
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export { TIER_LABEL_KEYS };
