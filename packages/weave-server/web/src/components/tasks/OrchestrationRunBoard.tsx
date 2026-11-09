import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Link2 } from 'lucide-react';
import type {
  OrchestrationRunRow,
  OrchestrationRunStatus,
  ProjectRow,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/use-media-query';
import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { formatStamp } from '@/lib/hook-payload';
import {
  RUN_STATUS_BADGE,
  RUN_STATUS_KEY,
  TRIGGER_KEY,
} from './orchestration-canvas-nodes';
import {
  buildRunTimeline,
  groupRunsByStatus,
  type RunTimelineEntry,
} from './orchestration-run-board';

/**
 * 任务状态机看板：编排运行日志的看板视图（只读，run 状态机的镜子）——run 卡
 * 按状态分列，卡片展开即流转历史（RunEvent 时间线）。刷新走既有 SSE 编排帧
 * （数据由 useOrchRuns 供，这里零轮询）；视图态（展开列）不进 URL。
 * 移动端（<lg）退化为纵向堆叠的列段，不横向溢出（§11）。
 */
export function OrchestrationRunBoard({
  runs,
  projects,
  projectName,
  nodeLabel,
  expandedRunId,
  runDetail,
  onToggleRun,
}: {
  runs: readonly OrchestrationRunRow[] | null;
  projects: ProjectRow[];
  projectName: (id: number | null) => string;
  /** 节点标签（事件行 from/to）：与运行日志列表同一解析。 */
  nodeLabel: (nodeId: string) => string;
  expandedRunId: number | null;
  runDetail: Readonly<Record<number, OrchestrationRunRow>>;
  onToggleRun: (runId: number) => void;
}) {
  const t = useT();
  /** <lg 断点：列改纵向堆叠（use-media-query 唯一入口）。 */
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  /** 展开的列（收起其它列的卡身只留列头计数）；null = 全展开。 */
  const [collapsedCols, setCollapsedCols] = useState<ReadonlySet<OrchestrationRunStatus> | null>(
    null,
  );

  const columns = useMemo(() => (runs ? groupRunsByStatus(runs) : null), [runs]);

  if (columns == null) {
    return <p className="text-xs text-neutral-600">{t('hooks.loading')}</p>;
  }

  const toggleCol = (status: OrchestrationRunStatus): void => {
    setCollapsedCols((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  return (
    <div
      className={cn(
        'gap-2',
        isDesktop ? 'grid grid-cols-5' : 'flex min-w-0 flex-col',
      )}
    >
      {columns.map((col) => {
        const collapsed = collapsedCols?.has(col.status) ?? false;
        return (
          <section
            key={col.status}
            className={cn(
              'flex min-w-0 flex-col rounded-lg border border-edge/[0.06] bg-edge/[0.015]',
              isDesktop && 'min-h-0',
            )}
          >
            <button
              type="button"
              aria-expanded={!collapsed}
              onClick={() => toggleCol(col.status)}
              className="flex w-full items-center gap-1.5 rounded-t-lg px-2 py-1.5 text-left hover:bg-edge/[0.03]"
            >
              {collapsed ? (
                <ChevronRight className="h-3 w-3 shrink-0 text-neutral-500" />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" />
              )}
              <span className="min-w-0 truncate text-11 font-medium text-neutral-300">
                {t(col.labelKey)}
              </span>
              <span className="shrink-0 text-11 text-neutral-500">{col.runs.length}</span>
            </button>
            {!collapsed && (
              <div className="min-w-0 space-y-1 px-1.5 pb-1.5">
                {col.runs.length === 0 ? (
                  <p className="px-1 py-1 text-11 text-neutral-600">{t('orch.boardEmptyCol')}</p>
                ) : (
                  col.runs.map((run) => (
                    <RunBoardCard
                      key={run.id}
                      run={run}
                      detail={runDetail[run.id]}
                      expanded={expandedRunId === run.id}
                      onToggle={() => onToggleRun(run.id)}
                      projects={projects}
                      projectName={projectName}
                      nodeLabel={nodeLabel}
                      t={t}
                    />
                  ))
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RunBoardCard({
  run,
  detail,
  expanded,
  onToggle,
  projects,
  projectName,
  nodeLabel,
  t,
}: {
  run: OrchestrationRunRow;
  detail: OrchestrationRunRow | undefined;
  expanded: boolean;
  onToggle: () => void;
  projects: ProjectRow[];
  projectName: (id: number | null) => string;
  nodeLabel: (nodeId: string) => string;
  t: ReturnType<typeof useT>;
}) {
  const row = detail ?? run;
  const pending = Object.values(row.pendingCounts).reduce((sum, n) => sum + n, 0);
  const timeline = expanded ? buildRunTimeline(row) : [];
  const projName = projectName(projects.some((p) => p.id === row.projectId) ? row.projectId : null);
  return (
    <div className="rounded border border-edge/[0.06] bg-neutral-950/60">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="cursor-pointer px-1.5 py-1 hover:bg-edge/[0.03]"
      >
        <p className="min-w-0 truncate text-11 text-neutral-200">
          {row.orchestrationName || t('orch.untitled')}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <Badge className={cn('shrink-0', RUN_STATUS_BADGE[row.status])}>
            {t(RUN_STATUS_KEY[row.status])}
          </Badge>
          <span className="shrink-0 text-10 text-neutral-500">{t(TRIGGER_KEY[row.trigger])}</span>
          <span className="shrink-0 text-10 text-neutral-500">
            {t('orch.runDeliveries', { n: row.deliveries })}
          </span>
          {pending > 0 && (
            <span className="shrink-0 text-10 text-amber-400/80">
              {t('orch.runPending', { n: pending })}
            </span>
          )}
          <Tooltip label={t('orch.runStarted', { time: new Date(row.createdAt).toLocaleString() })}>
            <span className="shrink-0 text-10 text-neutral-600">{formatStamp(row.createdAt)}</span>
          </Tooltip>
        </div>
        {projName && (
          <p className="mt-0.5 truncate text-10 text-neutral-600">{projName}</p>
        )}
        {row.error && (
          <p className="mt-0.5 break-words text-10 text-red-400/80">{row.error}</p>
        )}
      </div>
      {expanded && (
        <div className="border-t border-edge/[0.04] px-1.5 py-1">
          {detail == null ? (
            <p className="text-10 text-neutral-600">{t('hooks.loading')}</p>
          ) : timeline.length <= 1 ? (
            <p className="text-10 text-neutral-600">{t('orch.runEventsEmpty')}</p>
          ) : (
            <ol className="space-y-0.5">
              {timeline.map((entry, i) => (
                <TimelineRow key={i} entry={entry} nodeLabel={nodeLabel} t={t} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function TimelineRow({
  entry,
  nodeLabel,
  t,
}: {
  entry: RunTimelineEntry;
  nodeLabel: (nodeId: string) => string;
  t: ReturnType<typeof useT>;
}) {
  if (entry.kind === 'start') {
    return (
      <li className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
        <span className="shrink-0 font-mono text-10 text-neutral-600">
          {formatStamp(entry.at)}
        </span>
        <span className="text-10 text-neutral-300">{t('orch.boardRunStart')}</span>
      </li>
    );
  }
  if (entry.kind === 'finish') {
    return (
      <li className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-500" />
        <span className="shrink-0 font-mono text-10 text-neutral-600">
          {formatStamp(entry.at)}
        </span>
        <span className="text-10 text-neutral-300">{t('orch.boardRunFinish')}</span>
      </li>
    );
  }
  const event = entry.event!;
  return (
    <li className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          event.ok ? 'bg-emerald-400' : 'bg-red-400',
        )}
      />
      <span className="shrink-0 font-mono text-10 text-neutral-600">{formatStamp(entry.at)}</span>
      <span className="shrink-0 text-10 text-neutral-300">
        {event.from ? nodeLabel(event.from) : t('orch.triggerManual')}
      </span>
      <Link2 className="h-2.5 w-2.5 shrink-0 text-neutral-600" />
      <span className="shrink-0 text-10 text-neutral-300">{nodeLabel(event.to)}</span>
      {event.stage === 'defer' && (
        <Badge className="shrink-0 bg-neutral-800 text-neutral-400">deferred</Badge>
      )}
      {event.stage === 'condition' && (
        <Badge
          className={cn(
            'shrink-0',
            event.ok ? 'bg-teal-900/40 text-teal-300' : 'bg-amber-900/40 text-amber-300',
          )}
        >
          {event.ok ? 'judged' : 'skipped'}
        </Badge>
      )}
      {!event.ok && event.stage !== 'condition' && (
        <Badge className="shrink-0 bg-red-900/40 text-red-300">failed</Badge>
      )}
      {(event.detail || event.error) && (
        <span
          className={cn(
            'min-w-0 flex-1 break-words text-10',
            event.ok
              ? 'text-neutral-500'
              : event.stage === 'condition'
                ? 'text-amber-400/70'
                : 'text-red-400/70',
          )}
        >
          {event.ok ? (event.detail ?? '') : (event.error ?? '')}
        </span>
      )}
    </li>
  );
}
