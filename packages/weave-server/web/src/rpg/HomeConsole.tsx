import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { api, type ProjectRow } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { CreateRoleForm } from './CreateRoleForm';

/**
 * Home 统一控制台（G2，2026-11-08 用户裁决）：分身编辑 / 角色创建 / team 管理
 * 三件事都在 Home 视图内完成，不开散装入口。team 管理走既有 formTeam 通道
 * （协调者 teams/ 文件即事实）；分身编辑 = 每房一员上帝分身的人设文本（v1 最小
 * 形）。任务管理归 G6——本面不摆入口、不留空壳。
 */

type Tab = 'coordinator' | 'role' | 'team';

export function HomeConsole({ projects }: { projects: ProjectRow[] }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('coordinator');
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'coordinator', label: t('rpg.consoleCoordinator') },
    { key: 'role', label: t('rpg.roleCreate') },
    { key: 'team', label: t('rpg.consoleTeam') },
  ];
  return (
    <section className="rpg-tile min-h-0 flex-1 overflow-auto rounded border border-[var(--w-border)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.consoleTitle')}</span>
        <div className="rpg-console-tabs flex gap-1">
          {tabs.map((x) => (
            <button
              key={x.key}
              type="button"
              onClick={() => setTab(x.key)}
              className={
                'rounded px-2 py-0.5 text-xs ' +
                (x.key === tab
                  ? 'bg-[var(--w-accent)] text-white'
                  : 'bg-[var(--w-surface-2)] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)]')
              }
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'coordinator' && <CoordinatorPanel />}
      {tab === 'role' && <RolePanel />}
      {tab === 'team' && <TeamPanel projects={projects} />}
    </section>
  );
}

/** 分身编辑（统一控制台①）：每房一员分身，人设文本即改即存（PATCH）。 */
function CoordinatorPanel() {
  const t = useT();
  const qc = useQueryClient();
  const houses = useQuery({ queryKey: ['rpg-houses'], queryFn: () => api.listHouses(), staleTime: 15_000 });
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const save = useMutation({
    mutationFn: (input: { id: number; persona: string | null }) => api.updateHouse(input.id, { coordinatorPersona: input.persona }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['rpg-houses'] }),
  });

  if (houses.data == null) return <p className="text-xs text-[var(--w-text-dim)]">…</p>;
  if (houses.data.houses.length === 0) {
    return <p className="text-xs text-[var(--w-text-dim)]">{t('rpg.consoleNoHouses')}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {houses.data.houses.map((h) => {
        const draft = drafts[h.id] ?? h.coordinatorPersona ?? '';
        return (
          <div key={h.id} className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">{h.name}</span>
              <span className="text-[11px] text-[var(--w-text-dim)]">{t('rpg.coordinatorSeat')}</span>
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDrafts((d) => ({ ...d, [h.id]: e.target.value }))}
              placeholder={t('rpg.coordinatorPersonaPlaceholder')}
              rows={3}
              className="w-full rounded-md border border-edge/[0.08] bg-neutral-900 p-2 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-mac-accent/50 focus:outline-none"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={draft === (h.coordinatorPersona ?? '') || save.isPending}
                onClick={() => save.mutate({ id: h.id, persona: draft.trim() === '' ? null : draft })}
                className="rounded bg-[var(--w-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {save.isPending ? '…' : t('common.save')}
              </button>
              {save.isError && <span className="text-[11px] text-red-400">{String(save.error)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 角色创建（统一控制台②）：既有 CreateRoleForm 原样保留，只是入口收进 Home。 */
function RolePanel() {
  const t = useT();
  const qc = useQueryClient();
  return (
    <div>
      <CreateRoleForm
        onCreated={() => {
          void qc.invalidateQueries({ queryKey: ['rpg-roles'] });
          void qc.invalidateQueries({ queryKey: ['rpg-houses'] });
        }}
      />
      <p className="mt-2 text-[11px] text-[var(--w-text-dim)]">{t('rpg.consoleRoleHint')}</p>
    </div>
  );
}

/** team 管理（统一控制台③）：既有 /rpg/teams（formTeam）通道 + 名册 live 展开。 */
function TeamPanel({ projects }: { projects: ProjectRow[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const teams = useQuery({ queryKey: ['rpg-teams-resolved'], queryFn: () => api.listRoles(), staleTime: 15_000 });
  const nameOk = /^[a-z][a-z0-9-]{0,63}$/.test(name.trim());
  const form = useMutation({
    mutationFn: () =>
      api.formTeam({
        name: name.trim(),
        ...(goal.trim() ? { goal: goal.trim() } : {}),
        roles: picked.map((id) => ({ role: rolesNameOf(teams.data?.roles ?? [], id) })),
      }),
    onSuccess: () => {
      setName('');
      setGoal('');
      setPicked([]);
      void qc.invalidateQueries({ queryKey: ['rpg-teams-resolved'] });
    },
  });
  const activeProjects = useMemo(() => projects.filter((p) => !p.archivedAt), [projects]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('rpg.teamNamePlaceholder')}
          className="w-56"
          aria-label={t('rpg.teamNamePlaceholder')}
        />
        <Input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={t('rpg.teamGoalPlaceholder')}
          className="w-64"
          aria-label={t('rpg.teamGoalPlaceholder')}
        />
        <button
          type="button"
          disabled={!nameOk || picked.length === 0 || form.isPending}
          onClick={() => form.mutate()}
          className="rounded bg-[var(--w-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {form.isPending ? '…' : t('rpg.teamForm')}
        </button>
      </div>
      {!nameOk && name.trim() !== '' && (
        <span className="text-[11px] text-[var(--w-text-dim)]">{t('rpg.roleNameInvalid')}</span>
      )}
      {form.isError && <span className="text-[11px] text-red-400">{String(form.error)}</span>}
      {form.isSuccess && <span className="text-[11px] text-[var(--w-text-dim)]">{t('rpg.teamFormed')}</span>}
      <div className="flex flex-wrap gap-2">
        {(teams.data?.roles ?? []).map((role) => {
          const on = picked.includes(role.id);
          return (
            <button
              key={role.id}
              type="button"
              onClick={() => setPicked((cur) => (on ? cur.filter((x) => x !== role.id) : [...cur, role.id]))}
              className={
                'rounded px-2 py-1 text-xs ' +
                (on
                  ? 'bg-[var(--w-accent)] text-white'
                  : 'bg-[var(--w-surface-2)] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)]')
              }
            >
              {role.name}
            </button>
          );
        })}
        {activeProjects.length === 0 && (teams.data?.roles ?? []).length === 0 && (
          <span className="text-xs text-[var(--w-text-dim)]">{t('rpg.consoleNoRoles')}</span>
        )}
      </div>
    </div>
  );
}

function rolesNameOf(roles: Array<{ id: number; name: string }>, id: number): string {
  return roles.find((r) => r.id === id)?.name ?? String(id);
}
