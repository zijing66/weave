import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type SessionRow, type SessionTerminal, type SessionWatchRow, type MessagingCapability, type AnswerPick, type PendingQuestionEntry, type WatchOn } from '@/lib/api';
import type { Harness } from '@weavecode/core/harness';
import { cn } from '@/lib/utils';
import { getDispatchDrag } from '@/lib/dnd';
import { sessionLabel } from '@/lib/hook-payload';
import { useT, type TFunc } from '@/i18n/I18nProvider';
import { Badge } from '@/components/ui/badge';
import { AgentBadge } from '@/components/AgentBadge';
import { Bell, BellRing, Check, Copy, FileWarning, HelpCircle, MessageSquareText, Pencil, Power, SquareTerminal, Trash2 } from 'lucide-react';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { useToast } from '@/components/Toast';
import { copyText } from '@/lib/clipboard';
import type { ActionState } from '@/lib/feedback-core';
import { STATUS_BADGE, STATUS_KEY, type SessionStatus } from './session-status';
import { WatchPicker } from './WatchPicker';
import { QuestionAnswer } from './QuestionAnswer';
import { SessionStatusIcon } from './SessionStatusIcon';
import { draftSessionIds, subscribeDraftChanges } from './draft-editor';

/** 行内动作按钮（常显示、20×20 正方形描边——与项目卡按钮同款视觉）。 */
const ACTION_BTN =
  'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-edge/[0.08] bg-edge/[0.02] text-neutral-500 transition-colors hover:border-edge/[0.16] hover:bg-edge/[0.08] hover:text-neutral-200';

/** 活动序重排落地周期（1 分钟）：事件流实时刷新行数据与成员增删，但既有行的
 *  重排只由这个定时器统一落地——活跃会话多在动时，更短的周期就是一直在滑。 */
export const RESORT_INTERVAL_MS = 60_000;
/** FLIP 位移动画时长：周期重排时卡片从旧位滑到新位。 */
const FLIP_DURATION_MS = 450;

/** 剩余存活（ms）：期限 − 现在。now 会落后于刚写入的 lastSeenAt（30s tick、时钟差），
 *  直接相减就把整窗算多一截（90 天显示成 91、1 小时显示成 2 小时）⇒ 封顶到本行自己的窗。 */
export function remainingMsOf(
  row: Pick<SessionRow, 'autoDeleteAt' | 'lastSeenAt'>,
  now: number,
): number {
  if (row.autoDeleteAt == null) return 0;
  return Date.parse(row.autoDeleteAt) - Math.max(now, Date.parse(row.lastSeenAt));
}

/** 有未发送草稿的会话（真源恒是 sessionStorage——草稿只在浏览器本地，服务端一无所知）。 */
function useDraftSessionIds(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => draftSessionIds());
  useEffect(() => {
    const sync = () =>
      setIds((prev) => {
        const next = draftSessionIds();
        // 成员没变就还回旧引用：写盘抖动不该带着整张列表重渲染
        return prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next;
      });
    sync();
    return subscribeDraftChanges(sync);
  }, []);
  return ids;
}

/** 会话行的最后更新时刻：跨天要认得出是哪天——当天只给时刻、昨天标「昨天」、更早
 *  补日期（往年带年份）。 */
export function lastSeenLabel(t: TFunc, iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return t('tasks.yesterday');
  return d.getFullYear() === today.getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 剩余存活倒计时文案：天/时/分三档（ceil）。档位看**取整后**的量（小时不超 23、
 *  分钟不超 59）——阈值卡原始毫秒会让同量在档边换单位说（1 小时跳「60 分钟」）。 */
export function remainingLabel(t: TFunc, remainingMs: number): string {
  const ms = Math.max(0, remainingMs);
  if (ms < 60_000) {
    return t('tasks.autoDeleteSoon');
  }
  const hours = Math.ceil(ms / 3_600_000);
  if (hours >= 24) {
    return t('tasks.autoDeleteInDays', { n: Math.ceil(ms / 86_400_000) });
  }
  const minutes = Math.ceil(ms / 60_000);
  if (minutes >= 60) {
    return t('tasks.autoDeleteInHours', { n: hours });
  }
  return t('tasks.autoDeleteInMinutes', { n: minutes });
}

/**
 * 会话排序口径（活动序）：lastSeenAt（最后一条 hook 事件时刻）倒序、createdAt
 * 决胜——活跃会话上浮、新会话落地即置顶、静默的沉底；对完全静默的列表等价于
 * 创建时间倒序（服务端列表恒 created_at 倒序，活动序是前端层的事）。
 */
export function byActivity(a: SessionRow, b: SessionRow): number {
  return (
    Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) ||
    Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
}

/** 一个终端块：块头（终端标识）+ 成员行（块内保持活动序）。 */
export interface TerminalBlock {
  kind: 'block';
  terminal: SessionTerminal;
  rows: SessionRow[];
}

/** 渲染项：终端块 或 未分组的散行。 */
export type SessionListEntry = TerminalBlock | { kind: 'row'; row: SessionRow };

/**
 * 终端分块（窗口管理）：**同一块可见屏幕**上的会话聚成一块，块的位置 = 首成员
 * 在活动序里的位置，块内保持活动序。没有屏幕信息的行（没装 hooks / 终端不支持
 * 反查 / pane 已关）不分组、原位留在块外——不猜它属于哪个终端。块里只有一个
 * 会话也照样立块头：块头答的是「这块屏在哪」，与会话数无关。
 */
export function groupByTerminal(rows: readonly SessionRow[]): SessionListEntry[] {
  const out: SessionListEntry[] = [];
  const blocks = new Map<string, TerminalBlock>();
  for (const row of rows) {
    const terminal = row.terminal;
    if (!terminal) {
      out.push({ kind: 'row', row });
      continue;
    }
    let block = blocks.get(terminal.id);
    if (!block) {
      block = { kind: 'block', terminal, rows: [] };
      blocks.set(terminal.id, block);
      out.push(block);
    }
    block.rows.push(row);
  }
  return out;
}

/**
 * 顺序快照合并（成员增删路径）：既有行的相对序**冻结**——会话更新不重排它们；
 * 只做两件即时的事：新行插到最前（它们是刚创建的，活动序必在顶）、消失行移除。
 * 真正的活动序重排交给周期 tick。`sorted` 提供成员集与新行先后。
 */
export function mergeNewRows(prev: readonly string[], sorted: readonly string[]): string[] {
  const live = new Set(sorted);
  const kept = prev.filter((id) => live.has(id));
  const known = new Set(kept);
  const fresh = sorted.filter((id) => !known.has(id));
  return [...fresh, ...kept];
}

/** 逐位相等（顺序快照比较；同一引用直接相等）。 */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * 活动序门控（会话列表与全局总览共用）：ids 随事件流实时算，落地序只在
 * 「成员变化」或 RESORT_INTERVAL_MS 周期 tick 时取快照——两次快照之间顺序
 * 冻结（不随事件实时跳动），行内容仍实时刷新。resetKey 变化 = 换了一批成员
 * （过滤条件变了），立即采用新序，不做增量合并。入参 ids 需已按活动序排好。
 */
export function useActivityOrder(ids: readonly string[], resetKey?: string): readonly string[] {
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const [applied, setApplied] = useState<readonly string[]>(ids);
  const keyRef = useRef(resetKey);

  // 成员增删（首载/新增/删除）→ 只增量落位：新行即时置顶、消失行即时移除，
  // 既有行保持相对序不动（不随会话更新重排）；活动序重排等周期 tick。
  useLayoutEffect(() => {
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey;
      setApplied(ids);
      return;
    }
    setApplied((prev) => {
      const next = mergeNewRows(prev, ids);
      return sameIds(prev, next) ? prev : next;
    });
  }, [ids, resetKey]);

  // 周期 tick：把攒下的活动变化统一落地；顺序没变就保持引用，不空转重渲染。
  useEffect(() => {
    const timer = window.setInterval(() => {
      setApplied((prev) => (sameIds(prev, idsRef.current) ? prev : idsRef.current));
    }, RESORT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  return applied;
}

/**
 * 行位移动画（FLIP）：重排时行从旧位平滑滑到新位。每次 commit 量一遍各行的
 * offsetTop 存快照（布局位，不受进行中 transform 影响）；下一拍位移了的行先
 * 瞬时摆回旧位，再过渡回新位。行元素以 id 为键登记进 rowEls。
 */
export function useFlipRows(rowEls: RefObject<Map<string, HTMLLIElement>>): void {
  const rowTops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const els = rowEls.current;
    if (els.size === 0) {
      rowTops.current = new Map();
      return;
    }
    const prev = rowTops.current;
    const tops = new Map<string, number>();
    const moved: Array<[HTMLLIElement, number]> = [];
    for (const [id, el] of els) {
      const top = el.offsetTop;
      tops.set(id, top);
      const old = prev.get(id);
      if (old !== undefined && Math.abs(old - top) >= 1) moved.push([el, old - top]);
    }
    rowTops.current = tops;
    if (moved.length === 0) return;
    for (const [el] of moved) el.style.transition = 'none';
    for (const [el, delta] of moved) el.style.transform = `translateY(${delta}px)`;
    void moved[0]![0].offsetHeight; // 回流固化起始位，再开过渡
    for (const [el] of moved) {
      el.style.transition = `transform ${FLIP_DURATION_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
      el.style.transform = '';
    }
  });
}

/**
 * 任务视图左栏：会话列表。行内元素 = 名称（title 回退 sessionId 前 8 位，
 * hover 出完整值可复制）+ 状态图标（运行中动效 / 打开静态）+ 事件计数 +
 * pendingTitle 徽标 + 幽灵会话自动清理倒计时 + 行内改名 + 指令拖拽落点。
 * 顺序 = 活动序（byActivity）：数据随事件流实时刷新，但顺序只在
 * RESORT_INTERVAL_MS 周期统一落（落位带 FLIP 滑动动画）——成员增删只做
 * 增行/删行（新行即时置顶），既有行不随会话更新重排。
 */
export function SessionList({
  sessions,
  statuses,
  selectedId,
  highlightId,
  onSelect,
  onRename,
  onDropDispatch,
  onOpenTerminal,
  openTerminalStateOf,
  onClosePane,
  closePaneStateOf,
  capabilities,
  inflightOf,
  questionOf,
  onAnswer,
  answerStateOf,
  answerFor,
  onSetAnswerFor,
  watchOf,
  watchStateOf,
  onSubscribeWatch,
  onUnwatch,
  onDelete,
  deleteStateOf,
}: {
  sessions: SessionRow[];
  statuses: Map<string, SessionStatus>;
  selectedId: string | null;
  /** 全局总览跳转定位：该行高亮边框 3s 后移除（selected 之外的临时指位）。 */
  highlightId?: string | null;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onDropDispatch: (dispatchId: number, sessionId: string) => void;
  onOpenTerminal: (sessionId: string) => void;
  /** 打开会话终端按钮的反馈态（loading → ✅ → 还原，防连点重复 spawn）。 */
  openTerminalStateOf?: (sessionId: string) => ActionState;
  /** 关掉会话所在的 pane（退出会话）——宿主随 pane 一起退出，会话行与对话保留。 */
  onClosePane: (sessionId: string) => void;
  /** 关 pane 按钮的反馈态（loading → ✅ → 还原）。 */
  closePaneStateOf?: (sessionId: string) => ActionState;
  /** 消息能力矩阵（服务端 MessagingSurface 派生，完整表不过滤；null = 未载）。 */
  capabilities: ReadonlyMap<Harness, MessagingCapability> | null;
  /** 该会话在途消息条数（服务端 SSE push 快照）——有则行首挂 amber 角标。 */
  inflightOf: (sessionId: string) => number;
  /** 该会话的待答阻塞问题（无 = 不挂起）。 */
  questionOf?: (sessionId: string) => PendingQuestionEntry | undefined;
  /** 远程作答（整 call 一次提交：问题键 + 选项下标 + 自定义输入文本；键序由
   *  服务端 harness 规格拼装）。 */
  onAnswer?: (sessionId: string, answers: AnswerPick[]) => void;
  /** 作答按钮的反馈态（loading → ✅ → 还原，防重复键序）。 */
  answerStateOf?: (sessionId: string) => ActionState;
  /** 待答弹窗目标（null = 关；entry 消失 = 全部答完/解除，弹窗随之自关）。
   *  受控：会话行图标与事件链（组头 tag / 画布卡片）共用同一份——单一弹窗
   *  实例，不叠开。 */
  answerFor: string | null;
  onSetAnswerFor: (sessionId: string | null) => void;
  /** 该会话当前的 pending 订阅行（无 = 未订阅）。 */
  watchOf?: (sessionId: string) => SessionWatchRow | undefined;
  /** 订阅按钮的反馈态（loading → ✅ → 还原）。 */
  watchStateOf?: (sessionId: string) => ActionState;
  /** 订阅（类型集 + 次数在弹窗里选；times null = 持久化）。 */
  onSubscribeWatch: (sessionId: string, on: WatchOn[], times: number | null) => void;
  /** 取消订阅。 */
  onUnwatch: (sessionId: string) => void;
  /** 删除该会话（含事件与派发；调用方负责确认与报错）。 */
  onDelete: (sessionId: string) => void;
  /** 删除按钮的反馈态（loading → ✅ → 还原）。 */
  deleteStateOf?: (sessionId: string) => ActionState;
}) {
  const t = useT();
  const { show } = useToast();
  /** 块头文案：同窗口多个 tab 时才标 Tab 号（单 tab 窗口标了只是噪音）。 */
  const blockTitle = (terminal: SessionTerminal): string =>
    terminal.tabsInWindow > 1
      ? t('tasks.terminalBlockTab', { w: terminal.windowId, t: terminal.tabId })
      : t('tasks.terminalBlock', { w: terminal.windowId });
  /** 提醒订阅弹窗目标（null = 关）。 */
  const [watchPickerFor, setWatchPickerFor] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [droppingId, setDroppingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 有未发送草稿的会话（输入框里还有字没发出去 → 行首蓝色消息图标）。 */
  const draftIds = useDraftSessionIds();

  // ---- 顺序门控：sortedIds 随事件流实时算，落地序只在「成员变化」或周期 tick
  // 时取快照（见 useActivityOrder）——两次快照之间顺序冻结（不随事件实时跳动），
  // 行内容（计数/状态/角标）仍实时刷新。
  const sortedIds = useMemo(
    () => sessions.slice().sort(byActivity).map((s) => s.sessionId),
    [sessions],
  );
  const appliedIds = useActivityOrder(sortedIds);

  /** 渲染顺序 = 冻结序，行数据取最新（冻结序落后于 sessions 的一帧里，未见的
   *  新行按新在前兜底置顶，commit 后即归位）。 */
  const rows = useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.sessionId, s] as const));
    const ordered: SessionRow[] = [];
    for (const id of appliedIds) {
      const s = byId.get(id);
      if (s) ordered.push(s);
    }
    const seen = new Set(ordered.map((s) => s.sessionId));
    const unseen = sessions.filter((s) => !seen.has(s.sessionId));
    return [...unseen, ...ordered];
  }, [sessions, appliedIds]);

  const rowEls = useRef(new Map<string, HTMLLIElement>());
  useFlipRows(rowEls);

  // 剩余存活倒计时走针：有到期行才起 30s 本地计时（纯展示刷新，不拉数据；
  // 事件流驱动的重渲染本身也在刷新读数，计时器只兜住完全静默的页面）。
  const [now, setNow] = useState(() => Date.now());
  const hasDeadline = sessions.some((s) => s.autoDeleteAt != null);
  useEffect(() => {
    if (!hasDeadline) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [hasDeadline]);

  useEffect(() => {
    if (editingId) inputRef.current?.focus();
  }, [editingId]);

  const startRename = (s: SessionRow): void => {
    setEditingId(s.sessionId);
    setDraft(s.title ?? '');
  };

  const commitRename = (): void => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
  };

  const copyId = (sessionId: string): void => {
    void copyText(sessionId).then((ok) => {
      if (!ok) {
        show('error', t('common.copyFailed'));
        return;
      }
      setCopiedId(sessionId);
      window.setTimeout(() => setCopiedId(null), 1500);
    });
  };

  /** 行元素登记（FLIP 按 id 量位移，散行与块内同一个口径）。 */
  const registerRow = (sessionId: string) => (el: HTMLLIElement | null) => {
    if (el) rowEls.current.set(sessionId, el);
    else rowEls.current.delete(sessionId);
  };

  /** 一行会话卡：分块内与散行共用同一份 JSX，位次容器由外层决定。 */
  const renderRow = (s: SessionRow): ReactNode => {
    const status = statuses.get(s.sessionId) ?? 'open';
    const selected = s.sessionId === selectedId;
    const cap = s.harness != null ? capabilities?.get(s.harness) : undefined;
    const watch = watchOf?.(s.sessionId);
    const inflight = inflightOf(s.sessionId);
    const openTermState = openTerminalStateOf?.(s.sessionId) ?? 'idle';
    const closePaneState = closePaneStateOf?.(s.sessionId) ?? 'idle';
    // 待答问题数不含收尾屏（那不是宿主的问题 tab，是整 call 的落定动作）
    const pendingCount = (questionOf?.(s.sessionId)?.questions ?? []).filter(
      (q) => !q.submit,
    ).length;
    // 转录没了 = `--resume` 接不回来（服务端判；行内提示 + 打开禁用）
    const noTranscript = s.transcriptPresent === false;
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(s.sessionId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(s.sessionId);
          }
        }}
        onDoubleClick={(e) => {
          // tooltip 承诺「双击改名」——行上直接双击即进编辑（铅笔为 hover 备选）
          e.stopPropagation();
          if (editingId !== s.sessionId) startRename(s);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDroppingId(s.sessionId);
        }}
        onDragLeave={() => setDroppingId((prev) => (prev === s.sessionId ? null : prev))}
        onDrop={(e) => {
          e.preventDefault();
          setDroppingId(null);
          const id = getDispatchDrag(e.dataTransfer);
          if (id !== null) onDropDispatch(id, s.sessionId);
        }}
        title={droppingId === s.sessionId ? t('tasks.dropTip') : sessionLabel(s.title, s.sessionId)}
        className={cn(
          'group flex flex-wrap cursor-pointer items-center gap-x-2 gap-y-1 rounded-xl border p-2 transition-colors',
          selected
            ? 'border-blue-500/50 bg-blue-500/10'
            : 'border-edge/[0.06] bg-neutral-900/50 hover:border-edge/[0.10] hover:bg-edge/[0.04]',
          highlightId === s.sessionId && 'border-rose-400/70',
          droppingId === s.sessionId && 'border-dashed border-blue-400/70 bg-blue-500/10',
        )}
      >
        {/* 状态图标：运行中 = harness 跑马灯动效（claude 星芒旋 /
            codex 六边形脉动），打开 = 同形静态，失败/关闭 = 状态点 */}
        <SessionStatusIcon status={status} harness={s.harness} />

        {editingId === s.sessionId ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setEditingId(null);
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder={t('tasks.renamePlaceholder')}
            className="min-w-0 flex-1 rounded border border-blue-500/40 bg-neutral-950 px-1.5 py-0.5 text-xs text-neutral-100 focus:outline-none"
          />
        ) : (
          <>
            {/* 第 1 行：名称 + 悬停操作（basis-full 徽标组强制换到第 2 行）。
                名称有最小宽度底线：卡片窄（窄侧栏/窄屏）到摆不下时按钮组整组
                折到下一行右对齐（ml-auto）——名称独占首行，不被七枚按钮挤瘪；
                折行跟卡片实际宽度走，与视口断点无关。 */}
            <span className="min-w-[8rem] flex-1 truncate text-xs font-medium text-neutral-200">
              {sessionLabel(s.title, s.sessionId)}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1 [&_svg]:pointer-events-none">
              {/* 消息信号同一格（与动作按钮同行、贴在按钮组左侧）：在途 amber
                  （服务端计数）与草稿 blue（纯前端——草稿只存 sessionStorage）。
                  纯指示、不可点：对话入口就是行本身。 */}
              {inflight > 0 && (
                <span
                  title={t('tasks.messageInflight', { n: inflight })}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-400/40 bg-amber-500/10 px-1 py-0.5 text-10 font-semibold leading-none text-amber-300"
                >
                  <MessageSquareText className="h-3 w-3" />
                  {inflight > 9 ? '9+' : inflight}
                </span>
              )}
              {draftIds.has(s.sessionId) && (
                <span
                  title={t('tasks.draftUnsent')}
                  className="inline-flex shrink-0 items-center rounded border border-blue-400/40 bg-blue-500/10 px-1 py-0.5 text-10 font-semibold leading-none text-blue-300"
                >
                  <MessageSquareText className="h-3 w-3" />
                </span>
              )}
              {/* 能力位由服务端派生（canOpenTerminal = harness 的 resume 槽有
                  openArgs），这里只渲染它——不自带 harness 白名单；路由侧仍做
                  同样的 501 校验。该会话的宿主进程活着（pidAlive）→ 终端图标
                  转绿：与项目卡同款「有终端在跑」信号。绿即「已开」，按钮一并
                  禁用——再点只会又 spawn 一个宿主进程抢同一会话。loading 的挂法
                  见 TasksPanel（一直挂到转绿），期间同样禁用。 */}
              {s.canOpenTerminal && (
                <button
                  type="button"
                  disabled={noTranscript || !!s.pidAlive || openTermState === 'loading'}
                  title={
                    noTranscript
                      ? t('tasks.transcriptMissingTip')
                      : s.pidAlive
                        ? t('tasks.sessionTerminalRunning')
                        : t('tasks.openSessionTerminal')
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTerminal(s.sessionId);
                  }}
                  className={cn(
                    ACTION_BTN,
                    // 已打开 / 开启中 / 转录已丢：不吃 hover 反馈（否则看着还能点）
                    (noTranscript || s.pidAlive || openTermState === 'loading') &&
                      'disabled:cursor-not-allowed hover:border-edge/[0.08] hover:bg-edge/[0.02] hover:text-neutral-500',
                  )}
                >
                  <FeedbackIcon
                    state={openTermState}
                    className="h-3 w-3"
                    icon={
                      <SquareTerminal
                        className={cn('h-3 w-3', s.pidAlive && 'text-emerald-400')}
                      />
                    }
                  />
                </button>
              )}
              {/* 关 pane / 退出会话：会话进程活着才出现（没得关就不占位）——
                  关掉 = 宿主随 pane 一起退出，会话行与它的对话照常保留，之后仍
                  可 --resume 接回。判活判不动的（codex / 新鲜会话 pidAlive=null）
                  一律不露，宁可少一个按钮也不给一条恒 409 的路。红色常显 +
                  二次确认（见 TasksPanel 的 closePaneTarget）：杀宿主的键。 */}
              {!!s.pidAlive && (
                <button
                  type="button"
                  title={t('tasks.closePaneTooltip')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClosePane(s.sessionId);
                  }}
                  className={cn(ACTION_BTN, 'text-red-400 hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-300')}
                >
                  <FeedbackIcon
                    state={closePaneState}
                    className="h-3 w-3"
                    icon={<Power className="h-3 w-3" />}
                  />
                </button>
              )}
              {/* 阻塞问答入口：该会话被 AskUserQuestion / 计划 / 权限确认
                  挂起时才出现（无待答不占位）——amber + 问题数角标，点开
                  远程作答弹窗。 */}
              {questionOf?.(s.sessionId) && (
                <button
                  type="button"
                  title={t('tasks.answerActiveTooltip', { n: pendingCount })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetAnswerFor(s.sessionId);
                  }}
                  className={cn(
                    ACTION_BTN,
                    'relative',
                    'border-amber-400/40 bg-amber-500/10 text-amber-300 hover:border-amber-400/60 hover:text-amber-200',
                  )}
                >
                  <HelpCircle className="h-3 w-3 text-amber-300" />
                  <span
                    aria-hidden
                    className="absolute -right-1 -top-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-amber-500 px-0.5 text-8 font-semibold leading-none text-black"
                  >
                    {pendingCount}
                  </span>
                </button>
              )}
              {/* 对话入口不在这儿：点行本体就把它摆进右栏（`onSelect` 同一实现），
                  这枚按钮曾与行点击重复，已移除；只剩在途消息的角标（行首）。 */}
              {/* 会话提醒订阅：点开选触发类型 + 次数 → 订阅下一条命中的消息。
                  已有订阅 = 铃铛亮起（amber）+ 角标显示**剩余次数**（持久化显
                  ∞）——每 fire 一次刷新即减一，不是初始配置的次数；
                  次数用尽订阅消失、铃铛自然回空。 */}
              {cap?.watch && (
                <button
                  type="button"
                  title={
                    watch
                      ? t('tasks.watchActiveTooltip', {
                          n: watch.remaining === null ? '∞' : String(watch.remaining),
                        })
                      : t('tasks.watchTooltip')
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    setWatchPickerFor(s.sessionId);
                  }}
                  className={cn(ACTION_BTN, 'relative')}
                >
                  <FeedbackIcon
                    state={watchStateOf?.(s.sessionId) ?? 'idle'}
                    className="h-3 w-3"
                    icon={
                      watch ? (
                        <BellRing className="h-3 w-3 text-amber-300" />
                      ) : (
                        <Bell className="h-3 w-3" />
                      )
                    }
                  />
                  {watch && (
                    <span
                      aria-hidden
                      className="absolute -right-1.5 -top-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-amber-500 px-0.5 text-8 font-semibold leading-none text-black"
                    >
                      {watch.remaining === null ? '∞' : watch.remaining}
                    </span>
                  )}
                </button>
              )}
              <button
                type="button"
                title={t('tasks.renameTip')}
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(s);
                }}
                className={ACTION_BTN}
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                title={copiedId === s.sessionId ? t('tasks.copied') : t('tasks.copySessionId')}
                onClick={(e) => {
                  e.stopPropagation();
                  copyId(s.sessionId);
                }}
                className={ACTION_BTN}
              >
                {copiedId === s.sessionId ? (
                  <Check className="h-3 w-3 text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
              <button
                type="button"
                title={t('tasks.deleteTooltip')}
                aria-label={t('tasks.deleteSession')}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s.sessionId);
                }}
                className={cn(ACTION_BTN, 'hover:text-red-400')}
              >
                <FeedbackIcon
                  state={deleteStateOf?.(s.sessionId) ?? 'idle'}
                  className="h-3 w-3"
                  icon={<Trash2 className="h-3 w-3" />}
                />
              </button>
            </span>
            {/* 第 2 行：徽标组（basis-full 恒换行，状态 Badge 固定第 2 行） */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 basis-full">
              {s.pendingTitle && (
                <Badge
                  title={t('tasks.renamePendingTip')}
                  className="shrink-0 bg-amber-900/40 text-amber-300"
                >
                  {t('tasks.pendingTitle')}
                </Badge>
              )}
              {/* 转录没了：会话行还在（采集出来的），但 `--resume` 接不回来——
                  说在行上，别让人点了才知道（悬停给「怎么补救」）。 */}
              {noTranscript && (
                <Badge
                  title={t('tasks.transcriptMissingTip')}
                  className="shrink-0 gap-1 bg-rose-900/40 text-rose-300"
                >
                  <FileWarning className="h-3 w-3" />
                  {t('tasks.transcriptMissing')}
                </Badge>
              )}
              <span className="shrink-0 text-10 text-neutral-500">
                {t('tasks.events', { n: s.eventCount ?? 0 })}
              </span>
              {/* 最后更新时刻（lastSeenAt = 最后一条 hook 事件），口径同全局总览会话行 */}
              <span className="shrink-0 text-10 text-neutral-500">
                {lastSeenLabel(t, s.lastSeenAt, now)}
              </span>
              {s.harness && (
                <AgentBadge agent={s.harness} className="shrink-0 px-1 text-10" />
              )}
              <Badge className={cn('shrink-0', STATUS_BADGE[status])}>
                {t(STATUS_KEY[status])}
              </Badge>
              {/* 剩余存活倒计时：服务端 autoDeleteAt 派生（两档——无 prompt 的
                  新会话 1 小时、收到过 prompt 的 n 天），SessionSweeper 过期即清
                  ——按剩余量级走天/时/分三档，到点前给用户留个明白账。 */}
              {s.autoDeleteAt && (
                <Badge className="shrink-0 bg-neutral-800/80 text-neutral-400">
                  {remainingLabel(t, remainingMsOf(s, now))}
                </Badge>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  /** 分块后的渲染项：同屏会话聚块，散行原位（见 groupByTerminal）。 */
  const entries = useMemo(() => groupByTerminal(rows), [rows]);

  return (
    <ul className="space-y-1.5">
      {entries.map((entry) =>
        entry.kind === 'row' ? (
          <li key={entry.row.sessionId} ref={registerRow(entry.row.sessionId)}>
            {renderRow(entry.row)}
          </li>
        ) : (
          // 块头：这一块可见屏幕的标识 + 会话数——同屏会话靠它分成一组。
          <li
            key={`terminal:${entry.terminal.id}`}
            className="rounded-xl border border-edge/[0.06] bg-edge/[0.02] p-2"
          >
            <div className="mb-1.5 flex items-center gap-1.5 text-10 text-neutral-400">
              <SquareTerminal className="h-3 w-3 shrink-0 text-neutral-500" />
              <span className="font-medium">{blockTitle(entry.terminal)}</span>
              <span className="text-neutral-500">
                {t('tasks.terminalBlockSessions', { n: entry.rows.length })}
              </span>
            </div>
            <ul className="space-y-1.5">
              {entry.rows.map((s) => (
                <li key={s.sessionId} ref={registerRow(s.sessionId)}>
                  {renderRow(s)}
                </li>
              ))}
            </ul>
          </li>
        ),
      )}
      {answerFor &&
        (() => {
          // 弹窗开着但待答面没了（答完/解除/会话删除）→ 随之自关
          const entry = questionOf?.(answerFor);
          if (!entry || entry.questions.length === 0) return null;
          return (
            <QuestionAnswer
              label={sessionLabel(
                sessions.find((s) => s.sessionId === answerFor)?.title ?? null,
                answerFor,
              )}
              entry={entry}
              busy={answerStateOf?.(answerFor) === 'loading'}
              onAnswer={(answers) => onAnswer?.(answerFor, answers)}
              onClose={() => onSetAnswerFor(null)}
            />
          );
        })()}
      {watchPickerFor && (
        <WatchPicker
          label={
            sessionLabel(
              sessions.find((s) => s.sessionId === watchPickerFor)?.title ?? null,
              watchPickerFor,
            )
          }
          current={watchOf?.(watchPickerFor) ?? null}
          busy={watchStateOf?.(watchPickerFor) === 'loading'}
          onSubscribe={(on, times) => {
            setWatchPickerFor(null);
            onSubscribeWatch(watchPickerFor, on, times);
          }}
          onUnwatch={() => {
            setWatchPickerFor(null);
            onUnwatch(watchPickerFor);
          }}
          onClose={() => setWatchPickerFor(null)}
        />
      )}
    </ul>
  );
}
