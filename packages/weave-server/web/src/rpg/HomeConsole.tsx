import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { api, type HandbookEntryView, type ProjectRow, type SessionRow } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/Toast';
import { STATUS_BADGE } from '@/components/tasks/session-status';
import { CreateRoleForm } from './CreateRoleForm';
import { RoleProgressPanel } from './RoleProgressPanel';
import { CharacterSprite, GodAppearanceEditor } from './CharacterSprite';
import { gameStatusOf } from './status-map';
import { useRpgData } from './use-rpg-data';

/**
 * Home 统一控制台（G2，2026-11-08 用户裁决；2026-11-09 修订为 Home 管理面唯一
 * 形态）：分身编辑 / 角色名册（卡阵+修行详情+建角色统一在此 tab）/ team 管理
 * 三合一，角色信息不另摆区块、不开散装入口。team 管理走既有 formTeam 通道
 * （协调者 teams/ 文件即事实）；分身编辑 = 每房一员上帝分身的人设文本（v1 最小
 * 形）。任务管理归 G6——本面不摆入口、不留空壳。
 */

type Tab = 'coordinator' | 'role' | 'team' | 'handbook';

export function HomeConsole({ projects }: { projects: ProjectRow[] }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('coordinator');
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'coordinator', label: t('rpg.consoleCoordinator') },
    { key: 'role', label: t('rpg.consoleRoles') },
    { key: 'team', label: t('rpg.consoleTeam') },
    { key: 'handbook', label: t('rpg.consoleHandbook') },
  ];
  return (
    <section className="min-h-0 flex-1 overflow-auto rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-4">
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
      {tab === 'handbook' && <HandbookPanel />}
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
    return <div><GodAppearanceEditor /><p className="text-xs text-[var(--w-text-dim)]">{t('rpg.consoleNoHouses')}</p></div>;
  }
  return (
    <div className="flex flex-col gap-3">
      <GodAppearanceEditor />
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

/** 角色名册（统一控制台②，2026-11-09 修订）：卡阵 + 修行详情 + 建角色表单**
 * 统一收进本 tab——Home 管理面的角色信息只此一处。 */
function RolePanel() {
  const t = useT();
  const qc = useQueryClient();
  const data = useRpgData();
  const [detailRoleId, setDetailRoleId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const onCreated = () => {
    void qc.invalidateQueries({ queryKey: ['rpg-roles'] });
    void qc.invalidateQueries({ queryKey: ['rpg-houses'] });
    setCreating(false);
  };

  if (data.roles == null) return <p className="text-xs text-[var(--w-text-dim)]">…</p>;

  if (data.roles.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <CreateRoleForm onCreated={onCreated} />
        <p className="mt-2 text-[11px] text-[var(--w-text-dim)]">{t('rpg.consoleRoleHint')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-[var(--w-text-dim)]">
          {t('rpg.charCount')} · {data.roles.length}
        </span>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="rounded bg-[var(--w-surface-2)] px-2 py-1 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)]"
        >
          {t('rpg.roleCreate')}
        </button>
      </div>
      {creating && (
        <div className="mb-4 rounded border border-[var(--w-border)] bg-[var(--w-surface-2)] p-3">
          <CreateRoleForm onCreated={onCreated} />
        </div>
      )}
      <div className="flex flex-wrap gap-4">
        {data.roles.map((role) => {
          const row = latestSessionOf(role.projectId, data.sessionById);
          const status = row ? (data.statuses.get(row.sessionId) ?? 'open') : 'open';
          const game = gameStatusOf(status);
          return (
            <button
              key={role.id}
              type="button"
              onClick={() => setDetailRoleId((cur) => (cur === role.id ? null : role.id))}
              className={
                'flex w-40 flex-col items-center gap-2 rounded border p-3 ' +
                (detailRoleId === role.id
                  ? 'border-[var(--w-accent)] bg-[var(--w-surface-3)]'
                  : row
                    ? 'border-[var(--w-border)] bg-[var(--w-surface-2)] hover:border-[var(--w-accent)]'
                    : 'border-dashed border-[var(--w-border)] opacity-70')
              }
              title={t('rpg.roleProgress')}
            >
              <div className={(game === 'gone' ? 'opacity-40 ' : '') + 'pointer-events-none'}>
                <CharacterSprite
                  archetype={role.archetype}
                  status={game}
                  size={3}
                  gender={role.gender}
                  appearanceSeed={role.appearanceSeed}
                />
              </div>
              <span className="truncate text-sm font-medium">{role.name}</span>
              <span className={'rounded px-1.5 py-0.5 text-[11px] ' + STATUS_BADGE[status]}>
                {role.archetype ?? '—'} · {t(`tasks.status${cap(status)}` as 'tasks.statusOpen')}
              </span>
            </button>
          );
        })}
      </div>
      {detailRoleId != null && (
        <div className="mt-3 rounded border border-[var(--w-border)] bg-[var(--w-surface-2)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">
              {t('rpg.roleProgress')}
            </span>
            <button
              type="button"
              onClick={() => setDetailRoleId(null)}
              className="rounded px-2 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-1)]"
            >
              ✕
            </button>
          </div>
          <RoleProgressPanel roleId={detailRoleId} />
        </div>
      )}
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

/**
 * 手法库（统一控制台④，G6 批6）：协调者本体跨 house 记忆的观察面——文件层即
 * 事实（分身直读直写目录），本面板只做 learn/prune 外壳与清点渲染；坏文件
 * 如实列出（零伪造），空库如实说明。
 */
export function HandbookPanel() {
  const t = useT();
  const qc = useQueryClient();
  const { show } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const list = useQuery({ queryKey: ['rpg-handbook'], queryFn: () => api.listHandbook(), staleTime: 30_000 });
  const nameOk = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name.trim());
  const learn = useMutation({
    mutationFn: () =>
      api.learnHandbookEntry({
        name: name.trim(),
        description: description.trim() || undefined,
        body: body.trim(),
        source: 'god',
      }),
    onSuccess: () => {
      show('info', t('rpg.handbookLearned'));
      setName('');
      setDescription('');
      setBody('');
      void qc.invalidateQueries({ queryKey: ['rpg-handbook'] });
    },
    onError: (e) => show('error', String(e)),
  });
  const prune = useMutation({
    mutationFn: (entryName: string) => api.pruneHandbookEntry(entryName),
    onSuccess: () => {
      show('info', t('rpg.handbookPruned'));
      void qc.invalidateQueries({ queryKey: ['rpg-handbook'] });
    },
    onError: (e) => show('error', String(e)),
  });
  const entries = list.data?.entries ?? [];
  const broken = list.data?.broken ?? [];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-[var(--w-text-dim)]">{t('rpg.handbookHint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.replace(/[^a-z0-9-]/g, ''))}
          placeholder={t('rpg.handbookNamePlaceholder')}
          className="w-48"
          aria-label={t('rpg.handbookNamePlaceholder')}
        />
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('rpg.handbookDescriptionPlaceholder')}
          className="w-72"
          aria-label={t('rpg.handbookDescriptionPlaceholder')}
        />
        <button
          type="button"
          disabled={!nameOk || body.trim() === '' || learn.isPending}
          onClick={() => learn.mutate()}
          className="rounded bg-[var(--w-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {learn.isPending ? '…' : t('rpg.handbookLearn')}
        </button>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('rpg.handbookBodyPlaceholder')}
        aria-label={t('rpg.handbookBodyPlaceholder')}
        rows={3}
        className="w-full max-w-xl rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-2 text-xs outline-none focus:border-[var(--w-accent)]"
      />
      {!nameOk && name.trim() !== '' && (
        <span className="text-[11px] text-[var(--w-text-dim)]">{t('rpg.handbookNameInvalid')}</span>
      )}
      <div className="flex flex-col gap-1.5">
        {entries.map((e) => (
          <HandbookRow key={e.name} entry={e} busy={prune.isPending} onPrune={() => prune.mutate(e.name)} />
        ))}
        {broken.map((b) => (
          <p key={b} className="text-[11px] text-amber-500">
            {t('rpg.handbookBroken', { file: b })}
          </p>
        ))}
        {entries.length === 0 && broken.length === 0 && (
          <span className="text-xs text-[var(--w-text-dim)]">{t('rpg.handbookEmpty')}</span>
        )}
      </div>
    </div>
  );
}

function HandbookRow({
  entry,
  busy,
  onPrune,
}: {
  entry: HandbookEntryView;
  busy: boolean;
  onPrune: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] px-2 py-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-w-0 flex-1 truncate text-left text-xs text-[var(--w-text)]"
          title={entry.description}
        >
          <span className="font-medium">{entry.name}</span>
          {entry.description !== '' && <span className="ml-1.5 text-[var(--w-text-dim)]">{entry.description}</span>}
        </button>
        <span className="shrink-0 rounded bg-[var(--w-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--w-text-dim)]">
          {entry.source ?? '—'}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={onPrune}
          className="shrink-0 rounded bg-[var(--w-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)] disabled:opacity-50"
        >
          {t('rpg.handbookPrune')}
        </button>
      </div>
      {open && <p className="mt-1 whitespace-pre-wrap text-[11px] text-[var(--w-text-dim)]">{entry.body}</p>}
    </div>
  );
}

function rolesNameOf(roles: Array<{ id: number; name: string }>, id: number): string {
  return roles.find((r) => r.id === id)?.name ?? String(id);
}

function latestSessionOf(
  projectId: number,
  sessionById: ReadonlyMap<string, SessionRow>,
): SessionRow | undefined {
  let best: SessionRow | undefined;
  for (const s of sessionById.values()) {
    if (s.projectId !== projectId) continue;
    if (!best || s.createdAt > best.createdAt) best = s;
  }
  return best;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
