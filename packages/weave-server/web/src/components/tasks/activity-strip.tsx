import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, ChevronLeft, ChevronRight, ListChecks, RefreshCw, Terminal } from 'lucide-react';
import {
  api,
  type ActivityAgentRow,
  type ActivityShellRow,
  type ActivityTaskRow,
  type ActivityTranscriptSeg,
  type SessionActivity,
} from '@/lib/api';
import { registerInvalidator, subscribeHook, type HookFrame } from '@/lib/sse';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { cssPx, fontScale } from '@/lib/font-scale';
import { formatStamp } from '@/lib/hook-payload';

/**
 * 会话活动（第 21 能力槽 activity）：TUI statusline 下方那组子 agent 行的
 * dashboard 对应物 + 任务清单进度 + 后台 shell。
 *
 * 触发器 = 输入框那一排图标按钮里的一枚（与「图片/文件」同形），按钮上带数量；
 * **无活动时 disabled**（不摆空壳）。点开是 portal + fixed 的 popover（向上弹、
 * 盖在消息区上沿，不占布局——overflow 容器裁不掉）。详情在同一浮层内切视图
 * （不回显嵌套浮层）。codex（无 activity 槽）supported=false → 按钮恒 disabled。
 */

type Detail = { kind: 'agent'; agent: ActivityAgentRow } | { kind: 'shell'; shell: ActivityShellRow };

const POPOVER_W = 440;
const GAP = 6;
const MARGIN = 8;

/** 按钮与 popover 的计数判据：`has` = 摆不摆（无活动时按钮 disabled、不弹空壳）。 */
export function activityCountsOf(activity: SessionActivity | null): {
  agents: number;
  shells: number;
  tasksDone: number;
  tasksTotal: number;
  has: boolean;
} {
  // 只数「当前还在的」——server 已按存量过滤（已移除的不下发），状态照实展示。
  const agents = activity?.agents?.length ?? 0;
  const shells = activity?.shells?.length ?? 0;
  const rows = activity?.tasks ?? [];
  const tasksDone = rows.filter((r) => r.status === 'completed').length;
  return { agents, shells, tasksDone, tasksTotal: rows.length, has: agents + shells + rows.length > 0 };
}

/** 行时刻：子 agent 取最近写入、shell 取最近事件（缺省退回出生时刻）。 */
type Timed = { startedAt?: string | null; updatedAt?: string | null; lastSeenAt?: string | null };

export function timeOf(row: Timed): string | null {
  return row.updatedAt ?? row.lastSeenAt ?? row.startedAt ?? null;
}

/** 正在活动的数量（按钮上按类别分色展示）：agent/shell = running，任务 = in_progress。 */
export function runningCountsOf(activity: SessionActivity | null): {
  agents: number;
  tasks: number;
  shells: number;
} {
  return {
    agents: (activity?.agents ?? []).filter((a) => a.status === 'running').length,
    tasks: (activity?.tasks ?? []).filter((t) => t.status === 'in_progress').length,
    shells: (activity?.shells ?? []).filter((s) => s.status === 'running').length,
  };
}

/** 有时间的行按时间倒序（任务清单没有时间，秩由宿主管，不参与）。 */
export function recentFirst<T extends Timed>(rows: readonly T[]): T[] {
  const ms = (r: T): number => {
    const at = Date.parse(timeOf(r) ?? '');
    return Number.isFinite(at) ? at : 0;
  };
  return [...rows].sort((a, b) => ms(b) - ms(a));
}

/** 弹层几何（视觉 px）：宽度先按视口收（设计宽在窄屏/缩放后放不下），再夹 left。
 *  只夹 left 不收宽会算出负数、把弹层推到屏幕外。 */
export function popoverBox(
  anchorLeft: number,
  viewportW: number,
  scale = 100,
): { left: number; width: number } {
  const width = Math.min(POPOVER_W * (scale / 100), viewportW - MARGIN * 2);
  const left = Math.min(Math.max(anchorLeft, MARGIN), viewportW - width - MARGIN);
  return { left, width };
}

/** 时刻文案（全局同一格式；解析不出就不摆）。 */
function stampOf(row: Timed): string | null {
  const iso = timeOf(row);
  return iso && Number.isFinite(Date.parse(iso)) ? formatStamp(iso) : null;
}

export function ActivityButton({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const t = useT();
  const [activity, setActivity] = useState<SessionActivity | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  /** 左栏分区（打开时落在有内容的第一区；详情占右栏）。 */
  const [section, setSection] = useState<'agents' | 'tasks' | 'shells'>('agents');
  /** 「已停止」组的展开态（按分区；默认收起）。 */
  const [showStopped, setShowStopped] = useState({ agents: false, shells: false });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** 子 agent 详情已拉到的 offset（关弹层即弃）。 */
  const offsetRef = useRef<number | undefined>(undefined);
  const [agentSegs, setAgentSegs] = useState<ActivityTranscriptSeg[]>([]);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentDone, setAgentDone] = useState(false);
  const [shellText, setShellText] = useState<{ text: string; truncated: boolean } | null>(null);

  const lastLoadRef = useRef(0);
  const load = useCallback(() => {
    lastLoadRef.current = Date.now();
    api
      .sessionActivity(sessionId)
      .then((r) => setActivity(r.supported ? r : null))
      .catch(() => setActivity(null));
  }, [sessionId]);
  /** 子 agent 的工具事件很密：节流 1.5s，够覆盖「出生帧到了、转录文件还没建」的那一拍。 */
  const loadSoon = useCallback(() => {
    if (Date.now() - lastLoadRef.current < 1500) return;
    load();
  }, [load]);

  useEffect(load, [load]);
  useEffect(() => registerInvalidator('sessionActivity', load), [load]);

  // 子 agent 的任何帧（SubagentStart 与它自己的工具事件都带 agentId）——只认收尾帧
  // 的话，运行中的子 agent 要等它停了才会出现在面板上。后台 shell 出生同理。
  useEffect(
    () =>
      subscribeHook(
        (f: HookFrame) => {
          if (f.sessionId !== sessionId) return;
          if (f.agentId || f.spawnAgentId || f.bgShell || f.backgroundTasks) loadSoon();
        },
        ['event.ingested'],
      ),
    [sessionId, loadSoon],
  );

  // 存量由 server 定（已移除的不下发）；状态照实摆（completed 也是「当前存在」）。
  const agents = activity?.agents ?? [];
  const shells = activity?.shells ?? [];
  const taskRows = activity?.tasks ?? [];
  // 已停止的收纳：默认折叠，点开才展开（运行中的恒在面上）。两组各自按时间倒序。
  const runningAgents = recentFirst(agents.filter((a) => a.status === 'running'));
  const stoppedAgents = recentFirst(agents.filter((a) => a.status !== 'running'));
  const runningShells = recentFirst(shells.filter((s) => s.status === 'running'));
  const stoppedShells = recentFirst(shells.filter((s) => s.status !== 'running'));
  const counts = activityCountsOf(activity);
  const count = counts.agents + counts.shells;
  const doneTasks = counts.tasksDone;
  const hasActivity = counts.has;
  const running = runningCountsOf(activity);

  /** 向上弹：底边对齐按钮上沿，高度自底向上长（max-h 内滚），水平夹回视口。
   *  宽度也得跟着视口收——设计宽 440 在窄屏（手机、页面缩放后的视觉视口）上放不下，
   *  只夹 left 会算出负数、弹层溢出到屏幕外（缩放时还要乘上界面缩放）。 */
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const box = popoverBox(r.left, window.innerWidth, fontScale());
    setPos({
      left: cssPx(box.left),
      bottom: cssPx(window.innerHeight - r.top + GAP),
      width: cssPx(box.width),
    });
  }, [open]);

  // 点外部 / Esc / 滚动 / 缩放关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const n = e.target as Node;
      if (popRef.current?.contains(n) || btnRef.current?.contains(n)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    // 捕获阶段能收到内层列表的滚动——落在浮层里的不关，页面/外层滚了才关。
    const onScroll = (e: Event): void => {
      const n = e.target;
      if (n instanceof Node && (popRef.current?.contains(n) || btnRef.current?.contains(n))) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  // 打开时落在有内容的第一区（agents → shells → tasks）；收起即丢详情与游标。
  useEffect(() => {
    if (open) {
      const a = activity?.agents?.length ?? 0;
      const sh = activity?.shells?.length ?? 0;
      const tk = activity?.tasks?.length ?? 0;
      setSection(a > 0 ? 'agents' : sh > 0 ? 'shells' : tk > 0 ? 'tasks' : 'agents');
    }
  }, [open, activity]);

  useEffect(() => {
    if (!open) {
      setDetail(null);
      offsetRef.current = undefined;
      setAgentSegs([]);
      setShellText(null);
      setShowStopped({ agents: false, shells: false });
    }
  }, [open]);

  const openAgent = (agent: ActivityAgentRow): void => {
    offsetRef.current = undefined;
    setAgentSegs([]);
    setAgentDone(false);
    setDetail({ kind: 'agent', agent });
    setAgentLoading(true);
    api
      .agentTranscript(sessionId, agent.agentId)
      .then((r) => {
        setAgentSegs(r.segs);
        offsetRef.current = r.nextOffset ?? undefined;
        setAgentDone(r.nextOffset === null);
      })
      .catch(() => setAgentDone(true))
      .finally(() => setAgentLoading(false));
  };

  const moreAgent = (): void => {
    if (detail?.kind !== 'agent' || offsetRef.current === undefined) return;
    setAgentLoading(true);
    api
      .agentTranscript(sessionId, detail.agent.agentId, offsetRef.current)
      .then((r) => {
        setAgentSegs((prev) => [...prev, ...r.segs]);
        offsetRef.current = r.nextOffset ?? undefined;
        setAgentDone(r.nextOffset === null);
      })
      .catch(() => setAgentDone(true))
      .finally(() => setAgentLoading(false));
  };

  const openShell = (shell: ActivityShellRow): void => {
    setDetail({ kind: 'shell', shell });
    setShellText(null);
    api.shellOutput(sessionId, shell.taskId).then(setShellText).catch(() => setShellText(null));
  };

  const refreshShell = (): void => {
    if (detail?.kind !== 'shell') return;
    api.shellOutput(sessionId, detail.shell.taskId).then(setShellText).catch(() => setShellText(null));
  };

  const agentRow = (a: ActivityAgentRow) => (
    <button
      key={a.agentId}
      type="button"
      onClick={() => openAgent(a)}
      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-11 hover:bg-edge/[0.06]"
    >
      {/* 运行中 = 蓝脉动；已结束 = 灰点（绿色会读成还在跑/成功，进程停了只是停了）。 */}
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          a.status === 'running' ? 'animate-pulse bg-blue-400' : 'bg-neutral-600',
        )}
      />
      <span className="shrink-0 text-neutral-500">{a.agentType ?? 'agent'}</span>
      <span className="min-w-0 flex-1 truncate text-neutral-300">{a.description ?? a.agentId}</span>
      {stampOf(a) && <span className="shrink-0 text-10 tabular-nums text-neutral-600">{stampOf(a)}</span>}
    </button>
  );

  const shellRow = (s: ActivityShellRow) => (
    <button
      key={s.taskId}
      type="button"
      onClick={() => openShell(s)}
      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-11 hover:bg-edge/[0.06]"
    >
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          s.status === 'running' ? 'animate-pulse bg-blue-400' : 'bg-neutral-600',
        )}
      />
      <Terminal className="h-3 w-3 shrink-0 text-neutral-500" />
      <span className="min-w-0 flex-1 truncate font-mono text-neutral-300">
        {s.command ?? s.description ?? s.taskId}
      </span>
      {stampOf(s) && <span className="shrink-0 text-10 tabular-nums text-neutral-600">{stampOf(s)}</span>}
    </button>
  );

  /** 「已停止」收纳条：默认收起，点开才展开（运行中的行恒在面上）。 */
  const stoppedToggle = (key: 'agents' | 'shells', n: number) => (
    <button
      type="button"
      onClick={() => setShowStopped((v) => ({ ...v, [key]: !v[key] }))}
      className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-10 text-neutral-500 hover:bg-edge/[0.04] hover:text-neutral-300"
    >
      <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', showStopped[key] && 'rotate-90')} />
      <span className="min-w-0 flex-1 truncate">{t('tasks.activityStopped')}</span>
      <span className="shrink-0 tabular-nums">{n}</span>
    </button>
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={!hasActivity}
        title={hasActivity ? t('tasks.activityTitle') : t('tasks.activityNone')}
        aria-label={t('tasks.activityTitle')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          // 图标与图片/文件那两个同尺寸（12px、gap-1）；宽度恒按内容长（窄屏也
          // 不压成方钮——这枚按钮后面还挂着运行中的计数）
          'inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-11 text-neutral-300 transition-colors hover:border-blue-500/40 hover:text-blue-300 disabled:opacity-40 max-lg:h-6 max-lg:px-1',
          open && 'border-blue-500/40 text-blue-300',
        )}
      >
        <Bot
          className={cn(
            'h-3 w-3 shrink-0',
            busy && running.agents > 0 && 'animate-pulse text-blue-400',
          )}
        />
        <span className="max-lg:hidden">{t('tasks.activityButton')}</span>
        {/* 正在活动的数量按类别分色（子 agent 蓝 / 任务琥珀 / shell 紫）；都在停就退回总数。 */}
        {hasActivity && (
          <span className="flex shrink-0 items-center gap-1 tabular-nums">
            {running.agents > 0 && <span className="text-blue-400">{running.agents}</span>}
            {running.tasks > 0 && <span className="text-amber-400">{running.tasks}</span>}
            {running.shells > 0 && <span className="text-purple-400">{running.shells}</span>}
            {running.agents + running.tasks + running.shells === 0 && (
              <span className="text-neutral-500">{count || taskRows.length}</span>
            )}
          </span>
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label={t('tasks.activityTitle')}
            style={{ position: 'fixed', left: pos.left, bottom: pos.bottom, width: pos.width }}
            className="z-[70] flex max-h-[60vh] flex-col rounded-lg border border-edge/[0.12] bg-neutral-900 shadow-mac"
          >
            {/* 头部：详情视图给返回键 */}
            <div className="flex items-center gap-1.5 border-b border-edge/[0.08] px-2 py-1.5">
              {detail && (
                <button
                  type="button"
                  aria-label={t('tasks.activityBack')}
                  onClick={() => setDetail(null)}
                  className="rounded p-0.5 text-neutral-500 hover:bg-edge/[0.08] hover:text-neutral-200"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
              )}
              <span className="min-w-0 flex-1 truncate text-10 uppercase tracking-wide text-neutral-500">
                {detail
                  ? detail.kind === 'agent'
                    ? `${detail.agent.agentType ?? 'agent'} · ${detail.agent.description ?? detail.agent.agentId}`
                    : (detail.shell.command ?? detail.shell.description ?? detail.shell.taskId)
                  : t('tasks.activityTitle')}
              </span>
              {detail?.kind === 'shell' && (
                <button
                  type="button"
                  aria-label={t('tasks.activityRefresh')}
                  onClick={refreshShell}
                  className="rounded p-0.5 text-neutral-500 hover:bg-edge/[0.08] hover:text-neutral-200"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              )}
              <button
                type="button"
                aria-label={t('tasks.activityClose')}
                onClick={() => setOpen(false)}
                className="rounded p-0.5 text-neutral-500 hover:bg-edge/[0.08] hover:text-neutral-200"
              >
                <span className="text-11 leading-none">✕</span>
              </button>
            </div>

            {/* 体：左栏 = 分区（agents / tasks / shells）、右栏 = 该分区的行
                （布局同 `#` 会话引用选择器）；点行进详情，详情占右栏。 */}
            <div className="flex min-h-0 flex-1">
              <ul className="w-28 shrink-0 overflow-y-auto overscroll-contain border-r border-edge/[0.06] py-1">
                {(
                  [
                    { key: 'agents', label: t('tasks.activityAgents'), icon: Bot, count: `${stoppedAgents.length}/${agents.length}` },
                    { key: 'tasks', label: t('tasks.activityTasks'), icon: ListChecks, count: `${doneTasks}/${taskRows.length}` },
                    { key: 'shells', label: t('tasks.activityShells'), icon: Terminal, count: `${stoppedShells.length}/${shells.length}` },
                  ] as const
                ).map((s) => {
                  const empty = s.key === 'agents' ? agents.length === 0 : s.key === 'tasks' ? taskRows.length === 0 : shells.length === 0;
                  const Icon = s.icon;
                  return (
                    <li key={s.key}>
                      <button
                        type="button"
                        disabled={empty}
                        onClick={() => {
                          setDetail(null);
                          setSection(s.key);
                        }}
                        className={cn(
                          'flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-11 transition-colors',
                          empty && 'opacity-40',
                          !empty && section === s.key && !detail
                            ? 'bg-edge/[0.08] text-neutral-100'
                            : 'text-neutral-400 hover:bg-edge/[0.04]',
                        )}
                      >
                        <Icon className="h-3 w-3 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{s.label}</span>
                        <span className="shrink-0 tabular-nums text-10 text-neutral-500">{s.count}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {!detail ? (
                <>
                  {section === 'agents' && (
                    <>
                      {runningAgents.map(agentRow)}
                      {stoppedAgents.length > 0 && stoppedToggle('agents', stoppedAgents.length)}
                      {showStopped.agents && stoppedAgents.map(agentRow)}
                    </>
                  )}
                  {section === 'tasks' &&
                    taskRows.map((row: ActivityTaskRow) => (
                      <div key={row.id} className="flex items-center gap-1.5 px-1.5 py-1 text-11" title={row.subject}>
                        <span
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            row.status === 'completed'
                              ? 'bg-green-500'
                              : row.status === 'in_progress'
                                ? 'animate-pulse bg-blue-400'
                                : 'bg-neutral-600',
                          )}
                        />
                        <span className="min-w-0 truncate text-neutral-300">{row.activeForm ?? row.subject}</span>
                      </div>
                    ))}
                  {section === 'shells' && (
                    <>
                      {runningShells.map(shellRow)}
                      {stoppedShells.length > 0 && stoppedToggle('shells', stoppedShells.length)}
                      {showStopped.shells && stoppedShells.map(shellRow)}
                    </>
                  )}
                </>
              ) : detail.kind === 'agent' ? (
                <>
                  {agentSegs.length === 0 && !agentLoading && (
                    <p className="px-1 py-1 text-11 text-neutral-500">{t('tasks.activityAgentEmpty')}</p>
                  )}
                  {agentSegs.map((seg, i) => (
                    <p key={i} className="whitespace-pre-wrap break-words px-1 text-11 leading-relaxed text-neutral-300">
                      {seg.text}
                    </p>
                  ))}
                  {!agentDone && (
                    <button
                      type="button"
                      onClick={moreAgent}
                      disabled={agentLoading}
                      className="mt-1 px-1 text-11 text-blue-400 hover:text-blue-300 disabled:text-neutral-600"
                    >
                      {t('tasks.activityMore')}
                    </button>
                  )}
                </>
              ) : (
                <>
                  {shellText?.truncated && (
                    <p className="px-1 pb-1 text-10 text-neutral-500">{t('tasks.activityShellClamp')}</p>
                  )}
                  <pre className="whitespace-pre-wrap break-words px-1 font-mono text-11 leading-relaxed text-neutral-300">
                    {shellText?.text ?? t('tasks.activityShellEmpty')}
                  </pre>
                </>
              )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
