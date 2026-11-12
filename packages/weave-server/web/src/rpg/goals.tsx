import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { api, type RpgGoalView } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useBackPop } from '@/lib/back-pop';
import { Input } from '@/components/ui/input';
import type { RpgData } from './use-rpg-data';

/**
 * 任务沙盘全局面板（G6 批4c，G线设计 §八）：任务管理不锁场景——任意视图可唤
 * 起（HUD 入口常驻，active 觡数 = 角标），goal 列表 + 立项表单 + 状态动作。
 * goal → 任务（阶段）→ 回合（run）三层里的 v1 呈现 = goal 层 + 回合计账
 * （turnsUsed/stallStreak 实时可见）；阶段(run) tab 挂后续批。数据由调用方注入
 * （RpgView 的 useRpgData），不自带拉取。状态动作是级2：用户直改 = 上帝当场
 * 批（server 落账），确认即执行不需要二次弹窗。
 */

const STATUS_BADGE: Record<RpgGoalView['status'], string> = {
  active: 'bg-sky-900/60 text-sky-200',
  paused: 'bg-amber-800/70 text-amber-100',
  achieved: 'bg-emerald-900/60 text-emerald-200',
  abandoned: 'bg-[var(--w-surface-3)] text-[var(--w-text-dim)]',
  budget_out: 'bg-rose-900/50 text-rose-200',
};

export function GoalsPanel({
  open,
  onClose,
  data,
}: {
  open: boolean;
  onClose: () => void;
  data: Pick<RpgData, 'goals' | 'roles'>;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { show } = useToast();
  const [formOpen, setFormOpen] = useState(false);

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

  const act = useMutation({
    mutationFn: (input: { id: number; patch: Parameters<typeof api.patchGoal>[1] }) =>
      api.patchGoal(input.id, input.patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rpg-goals'] });
      void qc.invalidateQueries({ queryKey: ['rpg-routing'] });
    },
    onError: (e) => show('error', String(e)),
  });

  if (!open) return null;
  const goals = data.goals ?? [];
  const active = goals.filter((g) => g.status === 'active');
  const settled = goals.filter((g) => g.status !== 'active');

  return (
    <div className="rpg-overlay-surface absolute inset-x-2 top-10 z-30 flex max-h-[72%] flex-col gap-2 overflow-auto rounded-lg border border-[var(--w-border)] p-3 shadow-xl">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.goalsTitle')}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFormOpen((v) => !v)}
            disabled={data.roles == null || data.roles.length === 0}
            className="rounded bg-[var(--w-accent)] px-2 py-0.5 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('rpg.goalsCreate')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
          >
            ✕
          </button>
        </div>
      </div>

      {formOpen && data.roles != null && data.roles.length > 0 && (
        <CreateGoalForm
          roles={data.roles}
          onDone={() => setFormOpen(false)}
        />
      )}

      {goals.length === 0 ? (
        <p className="text-xs text-[var(--w-text-dim)]">{t('rpg.goalsEmpty')}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {[...active, ...settled].map((g) => (
            <GoalRow
              key={g.id}
              goal={g}
              roleName={data.roles?.find((r) => r.id === g.roleId)?.name ?? `#${g.roleId}`}
              busy={act.isPending}
              onAct={(patch) => act.mutate({ id: g.id, patch })}
            />
          ))}
        </div>
      )}
      {settled.length > 0 && active.length > 0 && goals.length > active.length && (
        <p className="text-[10px] text-[var(--w-text-dim)]">
          {t('rpg.goalsActiveCount', { active: String(active.length), total: String(goals.length) })}
        </p>
      )}
    </div>
  );
}

function GoalRow({
  goal,
  roleName,
  busy,
  onAct,
}: {
  goal: RpgGoalView;
  roleName: string;
  busy: boolean;
  onAct: (patch: Parameters<typeof api.patchGoal>[1]) => void;
}) {
  const t = useT();
  const [detailOpen, setDetailOpen] = useState(false);
  const budget =
    goal.budgetTurns != null
      ? t('rpg.goalsBudgetLine', { used: String(goal.turnsUsed), cap: String(goal.budgetTurns) })
      : t('rpg.goalsTurnsLine', { used: String(goal.turnsUsed) });
  return (
    <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)]">
    <div className="flex items-start gap-2 px-2 py-1.5">
      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] ${STATUS_BADGE[goal.status]}`}>
        {t(`rpg.goalsStatus.${goal.status}` as 'rpg.goalsStatus.active')}
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setDetailOpen((v) => !v)}
          className="w-full truncate text-left text-xs text-[var(--w-text)] hover:underline"
          title={t('rpg.goalDetailToggle')}
        >
          <span className="text-[var(--w-text-dim)]">{roleName} · </span>
          {goal.title}
        </button>
        <div className="truncate text-[10px] text-[var(--w-text-dim)]" title={goal.terminal}>
          {t('rpg.goalsTerminal')} {goal.terminal}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px] tabular-nums text-[var(--w-text-dim)]">
          <span>{budget}</span>
          {goal.stallStreak > 0 && (
            <span className={goal.stallStreak >= 3 ? 'text-rose-300' : 'text-amber-300'}>
              {t('rpg.goalsStall', { n: String(goal.stallStreak) })}
            </span>
          )}
          {goal.statusNote != null && <span className="truncate">{goal.statusNote}</span>}
        </div>
      </div>
      <span className="flex shrink-0 gap-1">
        {goal.status === 'active' ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAct({ status: 'achieved', statusNote: '收官播报（手动收口）' })}
              className="rounded bg-emerald-900/60 px-2 py-0.5 text-[11px] text-emerald-100 hover:bg-emerald-800/70 disabled:opacity-50"
            >
              {t('rpg.goalsAchieve')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAct({ status: 'paused', statusNote: '上帝手动暂停' })}
              className="rounded bg-amber-900/50 px-2 py-0.5 text-[11px] text-amber-100 hover:bg-amber-800/60 disabled:opacity-50"
            >
              {t('rpg.goalsPause')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAct({ status: 'abandoned', statusNote: '上帝撤销' })}
              className="rounded bg-rose-900/50 px-2 py-0.5 text-[11px] text-rose-100 hover:bg-rose-800/60 disabled:opacity-50"
            >
              {t('rpg.goalsAbandon')}
            </button>
          </>
        ) : goal.status === 'paused' || goal.status === 'budget_out' ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAct({ status: 'active', statusNote: '上帝恢复' })}
              className="rounded bg-sky-900/60 px-2 py-0.5 text-[11px] text-sky-100 hover:bg-sky-800/70 disabled:opacity-50"
            >
              {t('rpg.goalsResume')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAct({ status: 'abandoned', statusNote: '上帝撤销' })}
              className="rounded bg-rose-900/50 px-2 py-0.5 text-[11px] text-rose-100 hover:bg-rose-800/60 disabled:opacity-50"
            >
              {t('rpg.goalsAbandon')}
            </button>
          </>
        ) : null}
      </span>
    </div>
    {detailOpen && <GoalDetailCard goalId={goal.id} roleId={goal.roleId} />}
    </div>
  );
}

/**
 * 任务卡详情（G6 批7，G线设计 §八）：三 tab——现场（角色出征行 + 会话状态）/
 * 时间线（决策轨迹 + 合并梯事件；run 历史 v1 以此代呈现，goal 直投回合不逐拍
 * 记账）/ 生长（作物 + 成长摘要，走既有端点）。按 goalId 拉取一次（卡片自带
 * 查询，GoalRow 展开才挂载——不预取全量）。
 */
export function GoalDetailCard({ goalId, roleId }: { goalId: number; roleId: number }) {
  const t = useT();
  const [tab, setTab] = useState<'scene' | 'timeline' | 'growth'>('scene');
  const detail = useQuery({
    queryKey: ['rpg-goal-detail', goalId],
    queryFn: () => api.getGoalDetail(goalId),
    staleTime: 15_000,
  });
  const crops = useQuery({
    queryKey: ['rpg-goal-detail-crops', roleId],
    queryFn: () => api.listCrops(roleId),
    staleTime: 30_000,
  });
  const tabs: Array<{ key: 'scene' | 'timeline' | 'growth'; label: string }> = [
    { key: 'scene', label: t('rpg.goalTabScene') },
    { key: 'timeline', label: t('rpg.goalTabTimeline') },
    { key: 'growth', label: t('rpg.goalTabGrowth') },
  ];

  if (detail.isError) {
    return <p className="px-2 pb-1.5 text-[11px] text-red-400">{String(detail.error)}</p>;
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-[var(--w-border)] px-2 py-1.5">
      <div className="flex gap-1">
        {tabs.map((x) => (
          <button
            key={x.key}
            type="button"
            onClick={() => setTab(x.key)}
            className={
              'rounded px-2 py-0.5 text-[10px] ' +
              (x.key === tab
                ? 'bg-[var(--w-accent)] text-white'
                : 'bg-[var(--w-surface-2)] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)]')
            }
          >
            {x.label}
          </button>
        ))}
      </div>

      {tab === 'scene' && (
        <div className="flex flex-col gap-1">
          {(detail.data?.expeditions ?? []).length === 0 && (
            <p className="text-[11px] text-[var(--w-text-dim)]">{t('rpg.goalSceneNoExpedition')}</p>
          )}
          {(detail.data?.expeditions ?? []).map((e) => (
            <p key={e.id} className="truncate text-[11px] tabular-nums text-[var(--w-text-dim)]" title={`${e.branch} ← ${e.anchorBranch}@${e.anchorSha.slice(0, 8)}`}>
              {t('rpg.goalSceneExpedition', {
                branch: e.branch,
                status: t(`rpg.expeditionStatus.${e.status}` as 'rpg.expeditionStatus.active'),
              })}
            </p>
          ))}
        </div>
      )}

      {tab === 'timeline' && (
        <div className="flex flex-col gap-1">
          {(detail.data?.decisions ?? []).length === 0 && (detail.data?.ladder ?? []).length === 0 && (
            <p className="text-[11px] text-[var(--w-text-dim)]">{t('rpg.goalTimelineEmpty')}</p>
          )}
          {(detail.data?.decisions ?? []).map((d) => (
            <p key={`d-${d.id}`} className="truncate text-[11px] text-[var(--w-text-dim)]" title={d.detail ?? undefined}>
              {new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
              {t(`rpg.routingResult.${d.result}` as 'rpg.routingResult.pending')} · {d.detail}
            </p>
          ))}
          {(detail.data?.ladder ?? []).map((l) => (
            <p key={`l-${l.id}`} className="truncate text-[11px] text-[var(--w-text-dim)]" title={l.reason ?? undefined}>
              {new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
              {t('rpg.goalTimelineLadder', { layer: l.layer, outcome: l.outcome })} {l.fromBranch} → {l.intoBranch}
            </p>
          ))}
        </div>
      )}

      {tab === 'growth' && (
        <div className="flex flex-col gap-1">
          {crops.isError && <p className="text-[11px] text-red-400">{String(crops.error)}</p>}
          {(crops.data?.crops ?? []).length === 0 && !crops.isError && (
            <p className="text-[11px] text-[var(--w-text-dim)]">{t('rpg.goalGrowthEmpty')}</p>
          )}
          {(crops.data?.crops ?? []).map((c) => (
            <p key={c.id} className="text-[11px] text-[var(--w-text-dim)]">
              {c.name} · {t(`rpg.cropStatus.${c.status}` as 'rpg.cropStatus.growing')}
              {c.grade != null && <span className="ml-1 text-amber-300">{c.grade}品</span>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** 立项表单：终态条件必填（不明确不立项——本地先拦，server 同闸双设）。 */
function CreateGoalForm({
  roles,
  onDone,
}: {
  roles: ReadonlyArray<{ id: number; name: string }>;
  onDone: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { show } = useToast();
  const [roleId, setRoleId] = useState(roles[0]?.id ?? 0);
  const [title, setTitle] = useState('');
  const [terminal, setTerminal] = useState('');
  const [budgetTurns, setBudgetTurns] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createGoal({
        roleId,
        title: title.trim(),
        terminal: terminal.trim(),
        ...(budgetTurns.trim() !== '' ? { budgetTurns: Number(budgetTurns) } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rpg-goals'] });
      show('info', t('rpg.goalsCreated'));
      onDone();
    },
    onError: (e) => show('error', String(e)),
  });

  const valid = roleId > 0 && title.trim() !== '' && terminal.trim() !== '';

  return (
    <div className="flex flex-col gap-1.5 rounded border border-[var(--w-border)] bg-[var(--w-surface-2)] p-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={roleId}
          onChange={(e) => setRoleId(Number(e.target.value))}
          aria-label={t('rpg.goalsRole')}
          className="rounded border border-edge/[0.1] bg-neutral-900 px-2 py-1 text-xs text-neutral-200 focus:border-mac-accent/50 focus:outline-none"
        >
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('rpg.goalsTitlePlaceholder')}
          aria-label={t('rpg.goalsTitlePlaceholder')}
          className="!w-44 !py-1 !text-xs"
        />
        <Input
          value={budgetTurns}
          onChange={(e) => setBudgetTurns(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder={t('rpg.goalsBudgetPlaceholder')}
          aria-label={t('rpg.goalsBudgetPlaceholder')}
          className="!w-24 !py-1 !text-xs"
        />
      </div>
      <textarea
        value={terminal}
        onChange={(e) => setTerminal(e.target.value)}
        placeholder={t('rpg.goalsTerminalPlaceholder')}
        aria-label={t('rpg.goalsTerminalPlaceholder')}
        rows={2}
        className="w-full rounded-md border border-edge/[0.08] bg-neutral-900 p-2 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-mac-accent/50 focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!valid || create.isPending}
          onClick={() => create.mutate()}
          className="rounded bg-[var(--w-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {create.isPending ? '…' : t('rpg.goalsCreateSubmit')}
        </button>
        {create.isError && <span className="text-[11px] text-red-400">{String(create.error)}</span>}
      </div>
    </div>
  );
}
