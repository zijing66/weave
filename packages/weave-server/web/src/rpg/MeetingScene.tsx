import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { useRpgData } from './use-rpg-data';
import { useRateSeries } from './use-rate';
import { BIG_SCREEN_CARDS, type ReviewEntryView, type ReplayEntryView, type MetricsView } from './bigscreen';
import { buildRunTimeline } from '@/components/tasks/orchestration-run-board';
import { api, type OrchestrationRunRow } from '@/lib/api';
import { SessionEditsDialog } from '@/components/tasks/SessionEditsDialog';

/**
 * 会议室（大屏，E1）：北墙 20×14 tile 布局里占 10×5 tile 的大屏 = 展示与批阅位。
 * 三卡走 bigscreen.ts 注册表追加（reviewBoard / replay / metrics）：
 * - 批阅：既有 `SessionEditsDialog` 的只读复用（同数据源零新链路）——入口在大屏，
 *   弹窗本体是 A1 已落的实现，不复制；
 * - 复盘：run 日志回放（展开 = RunEvent 时间线，`buildRunTimeline` 既有派生）；
 * - 指标：dashboard 速率面同源（`useRateSeries`，同一 SSE 帧域 + 同一缓存）。
 * 卡只摆有数据（derive null = 不渲染）；选中项 2px 金色角标（rpg-gold-corner）。
 */
export function MeetingScene({
  data,
}: {
  data: ReturnType<typeof useRpgData>;
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  const t = useT();
  const rate = useRateSeries();
  const [reviewSession, setReviewSession] = useState<ReviewEntryView | null>(null);
  const [openRunId, setOpenRunId] = useState<number | null>(null);

  const input = { runs: data.runs, questions: data.questions, sessions: data.sessions, rate: rate.rate, rateSeries: rate.series };
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
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="rpg-bigscreen relative flex min-h-0 flex-1 flex-col overflow-hidden rounded p-4">
        <span className="rpg-scanline" aria-hidden />
        <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
          <div className="min-h-0 flex-1 overflow-auto">{review && <ReviewCard rows={review} onOpen={setReviewSession} />}</div>
          <div className="hidden w-2 shrink-0 self-stretch bg-[#171b2b] lg:block" aria-hidden />
          <div className="min-h-0 flex-1 overflow-auto">{replay && <ReplayCard rows={replay} openRunId={openRunId} detail={runDetail.data?.run ?? null} onToggle={setOpenRunId} />}</div>
          <div className="hidden w-2 shrink-0 self-stretch bg-[#171b2b] lg:block" aria-hidden />
          <div className="min-h-0 flex-1 overflow-auto">{metrics && <MetricsCard view={metrics[0]!} />}</div>
        </div>
      </div>
      <p className="text-[11px] text-neutral-600">{t('rpg.meetingHint')}</p>

      {/* 批阅 = 既有改动汇总弹窗（A1 落的实现），会议室只是多一个入口 */}
      {reviewSession && (
        <SessionEditsDialog
          sessionId={reviewSession.sessionId}
          range={{ since: null, until: null }}
          open
          onClose={() => setReviewSession(null)}
        />
      )}
    </div>
  );
}

function ReviewCard({ rows, onOpen }: { rows: ReviewEntryView[]; onOpen: (r: ReviewEntryView) => void }) {
  const t = useT();
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <section className="p-2">
      <h3 className="mb-2 text-xs font-semibold text-[#69a9d6]">{t('rpg.cardReview')}</h3>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.sessionId} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setPicked(r.sessionId);
                onOpen(r);
              }}
              className={
                'min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-[11px] text-neutral-200 hover:bg-[#376fa8]/30 ' +
                (picked === r.sessionId ? 'rpg-gold-corner' : '')
              }
            >
              {r.title ?? r.sessionId.slice(0, 8)}
            </button>
            <span className="shrink-0 text-[10px] text-neutral-500">{t('rpg.reviewOpenEdits')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReplayCard({
  rows,
  openRunId,
  detail,
  onToggle,
}: {
  rows: ReplayEntryView[];
  openRunId: number | null;
  detail: OrchestrationRunRow | null;
  onToggle: (runId: number | null) => void;
}) {
  const t = useT();
  const entries = useMemo(() => (detail ? buildRunTimeline(detail) : null), [detail]);
  return (
    <section className="p-2">
      <h3 className="mb-2 text-xs font-semibold text-[#69a9d6]">{t('rpg.cardReplay')}</h3>
      <ul className="space-y-1">
        {rows.map((r) => {
          const open = openRunId === r.runId;
          return (
            <li key={r.runId}>
              <button
                type="button"
                onClick={() => onToggle(open ? null : r.runId)}
                className={'w-full truncate rounded px-2 py-1 text-left text-[11px] text-neutral-200 hover:bg-[#376fa8]/30 ' + (open ? 'rpg-gold-corner' : '')}
              >
                #{r.runId} {r.orchName} · {t(`rpg.board${cap(r.gameStatus)}` as 'rpg.boardDone')} · {r.deliveries}
              </button>
              {open && (
                <ol className="mt-1 ml-3 space-y-0.5 border-l border-[#376fa8] pl-2">
                  {entries == null ? (
                    <li className="text-[10px] text-neutral-500">…</li>
                  ) : (
                    entries.map((e, i) => (
                      <li key={i} className="text-[10px] text-neutral-400">
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
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MetricsCard({ view }: { view: MetricsView }) {
  const t = useT();
  const series = view.series;
  const max = series ? Math.max(1, ...series) : 1;
  return (
    <section className="p-2">
      <h3 className="mb-2 text-xs font-semibold text-[#69a9d6]">{t('rpg.cardMetrics')}</h3>
      <p className="text-lg font-semibold text-neutral-100">
        {view.rate ?? '—'}
        <span className="ml-1 text-[10px] text-neutral-500">{t('rpg.metricsRate')}</span>
      </p>
      {series && series.length > 0 && (
        <div className="mt-2 flex h-10 items-end gap-px" role="img" aria-label={t('rpg.cardMetrics')}>
          {series.map((n, i) => (
            <span
              key={i}
              className="flex-1 bg-[#69a9d6]"
              style={{ height: `${Math.max(1, Math.round((n / max) * 40))}px` }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
