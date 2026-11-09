import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { useRpgData } from './use-rpg-data';
import { useRateSeries } from './use-rate';
import { CharacterSprite } from './CharacterSprite';
import { gameStatusOf } from './status-map';
import { GameGraph } from './GameGraph';
import { GrowthBoard } from './GrowthBoard';
import { RoleProgressPanel } from './RoleProgressPanel';
import { BIG_SCREEN_CARDS } from './bigscreen';
import type {
  DecisionEntryView,
  FlowEntryView,
  MetricsView,
  ReplayEntryView,
  ReviewEntryView,
} from './bigscreen';
import { buildRunTimeline } from '@/components/tasks/orchestration-run-board';
import { api, type SessionRow } from '@/lib/api';
import { SessionEditsDialog } from '@/components/tasks/SessionEditsDialog';
import { STATUS_BADGE } from '@/components/tasks/session-status';

/**
 * 共用协同状态视图（E4 验收②）：办公区 / 教室 / 会议室三场景的功能区块全在
 * 这里（角色卡阵 + 任务栏 + 修行详情 + 成长榜 + LR 图 + 大屏五卡）——同一份数据面
 * `useRpgData`，零功能分叉；`skin` 只声明呈现差异（容器/标题/徽标样式 + 一句
 * 场景注），三个场景组件各持一份皮肤常量。
 */

export type CollabSkin = 'office' | 'classroom' | 'meeting';

interface SkinFace {
  /** 内容容器（黑板 / 大屏 / 平铺 tile）。 */
  container: string;
  /** 区块壳。 */
  section: string;
  /** 区块标题。 */
  title: string;
  /** 徽标/条目底。 */
  chip: string;
  /** 场景注（null = 不摆）。 */
  hintKey: 'rpg.classroomHint' | 'rpg.meetingHint' | null;
}

const SKINS: Record<CollabSkin, SkinFace> = {
  office: {
    container: '',
    section: 'rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3',
    title: 'text-xs uppercase tracking-wide text-[var(--w-text-dim)]',
    chip: 'rounded bg-[var(--w-surface-2)] px-2 py-1 text-xs',
    hintKey: null,
  },
  classroom: {
    container: 'rpg-blackboard relative overflow-hidden rounded p-3',
    section: 'p-2',
    title: 'rpg-chalk mb-2 text-xs font-semibold tracking-wide',
    chip: 'rpg-chalk text-[11px]',
    hintKey: 'rpg.classroomHint',
  },
  meeting: {
    container: 'rpg-bigscreen relative overflow-hidden rounded p-4',
    section: 'p-2',
    title: 'mb-2 text-xs font-semibold text-[#69a9d6]',
    chip: 'rounded bg-[#376fa8]/30 px-2 py-1 text-[11px] text-neutral-200',
    hintKey: 'rpg.meetingHint',
  },
};

export function CollabScene({
  skin,
  onOpenSession,
}: {
  skin: CollabSkin;
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  const t = useT();
  const face = SKINS[skin];
  const data = useRpgData();
  const [detailRoleId, setDetailRoleId] = useState<number | null>(null);
  const activeSessions = useBoard(data);

  if (data.roles == null) {
    return <div className="p-8 text-sm text-[var(--w-text-dim)]">…</div>;
  }

  return (
    <div className={'flex min-h-0 flex-1 flex-col gap-3 ' + face.container}>
      {skin === 'meeting' && <span className="rpg-scanline" aria-hidden />}
      {data.roles.length > 0 && (
        <section className={face.section + ' min-h-0 flex-1 overflow-auto'}>
          <div className={'mb-2 ' + face.title}>
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
        </section>
      )}

      {/* 任务栏（在跑的会话） */}
      <section className={face.section}>
        <div className={'mb-1 ' + face.title}>{t('rpg.taskbar')}</div>
        {activeSessions.length === 0 ? (
          <div className={'text-xs text-[var(--w-text-dim)] ' + (skin === 'classroom' ? 'rpg-chalk' : '')}>
            {t('rpg.noActiveTasks')}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {activeSessions.map((row) => (
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
      </section>

      {detailRoleId != null && (
        <section className={face.section}>
          <div className="mb-2 flex items-center justify-between">
            <span className={face.title}>{t('rpg.roleProgress')}</span>
            <button
              type="button"
              onClick={() => setDetailRoleId(null)}
              className="rounded px-2 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
            >
              ✕
            </button>
          </div>
          <RoleProgressPanel roleId={detailRoleId} />
        </section>
      )}

      <GameGraph orchestrations={data.orchestrations} sessionById={data.sessionById} onOpenSession={(sid) => {
        const row = data.sessionById.get(sid);
        if (row && row.projectId != null) onOpenSession(row.projectId, sid);
      }} />

      <BigScreenCards data={data} face={face} />

      <GrowthBoard />

      {data.runs && data.runs.length === 0 && (
        <div className={'text-xs text-[var(--w-text-dim)] ' + (skin === 'classroom' ? 'rpg-chalk' : '')}>
          {t('rpg.boardIdle')}
        </div>
      )}
      {face.hintKey && <p className="text-[11px] text-neutral-600">{t(face.hintKey)}</p>}
    </div>
  );
}

/** 大屏五卡：只摆有数据（derive null = 不渲染）；批阅 = 既有改动汇总弹窗多一枚入口。 */
function BigScreenCards({
  data,
  face,
}: {
  data: ReturnType<typeof useRpgData>;
  face: SkinFace;
}) {
  const t = useT();
  const rate = useRateSeries();
  const [reviewSession, setReviewSession] = useState<ReviewEntryView | null>(null);
  const [openRunId, setOpenRunId] = useState<number | null>(null);

  const input = { runs: data.runs, questions: data.questions, sessions: data.sessions, rate: rate.rate, rateSeries: rate.series };
  const flow = BIG_SCREEN_CARDS[0]!.derive(input) as FlowEntryView[] | null;
  const decisions = BIG_SCREEN_CARDS[1]!.derive(input) as DecisionEntryView[] | null;
  const review = BIG_SCREEN_CARDS[2]!.derive(input) as ReviewEntryView[] | null;
  const replay = BIG_SCREEN_CARDS[3]!.derive(input) as ReplayEntryView[] | null;
  const metrics = BIG_SCREEN_CARDS[4]!.derive(input) as MetricsView[] | null;

  // 复盘卡展开的 run：详情（带 RunEvent state）按需取，展开那一拍才拉。
  const runDetail = useQuery({
    queryKey: ['rpg-run-detail', openRunId],
    queryFn: () => api.getOrchestrationRun(openRunId!),
    enabled: openRunId != null,
    staleTime: 15_000,
  });

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-2">
        {flow && (
          <section className={face.section}>
            <div className={'mb-2 ' + face.title}>{t('rpg.cardCoordination')}</div>
            <div className="flex flex-wrap gap-2">
              {flow.map((f) => (
                <span key={f.runId} className={face.chip}>
                  #{f.runId} {f.orchName} · {t(`rpg.board${cap(f.gameStatus)}` as 'rpg.boardRunning')}
                </span>
              ))}
            </div>
          </section>
        )}
        {decisions && (
          <section className={face.section}>
            <div className={'mb-2 ' + face.title}>{t('rpg.cardDecisionQueue')}</div>
            <div className="flex flex-col gap-1">
              {decisions.map((d) => (
                <div key={`${d.sessionId}:${d.at}`} className="truncate">
                  {d.title ?? d.sessionId}
                </div>
              ))}
            </div>
          </section>
        )}
        {review && (
          <section className={face.section}>
            <div className={'mb-2 ' + face.title}>{t('rpg.cardReview')}</div>
            <div className="flex flex-col gap-1">
              {review.map((r) => (
                <button
                  key={r.sessionId}
                  type="button"
                  onClick={() => setReviewSession(r)}
                  className="min-w-0 truncate text-left hover:opacity-80"
                >
                  {r.title ?? r.sessionId.slice(0, 8)}
                </button>
              ))}
            </div>
          </section>
        )}
        {replay && (
          <section className={face.section}>
            <div className={'mb-2 ' + face.title}>{t('rpg.cardReplay')}</div>
            <div className="flex flex-col gap-1">
              {replay.map((r) => {
                const open = openRunId === r.runId;
                const entries = open && runDetail.data?.run ? buildRunTimeline(runDetail.data.run) : null;
                return (
                  <div key={r.runId}>
                    <button
                      type="button"
                      onClick={() => setOpenRunId(open ? null : r.runId)}
                      className="min-w-0 w-full truncate text-left hover:opacity-80"
                    >
                      #{r.runId} {r.orchName} · {t(`rpg.board${cap(r.gameStatus)}` as 'rpg.boardDone')} · {r.deliveries}
                    </button>
                    {open && (
                      <ol className="mt-1 ml-3 space-y-0.5 border-l border-[var(--w-border)] pl-2">
                        {entries == null ? (
                          <li className="text-[10px] text-[var(--w-text-dim)]">…</li>
                        ) : (
                          entries.map((e, i) => (
                            <li key={i} className="text-[10px] text-[var(--w-text-dim)]">
                              {e.kind === 'start'
                                ? t('rpg.replayStart')
                                : e.kind === 'finish'
                                  ? t('rpg.replayFinish')
                                  : `${e.event!.from} → ${e.event!.to}${e.event!.error ? ` · ${e.event!.error}` : ''}`}
                            </li>
                          ))
                        )}
                      </ol>
                    )}
                    {open && r.error && <p className="ml-3 text-[10px] text-red-400">{r.error}</p>}
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {metrics && metrics[0] && (
          <section className={face.section}>
            <div className={'mb-2 ' + face.title}>{t('rpg.cardMetrics')}</div>
            <p className="text-lg font-semibold">
              {metrics[0].rate ?? '—'}
              <span className="ml-1 text-[10px] text-[var(--w-text-dim)]">{t('rpg.metricsRate')}</span>
            </p>
            {metrics[0].series && metrics[0].series.length > 0 && (
              <div className="mt-2 flex h-10 items-end gap-px" role="img" aria-label={t('rpg.cardMetrics')}>
                {metrics[0].series.map((n, i) => {
                  const max = Math.max(1, ...metrics[0]!.series!);
                  return (
                    <span
                      key={i}
                      className="flex-1 bg-[var(--w-accent)]"
                      style={{ height: `${Math.max(1, Math.round((n / max) * 40))}px` }}
                    />
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>

      {/* 批阅 = 既有改动汇总弹窗（A1 落的实现），大屏只是多一个入口 */}
      {reviewSession && (
        <SessionEditsDialog
          sessionId={reviewSession.sessionId}
          range={{ since: null, until: null }}
          open
          onClose={() => setReviewSession(null)}
        />
      )}
    </>
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

/** 活跃会话（任务栏数据源）。 */
function useBoard(data: ReturnType<typeof useRpgData>) {
  return useMemo(() => {
    const activeSessions: SessionRow[] = [];
    for (const s of data.sessionById.values()) {
      const st = data.statuses.get(s.sessionId);
      if (st === 'running' || st === 'compacting') activeSessions.push(s);
    }
    return activeSessions;
  }, [data.sessionById, data.statuses]);
}
