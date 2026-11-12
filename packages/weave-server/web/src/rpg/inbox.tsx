import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { api, type RpgRoutingDecisionView, type RoutingProfileVersionView } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useBackPop } from '@/lib/back-pop';
import { Input } from '@/components/ui/input';
import type { RpgData } from './use-rpg-data';

/**
 * 决策路由信箱（G6，G线设计 §六）：级2 待批清单（协调者预告的动作聚此，用户
 * 择机批——「新挂起待答只提醒不自动弹」同口径）+ 决策轨迹（复盘读面）。执行权
 * 恒在用户：批准落账后动作执行归各自端点。数据零伪造——没有 pending 就只摆
 * 轨迹；全空如实说明。数据由调用方注入（RpgView 的 useRpgData），不自带拉取。
 */

/** 动作键 → 文案词条（server 词表 routing.ts 的镜像；未镜像的键原样显示）。 */
type RoutingActionKey =
  | 'rpg.routingAction.cropPromote'
  | 'rpg.routingAction.goalChange'
  | 'rpg.routingAction.budgetRenew'
  | 'rpg.routingAction.downgrade'
  | 'rpg.routingAction.crossHouseWrite'
  | 'rpg.routingAction.roleFreeze'
  | 'rpg.routingAction.apexReview'
  | 'rpg.routingAction.alliance'
  | 'rpg.routingAction.patrol'
  | 'rpg.routingAction.dispatch'
  | 'rpg.routingAction.nudge';

const ROUTING_ACTION_LABEL: Record<string, RoutingActionKey> = {
  'crop-promote': 'rpg.routingAction.cropPromote',
  'goal-change': 'rpg.routingAction.goalChange',
  'budget-renew': 'rpg.routingAction.budgetRenew',
  downgrade: 'rpg.routingAction.downgrade',
  'cross-house-write': 'rpg.routingAction.crossHouseWrite',
  'role-freeze': 'rpg.routingAction.roleFreeze',
  'apex-review': 'rpg.routingAction.apexReview',
  alliance: 'rpg.routingAction.alliance',
  patrol: 'rpg.routingAction.patrol',
  dispatch: 'rpg.routingAction.dispatch',
  nudge: 'rpg.routingAction.nudge',
};

function actionLabelOf(t: ReturnType<typeof useT>, action: string): string {
  const key = ROUTING_ACTION_LABEL[action];
  return key ? t(key) : action;
}

const RESULT_BADGE: Record<RpgRoutingDecisionView['result'], string> = {
  pending: 'bg-amber-800/70 text-amber-100',
  approved: 'bg-emerald-900/60 text-emerald-200',
  rejected: 'bg-rose-900/50 text-rose-200',
  allowed: 'bg-sky-900/60 text-sky-200',
  blocked: 'bg-[var(--w-surface-3)] text-[var(--w-text-dim)]',
  tripped: 'bg-violet-900/60 text-violet-200',
};

export function RoutingInbox({
  open,
  onClose,
  data,
}: {
  open: boolean;
  onClose: () => void;
  data: Pick<RpgData, 'routingDecisions' | 'routingStats' | 'profile'>;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { show } = useToast();

  useBackPop(open, () => {
    onClose();
    return true;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const decide = useMutation({
    mutationFn: (input: { id: number; approve: boolean }) => api.decideRoutingDecision(input.id, input.approve),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: ['rpg-routing'] });
      // 批准 cross-house-write 提案会当场落档——策略档段同拍跟上
      void qc.invalidateQueries({ queryKey: ['rpg-profile'] });
      show('info', input.approve ? t('rpg.routingApproved') : t('rpg.routingRejected'));
    },
    onError: (e) => show('error', String(e)),
  });

  if (!open) return null;
  const decisions = data.routingDecisions ?? [];
  const pending = decisions.filter((d) => d.result === 'pending');
  const settled = decisions.filter((d) => d.result !== 'pending').slice(0, 10);
  return (
    <div className="rpg-overlay-surface absolute inset-x-2 top-10 z-30 flex max-h-[70%] flex-col gap-2 overflow-auto rounded-lg border border-[var(--w-border)] p-3 shadow-xl">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.routingInboxTitle')}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
        >
          ✕
        </button>
      </div>

      {pending.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {pending.map((d) => (
            <RoutingRow key={d.id} row={d} label={actionLabelOf(t, d.action)} onDecide={decide.mutate} busy={decide.isPending} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-[var(--w-text-dim)]">{t('rpg.routingInboxEmpty')}</p>
      )}

      {settled.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-[var(--w-border)] pt-2">
          <span className="text-[10px] uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.routingTrail')}</span>
          {settled.map((d) => (
            <RoutingRow key={d.id} row={d} label={actionLabelOf(t, d.action)} onDecide={undefined} busy={false} />
          ))}
        </div>
      )}

      {data.routingStats && data.routingStats.total > 0 && (
        <p className="text-[10px] text-[var(--w-text-dim)]">
          {t('rpg.routingStatLine', {
            total: String(data.routingStats.total),
            overturned: String(data.routingStats.overturned),
            pending: String(data.routingStats.pending),
          })}
        </p>
      )}

      <ProfileSection data={data} />
    </div>
  );
}

/**
 * 策略档段（G6 批5 进化闭环的信箱底座）：当前参数 + 复盘提案（POST review——
 * 草稿落在上方 pending 区呈批，批准即落档：decide 续跑构型）+ 手改 + 版本链
 * 一键回滚。级2 动作（落档/回滚）用户直改 = 上帝当场批（构型同 goal PATCH）。
 */
function ProfileSection({ data }: { data: Pick<RpgData, 'profile'> }) {
  const t = useT();
  const qc = useQueryClient();
  const { show } = useToast();
  const [stall, setStall] = useState('');
  const [cooldown, setCooldown] = useState('');

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['rpg-profile'] });
    void qc.invalidateQueries({ queryKey: ['rpg-routing'] });
  };

  const review = useMutation({
    mutationFn: () => api.runRoutingReview(),
    onSuccess: (r) => {
      refresh();
      show(
        'info',
        r.proposal
          ? t('rpg.profileProposed')
          : r.reason
            ? r.reason.startsWith('gated')
              ? t('rpg.profileGated')
              : t('rpg.profileNoProposal')
            : t('rpg.profileNoProposal'),
      );
    },
    onError: (e) => show('error', String(e)),
  });

  const apply = useMutation({
    mutationFn: () =>
      api.applyRoutingProfile({
        params: {
          ...(stall.trim() !== '' ? { goalStallLimit: Number(stall) } : {}),
          ...(cooldown.trim() !== '' ? { goalDriveCooldownMs: Number(cooldown) * 1000 } : {}),
        },
        note: t('rpg.profileManualNote'),
      }),
    onSuccess: () => {
      refresh();
      show('info', t('rpg.profileApplied'));
      setStall('');
      setCooldown('');
    },
    onError: (e) => show('error', String(e)),
  });

  const rollback = useMutation({
    mutationFn: (id: number) => api.rollbackRoutingProfile(id),
    onSuccess: () => {
      refresh();
      show('info', t('rpg.profileRolledBack'));
    },
    onError: (e) => show('error', String(e)),
  });

  const resolved = data.profile?.resolved;
  const versions = data.profile?.versions ?? [];

  return (
    <div className="flex flex-col gap-1 border-t border-[var(--w-border)] pt-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.profileTitle')}</span>
        <button
          type="button"
          disabled={review.isPending}
          onClick={() => review.mutate()}
          className="rounded bg-[var(--w-surface-2)] px-2 py-0.5 text-[10px] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)] disabled:opacity-50"
        >
          {review.isPending ? '…' : t('rpg.profileReview')}
        </button>
      </div>
      {resolved && (
        <p className="text-[10px] tabular-nums text-[var(--w-text-dim)]">
          {t('rpg.profileCurrent', {
            stall: String(resolved.goalStallLimit),
            cooldown: String(Math.round(resolved.goalDriveCooldownMs / 1000)),
          })}
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <Input
          value={stall}
          onChange={(e) => setStall(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder={t('rpg.profileStallPlaceholder')}
          aria-label={t('rpg.profileStallPlaceholder')}
          className="!w-20 !py-0.5 !text-[11px]"
        />
        <Input
          value={cooldown}
          onChange={(e) => setCooldown(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder={t('rpg.profileCooldownPlaceholder')}
          aria-label={t('rpg.profileCooldownPlaceholder')}
          className="!w-20 !py-0.5 !text-[11px]"
        />
        <button
          type="button"
          disabled={(stall.trim() === '' && cooldown.trim() === '') || apply.isPending}
          onClick={() => apply.mutate()}
          className="rounded bg-[var(--w-surface-2)] px-2 py-0.5 text-[10px] text-[var(--w-text)] hover:bg-[var(--w-surface-3)] disabled:opacity-50"
        >
          {apply.isPending ? '…' : t('rpg.profileApply')}
        </button>
      </div>
      {versions.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {versions.slice(0, 5).map((v) => (
            <VersionRow key={v.id} version={v} busy={rollback.isPending} onRollback={() => rollback.mutate(v.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function VersionRow({
  version,
  busy,
  onRollback,
}: {
  version: RoutingProfileVersionView;
  busy: boolean;
  onRollback: () => void;
}) {
  const t = useT();
  const params = version.params.goalStallLimit != null
    ? t('rpg.profileVersionStall', { stall: String(version.params.goalStallLimit) })
    : t('rpg.profileVersionDefault');
  return (
    <div className="flex items-center gap-2 text-[10px] text-[var(--w-text-dim)]">
      <span className="tabular-nums">#{version.id}</span>
      <span className="min-w-0 flex-1 truncate">
        {params}
        {version.note != null && <span className="ml-1 text-[var(--w-text-dim)]">{version.note.slice(0, 40)}</span>}
      </span>
      {version.isCurrent ? (
        <span className="rounded bg-[var(--w-surface-2)] px-1.5 py-0.5">{t('rpg.profileCurrentBadge')}</span>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={onRollback}
          className="rounded bg-[var(--w-surface-2)] px-1.5 py-0.5 hover:bg-[var(--w-surface-3)] disabled:opacity-50"
        >
          {t('rpg.profileRollback')}
        </button>
      )}
    </div>
  );
}

/** 一行裁决：动作 · 依据/详情 · 时间 · 结果徽章；pending 行带批准/拒绝两枚。 */
function RoutingRow({
  row,
  label,
  onDecide,
  busy,
}: {
  row: RpgRoutingDecisionView;
  label: string;
  onDecide?: (input: { id: number; approve: boolean }) => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] px-2 py-1.5">
      <span className="shrink-0 rounded bg-[var(--w-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--w-text-dim)]">
        L{row.level}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--w-text)]">
        {label}
        {row.detail != null && <span className="ml-1 text-[10px] text-[var(--w-text-dim)]">{row.detail}</span>}
        {row.overturned > 0 && <span className="ml-1 text-[10px] text-amber-400">{t('rpg.routingOverturned')}</span>}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--w-text-dim)]">
        {new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
      {row.result === 'pending' && onDecide ? (
        <span className="flex shrink-0 gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide({ id: row.id, approve: true })}
            className="rounded bg-emerald-900/60 px-2 py-0.5 text-[11px] text-emerald-100 hover:bg-emerald-800/70 disabled:opacity-50"
          >
            {t('rpg.routingApprove')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide({ id: row.id, approve: false })}
            className="rounded bg-rose-900/50 px-2 py-0.5 text-[11px] text-rose-100 hover:bg-rose-800/60 disabled:opacity-50"
          >
            {t('rpg.routingReject')}
          </button>
        </span>
      ) : (
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${RESULT_BADGE[row.result]}`}>
          {t(`rpg.routingResult.${row.result}` as 'rpg.routingResult.pending')}
        </span>
      )}
    </div>
  );
}
