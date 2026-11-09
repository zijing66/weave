import { useMemo, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { RPG_SCENES, sceneOf } from './scenes';
import { useRpgData } from './use-rpg-data';
import { CharacterSprite } from './CharacterSprite';
import { gameStatusOf } from './status-map';
import { GameGraph } from './GameGraph';
import { ClassroomScene } from './ClassroomScene';
import { MeetingScene } from './MeetingScene';
import { RoleProgressPanel } from './RoleProgressPanel';
import { GrowthBoard } from './GrowthBoard';
import { BIG_SCREEN_CARDS, type FlowEntryView, type DecisionEntryView } from './bigscreen';
import { STATUS_BADGE } from '@/components/tasks/session-status';
import type { SessionRow } from '@/lib/api';

/**
 * RPG 游戏视图（D1）：场景框架（注册表切换）+ 办公区俯视 MVP + 游戏看板与
 * LR 有向图。位置即 URL（`/rpg/<scene>`，route.ts 单向落下）；角色点击 =
 * `navigate` 进既有会话详情（`/p/<projectId>/tasks/<sessionId>`），不新建对话面。
 */

export function RpgView({
  sceneKey,
  onOpenSession,
}: {
  sceneKey: string | undefined;
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  const t = useT();
  const scene = sceneOf(sceneKey);
  const data = useRpgData();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      {/* 场景注册表切换条 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.sceneRegistry')}</span>
        {RPG_SCENES.map((s) => (
          <span
            key={s.key}
            className={
              'rounded px-2 py-0.5 text-xs ' +
              (s.key === scene.key
                ? 'bg-[var(--w-accent)] text-white'
                : 'bg-[var(--w-surface-2)] text-[var(--w-text-dim)]')
            }
          >
            {t(s.titleKey)}
          </span>
        ))}
      </div>

      {scene.kind === 'classroom' ? (
        <ClassroomScene data={data} onOpenSession={onOpenSession} />
      ) : scene.kind === 'meeting' ? (
        <MeetingScene data={data} onOpenSession={onOpenSession} />
      ) : scene.kind === 'placeholder' ? (
        <div className="rpg-tile flex min-h-0 flex-1 items-center justify-center rounded border border-[var(--w-border)] p-8 text-center text-sm text-[var(--w-text-dim)]">
          {t('rpg.scenePlaceholder')}
        </div>
      ) : (
        <OfficeScene data={data} onOpenSession={onOpenSession} />
      )}
    </div>
  );
}

/** 办公区俯视 MVP：角色卡阵（状态映射动画）+ 任务栏 + 成长榜 + 角色修行详情。 */
function OfficeScene({
  data,
  onOpenSession,
}: {
  data: ReturnType<typeof useRpgData>;
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  const t = useT();
  const board = useBoard(data);
  const [detailRoleId, setDetailRoleId] = useState<number | null>(null);

  if (data.roles == null) {
    return <div className="p-8 text-sm text-[var(--w-text-dim)]">…</div>;
  }
  if (data.roles.length === 0) {
    return (
      <div className="rpg-tile flex min-h-0 flex-1 items-center justify-center rounded border border-[var(--w-border)] p-8 text-center text-sm text-[var(--w-text-dim)]">
        {t('rpg.emptyRoles')}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="rpg-tile min-h-0 flex-1 overflow-auto rounded border border-[var(--w-border)] p-4">
        <div className="mb-2 text-xs text-[var(--w-text-dim)]">
          {t('rpg.charCount')} · {data.roles.length}
        </div>
        <div className="flex flex-wrap gap-4">
          {data.roles.map((role) => {
            // 角色 = 项目：取该项目最近会话的派生状态（无会话 = 待命）。
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
                <div className={game === 'gone' ? 'opacity-40' : undefined}>
                  <CharacterSprite archetype={role.archetype} status={game} size={3} />
                </div>
                <span className="truncate text-sm font-medium">{role.name}</span>
                <span className={'rounded px-1.5 py-0.5 text-[11px] ' + STATUS_BADGE[status]}>
                  {role.archetype ?? '—'} · {t(`tasks.status${cap(status)}` as 'tasks.statusOpen')}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 任务栏（在跑的会话） */}
      <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
        <div className="mb-1 text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.taskbar')}</div>
        {board.activeSessions.length === 0 ? (
          <div className="text-xs text-[var(--w-text-dim)]">{t('rpg.noActiveTasks')}</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {board.activeSessions.map((row) => (
              <button
                key={row.sessionId}
                type="button"
                onClick={() => row.projectId != null && onOpenSession(row.projectId, row.sessionId)}
                className="max-w-56 truncate rounded bg-[var(--w-surface-2)] px-2 py-1 text-xs hover:bg-[var(--w-surface-3)]"
              >
                {row.title ?? row.sessionId.slice(0, 8)}
              </button>
            ))}
          </div>
        )}
      </div>

      {detailRoleId != null && (
        <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.roleProgress')}</span>
            <button
              type="button"
              onClick={() => setDetailRoleId(null)}
              className="rounded px-2 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
            >
              ✕
            </button>
          </div>
          <RoleProgressPanel roleId={detailRoleId} />
        </div>
      )}

      <GameBoard data={data} onOpenSession={onOpenSession} />

      <GrowthBoard />
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

/** 游戏看板（战况）+ 大屏卡族（coordinationFlow / decisionQueue）。 */
function GameBoard({
  data,
  onOpenSession,
}: {
  data: ReturnType<typeof useRpgData>;
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  const t = useT();
  const flowCard = BIG_SCREEN_CARDS[0]!;
  const decisionCard = BIG_SCREEN_CARDS[1]!;
  const flow = flowCard.derive({ runs: data.runs, questions: data.questions, sessions: data.sessions, rate: null, rateSeries: null }) as FlowEntryView[] | null;
  const decisions = decisionCard.derive({ runs: data.runs, questions: data.questions, sessions: data.sessions, rate: null, rateSeries: null }) as DecisionEntryView[] | null;

  return (
    <>
      <GameGraph orchestrations={data.orchestrations} sessionById={data.sessionById} onOpenSession={(sid) => {
        const row = data.sessionById.get(sid);
        if (row && row.projectId != null) onOpenSession(row.projectId, sid);
      }} />

      {/* 大屏卡族：只摆有数据（derive null = 不渲染） */}
      <div className="grid gap-3 lg:grid-cols-2">
        {flow && (
          <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t(flowCard.titleKey)}</div>
            <div className="flex flex-wrap gap-2">
              {flow.map((f) => (
                <span key={f.runId} className="rounded bg-[var(--w-surface-2)] px-2 py-1 text-xs">
                  #{f.runId} {f.orchName} · {t(`rpg.board${cap(f.gameStatus)}` as 'rpg.boardRunning')}
                </span>
              ))}
            </div>
          </div>
        )}
        {decisions && (
          <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t(decisionCard.titleKey)}</div>
            <div className="flex flex-col gap-1">
              {decisions.map((d) => (
                <div key={`${d.sessionId}:${d.at}`} className="truncate rounded bg-[var(--w-surface-2)] px-2 py-1 text-xs">
                  {d.title ?? d.sessionId}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {data.runs && data.runs.length === 0 && (
        <div className="text-xs text-[var(--w-text-dim)]">{t('rpg.boardIdle')}</div>
      )}
    </>
  );
}

/** 活跃会话（任务栏数据源）。 */
function useBoard(data: ReturnType<typeof useRpgData>) {
  return useMemo(() => {
    const activeSessions: SessionRow[] = [];
    for (const s of data.sessionById.values()) {
      const st = data.statuses.get(s.sessionId);
      if (st === 'running' || st === 'compacting') activeSessions.push(s);
    }
    return { activeSessions };
  }, [data.sessionById, data.statuses]);
}
