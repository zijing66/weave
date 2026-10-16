import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, RotateCcw, Send, Trash2, X } from 'lucide-react';
import type { HarnessLifecycle } from '@weavecode/core/harness';
import {
  api,
  type HookEventRow,
  type MessagingCapability,
  type SessionMessageRow,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { AssistantMarkdown } from '@/components/AiAssistant';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import {
  formatStamp,
  promptOf,
  stripPromptDecor,
  taskNotificationOf,
  turnSummaryOf,
} from '@/lib/hook-payload';
import { HARNESS_LIFECYCLE } from './lifecycle';
import { useSessionStatus, type HookFrame } from './session-status-store';

/** 一页对话条目（默认首屏窗口 = 最新这一页；向上翻页同宽）。 */
const CONV_PAGE = 10;

/** 投递行被事件认领的时间容差：同文案且时刻相近 = 同一条消息（正常通道秒级）。 */
const CLAIM_MS = 10 * 60_000;

/**
 * 对话缓存（sessionStorage）：重开弹窗先拿缓存即时出画，再被服务端那一页对账
 * 续接/替换——省掉每次开弹窗都等服务端那一趟，服务端压力也随之降下来。**时序
 * 由条目自带的 eventId 定**（合并游标就是它），缓存只是同一批条目的提前副本，
 * 不引入第二事实源：过期条目按 eventId 被服务端页覆盖，投递行（pipe）恒现拉。
 */
const CONV_CACHE_TTL_MS = 10 * 60_000;
const CONV_CACHE_MAX = 60;

/** 命中且没过期才用；读不出/写满了都当没有——缓存是加速，不是功能。 */
export function readConvCache(sessionId: string): ConvEntry[] | null {
  try {
    const raw = sessionStorage.getItem(`weave:conv:${sessionId}`);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { at?: number; entries?: ConvEntry[] };
    if (typeof cached.at !== 'number' || Date.now() - cached.at > CONV_CACHE_TTL_MS) return null;
    return cached.entries?.length ? cached.entries : null;
  } catch {
    return null;
  }
}

export function writeConvCache(sessionId: string, entries: readonly ConvEntry[]): void {
  try {
    sessionStorage.setItem(
      `weave:conv:${sessionId}`,
      JSON.stringify({
        at: Date.now(),
        // 只留尾巴若干条（够首屏用，别把长会话的翻页历史一直堆在会话存储里）；
        // 投递行是瞬时状态，不进缓存
        entries: entries
          .slice(-CONV_CACHE_MAX)
          .map(({ pipe: _pipe, ...entry }) => entry),
      }),
    );
  } catch {
    // 配额满 / 隐私模式禁写：静默降级成每次都拉服务端
  }
}

/** prompt 通道实际落法的展示键（socket 直投 / 中继 / 终端 send-text）。 */
const VIA_KEY: Record<
  NonNullable<SessionMessageRow['via']>,
  'tasks.msgViaSocket' | 'tasks.msgViaRelay' | 'tasks.msgViaTerminal'
> = {
  socket: 'tasks.msgViaSocket',
  relay: 'tasks.msgViaRelay',
  terminal: 'tasks.msgViaTerminal',
};

/** 消息状态徽标（在途 = 冷色，终态 = 绿/红）。 */
const STATUS_BADGE: Record<SessionMessageRow['status'], string> = {
  pending: 'bg-amber-900/40 text-amber-300',
  delivering: 'bg-sky-900/40 text-sky-300',
  running: 'bg-sky-900/40 text-sky-300',
  injected: 'bg-sky-900/40 text-sky-300',
  delivered: 'bg-emerald-900/40 text-emerald-300',
  succeeded: 'bg-emerald-900/40 text-emerald-300',
  failed: 'bg-red-900/40 text-red-300',
  timeout: 'bg-red-900/40 text-red-300',
};
const STATUS_KEY: Record<
  SessionMessageRow['status'],
  | 'tasks.msgStatusQueued'
  | 'tasks.msgStatusDelivering'
  | 'tasks.msgStatusRunning'
  | 'tasks.msgStatusInjected'
  | 'tasks.msgStatusDelivered'
  | 'tasks.msgStatusSucceeded'
  | 'tasks.msgStatusFailed'
  | 'tasks.msgStatusTimeout'
> = {
  pending: 'tasks.msgStatusQueued',
  delivering: 'tasks.msgStatusDelivering',
  running: 'tasks.msgStatusRunning',
  injected: 'tasks.msgStatusInjected',
  delivered: 'tasks.msgStatusDelivered',
  succeeded: 'tasks.msgStatusSucceeded',
  failed: 'tasks.msgStatusFailed',
  timeout: 'tasks.msgStatusTimeout',
};

/** 对话条目：用户投递的 prompt，或每轮 Stop 的最终总结消息。 */
export interface ConvEntry {
  key: string;
  /** 事件 id（向上翻页的游标锚）；只在尾巴上的投递行没有。 */
  eventId?: number;
  role: 'user' | 'assistant';
  at: string;
  text: string;
  /** weave 投递的（直投或中继）：正文里的运输装饰已摘掉，改在气泡上呈现 tag。 */
  fromWeave?: boolean;
  /** 中继壳里的发送方名（非 weave = 别的会话自己发的 CC 会话间消息）。 */
  fromName?: string | null;
  /** 认领到的投递行：状态/回执/重发挂在气泡上，不另起一条。 */
  pipe?: SessionMessageRow;
}

/**
 * 事件 → 对话条目：只认开轮（用户 prompt 原文）与闭轮（Stop 携带的最终
 * assistant 消息）两类事件。工具调用、通知、会话标记都不是对话，中间的
 * assistant 输出也不进——转录在会话自己那边，这里只要每轮的收尾总结。
 * prompt 原文先剥运输装饰（直投标记 / 中继壳 / 壳内单向注记）：装饰不是内容，
 * 留着既在气泡里露馅，也和投递行的原文对不上（同一条消息会显示两遍）。
 */
export function conversationOf(
  events: readonly HookEventRow[],
  lifecycle: HarnessLifecycle,
): ConvEntry[] {
  const out: ConvEntry[] = [];
  for (const e of events) {
    if (e.eventType === lifecycle.open) {
      // 子代理返回通知不是人发的 prompt（分组同口径丢弃）
      if (taskNotificationOf(e)) continue;
      const raw = promptOf(e);
      if (!raw) continue;
      const { text, fromWeave, fromName } = stripPromptDecor(raw);
      out.push({ key: `e${e.id}`, eventId: e.id, role: 'user', at: e.createdAt, text, fromWeave, fromName });
    } else if (lifecycle.close.includes(e.eventType)) {
      const text = turnSummaryOf(e);
      if (text)
        out.push({ key: `e${e.id}`, eventId: e.id, role: 'assistant', at: e.createdAt, text });
    }
  }
  return out;
}

/**
 * 文案归一（`claims` 的比对形态）：会话那侧的原文外面会被加东西（`stripPromptDecor`
 * 剥的那些）——剥掉、折叠空白，两侧才是同一形态（服务端回执比对是同一条规则，
 * 见 `message-deliverer.ts` 的 normalizePromptText；它另外只剥壳、不剥注记，
 * 因为那边是包含匹配）。
 */
function normalizeText(text: string): string {
  return stripPromptDecor(text).text.replace(/\s+/g, ' ').trim();
}

/** 投递行与事件条目是不是同一条消息（归一后全等）。 */
function claims(entryText: string, rowText: string): boolean {
  return normalizeText(entryText) === normalizeText(rowText);
}

/**
 * 投递行归位：同文案、时刻相近的事件条目认领它（不重复渲染）；认领不到的
 * ——Held/Refused 的「已送达」、失败、暂停闸成因、还没落进事件流的——排在
 * 对话尾巴上（丢在中间会翻不到，重发按钮也就没人点得到）。可见期沿用服务端
 * 驻留窗口（settled 60s、failed/timeout/stalled 常驻），本视图不再另设窗口。
 */
export function attachDeliveries(
  entries: readonly ConvEntry[],
  deliveries: readonly SessionMessageRow[],
): ConvEntry[] {
  const taken = new Set<string>();
  const claim = (entry: ConvEntry): SessionMessageRow | undefined => {
    let best: SessionMessageRow | undefined;
    let bestGap = CLAIM_MS;
    for (const m of deliveries) {
      if (taken.has(m.id) || !claims(entry.text, m.text)) continue;
      const gap = Math.abs(Date.parse(m.at) - Date.parse(entry.at));
      if (gap < bestGap) {
        best = m;
        bestGap = gap;
      }
    }
    if (best) taken.add(best.id);
    return best;
  };
  const out: ConvEntry[] = entries.map((entry) => {
    if (entry.role !== 'user') return entry;
    const pipe = claim(entry);
    return pipe ? { ...entry, pipe } : entry;
  });
  const orphan = deliveries
    .filter((m) => !taken.has(m.id))
    .map((m) => ({ key: `m${m.id}`, role: 'user' as const, at: m.at, text: m.text, pipe: m }))
    .sort((a, b) => a.at.localeCompare(b.at));
  return [...out, ...orphan];
}

/**
 * 会话对话弹窗：双向时间线 = 用户投递的消息 + 每轮 Stop 的最终总结，外加还
 * 没落进事件流的在途投递行（含暂停闸成因的重发入口）。历史就是既有的事件
 * 流本身——**不落库、不复制存储**，前端翻页直接查事件（`types` 只取开/闭
 * 轮两类，不拉整条事件链），翻过的页留在组件状态里，向上滚到顶再取更早。
 * 投递无模式选择——服务端恒走 prompt 通道全自动（原生 SendMessage 中继 →
 * 终端 send-text 降级 → 未开会话积压队列），故 web 不展示也不传 mode。
 * 刷新挂 App 转发的 weave:hook 帧（开/闭轮事件 + message.*，sessionId 定向），
 * 不新开轮询。
 */
export function SessionMessages({
  sessionId,
  projectId,
  label,
  projectLabel,
  capability,
  onClose,
}: {
  sessionId: string;
  /** 会话所属项目（路由锚点；会话可能采集到跨项目事件，过滤只按 sessionId）。 */
  projectId: number;
  /** 会话显示名（title 回退 sessionId 前 8 位，调用方已解好）。 */
  label: string;
  /** 项目目录名（标题副行）：跨项目同名会话只靠会话名分不清。 */
  projectLabel: string;
  /** 该会话 harness 的能力行（TasksPanel 从能力矩阵按 harness 取）。 */
  capability: MessagingCapability;
  onClose: () => void;
}) {
  const t = useT();
  const fb = useActionFeedback();
  const { statuses } = useSessionStatus();
  const lifecycle: HarnessLifecycle = HARNESS_LIFECYCLE[capability.harness];
  /** 对话事件类型（开轮 + 闭轮）：闭轮表为空的 harness 没有对话面可取。 */
  const convTypes = useMemo(
    () => [lifecycle.open, ...lifecycle.close].filter(Boolean),
    [lifecycle],
  );

  // 首屏先给缓存（有就即时出画），loadNewest 那一页回来按 eventId 对账
  const [entries, setEntries] = useState<ConvEntry[] | null>(() => readConvCache(sessionId));
  /** 更早的那头翻到底了（事件保留期的起点）。 */
  const [headDone, setHeadDone] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [messages, setMessages] = useState<SessionMessageRow[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  /** 向上翻页插入新条目后要补的滚动高度（渲染后按差值补，视口不跳）。 */
  const scrollFix = useRef<number | null>(null);

  const fail = useCallback((e: unknown): void => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  /** 最新一页：与手上这批重叠就续接（保留翻过的旧页），不重叠整批换成新页
   *  ——宁可重翻，也不留一段看不见的空档。 */
  const loadNewest = useCallback(async (): Promise<void> => {
    try {
      if (convTypes.length === 0) {
        setEntries([]);
        setHeadDone(true);
        return;
      }
      const events = await api.listSessionHooks(
        projectId,
        sessionId,
        CONV_PAGE,
        undefined,
        convTypes,
      );
      const page = conversationOf(events, lifecycle);
      setHeadDone(events.length < CONV_PAGE);
      setEntries((prev) => {
        const prevNewest = prev?.length ? prev[prev.length - 1]!.eventId : undefined;
        const pageOldest = page[0]?.eventId;
        if (prevNewest === undefined || pageOldest === undefined || pageOldest > prevNewest) {
          return page;
        }
        return [...prev!.filter((e) => (e.eventId ?? 0) < pageOldest), ...page];
      });
      setError(null);
    } catch (e) {
      fail(e);
    }
  }, [convTypes, fail, lifecycle, projectId, sessionId]);

  /** 在途投递面（消息域管道视图，送达即删的本地队列 + 内存态）。 */
  const refreshMessages = useCallback(async (): Promise<void> => {
    try {
      setMessages(await api.listSessionMessages(sessionId));
      setError(null);
    } catch (e) {
      fail(e);
    }
  }, [fail, sessionId]);

  useEffect(() => {
    void loadNewest();
    void refreshMessages();
  }, [loadNewest, refreshMessages]);

  useEffect(() => {
    if (entries && entries.length > 0) writeConvCache(sessionId, entries);
  }, [entries, sessionId]);

  // SSE：开/闭轮事件帧补对话尾部，message.* 帧刷在途投递行（各自防抖）
  useEffect(() => {
    let timer: number | null = null;
    const onHook = (e: Event): void => {
      const f = (e as CustomEvent<HookFrame>).detail ?? {};
      if (f.sessionId !== sessionId) return;
      const convEvent =
        f.kind === 'event.ingested' &&
        (f.eventType === lifecycle.open || lifecycle.close.includes(f.eventType ?? ''));
      if (!convEvent && !f.kind?.startsWith('message.')) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (convEvent) void loadNewest();
        else void refreshMessages();
      }, 500);
    };
    window.addEventListener('weave:hook', onHook);
    return () => {
      window.removeEventListener('weave:hook', onHook);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [lifecycle, loadNewest, refreshMessages, sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 向上翻页：游标 = 手上最旧那条的事件 id。 */
  const loadEarlier = useCallback(async (): Promise<void> => {
    const oldest = entries?.[0]?.eventId;
    if (oldest === undefined || loadingEarlier || headDone) return;
    setLoadingEarlier(true);
    try {
      const events = await api.listSessionHooks(projectId, sessionId, CONV_PAGE, oldest, convTypes);
      setHeadDone(events.length < CONV_PAGE);
      const older = conversationOf(events, lifecycle);
      if (older.length > 0) {
        scrollFix.current = threadRef.current?.scrollHeight ?? null;
        setEntries((prev) => [...older, ...(prev ?? [])]);
      }
    } catch (e) {
      fail(e);
    } finally {
      setLoadingEarlier(false);
    }
  }, [convTypes, entries, fail, headDone, lifecycle, loadingEarlier, projectId, sessionId]);

  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el || scrollFix.current === null) return;
    el.scrollTop += el.scrollHeight - scrollFix.current;
    scrollFix.current = null;
  }, [entries]);

  /** 人工投递才进对话：编排域的注入/无头消息不是用户说的话。 */
  const manualDeliveries = useMemo(
    () => (messages ?? []).filter((m) => m.mode === 'prompt'),
    [messages],
  );
  const thread = useMemo(
    () => attachDeliveries(entries ?? [], manualDeliveries),
    [entries, manualDeliveries],
  );

  // 贴底意图只在滚动时记：新内容一进 DOM 容器就变高，渲染完再判「是否贴底」必然
  // 判成「用户在上翻」，长回复于是永不跟随。尾条变了 = 尾部真进了新内容 → 跟随；
  // 向上翻页是往头部插，尾条不动、视口不被抢。
  const stick = useRef(true);
  const atBottom = (): boolean => {
    const el = threadRef.current;
    return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
  };
  const tailKey = thread[thread.length - 1]?.key;
  /** 会话正在跑这一轮（状态总线与会话行同一判据，含 5min 静默兜底）而尾条仍是
   *  用户那条 → 回复还在路上，尾上挂一枚「生成中」。 */
  const generating =
    statuses.get(sessionId) === 'running' && thread[thread.length - 1]?.role === 'user';
  const lastTail = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (entries === null || tailKey === lastTail.current) return;
    lastTail.current = tailKey;
    if (!stick.current) return;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, tailKey]);

  const send = (): void => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    stick.current = true; // 自己发的必然要看一眼，不因正翻历史而沉在底下
    void fb.run(
      `sendMsg:${sessionId}`,
      async () => {
        await api.sendSessionMessage(sessionId, { text });
        await refreshMessages();
      },
      { fail: (e) => t('tasks.msgSendFailed', { error: errorText(e) }) },
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[70dvh] max-lg:h-[88dvh] w-full max-w-lg flex-col rounded-xl border border-white/[0.08] bg-neutral-900 p-3 shadow-mac"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-neutral-200">
              {t('tasks.messagesTitle')} · {label}
            </p>
            <p className="truncate text-[10px] text-neutral-500">{projectLabel}</p>
          </div>
          <button
            type="button"
            title={t('tasks.messagesClose')}
            aria-label={t('tasks.messagesClose')}
            onClick={onClose}
            className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 对话 = 用户投递 + 每轮 Stop 的最终总结（历史查事件流，不落库）；
            尾巴上常驻还没落进事件流的投递行（Held/失败/暂停闸成因 + 重发） */}
        <div
          ref={threadRef}
          onScroll={() => {
            stick.current = atBottom();
            if ((threadRef.current?.scrollTop ?? 1) <= 24) void loadEarlier();
          }}
          className="min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden pr-1"
        >
          {entries === null ? (
            <p className="flex items-center justify-center gap-1.5 pt-6 text-xs text-neutral-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('hooks.loading')}
            </p>
          ) : thread.length === 0 ? (
            <p className="pt-6 text-center text-xs text-neutral-600">
              {t('tasks.messagesEmpty')}
            </p>
          ) : (
            <>
              {loadingEarlier && (
                <p className="flex items-center justify-center gap-1.5 pt-1 text-[10px] text-neutral-600">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('tasks.msgEarlier')}
                </p>
              )}
              {thread.map((m) => {
                if (m.role === 'assistant') {
                  return (
                    <div key={m.key} className="flex justify-start">
                      {/* 长内容（markdown 里没得换行的长串）在气泡自己里面横滚，
                          不把整块对话撑出横向滚动条 */}
                      <div className="min-w-0 max-w-[92%] overflow-x-auto rounded-lg border border-white/[0.08] bg-neutral-800/50 px-2 py-1.5">
                        <span className="mb-0.5 block text-[10px] text-neutral-600">
                          {formatStamp(m.at)}
                        </span>
                        <AssistantMarkdown text={m.text} />
                      </div>
                    </div>
                  );
                }
                const pipe = m.pipe;
                return (
                  <div key={m.key} className="flex items-end justify-end gap-1">
                    {/* 投递终态收成气泡左下角一枚小圆点：空心 = 已送达（可能被暂扣/拒收，
                        不等于已读），灰底白勾 = 已回执（会话真收到）。只有 weave 发出去的
                        消息才有这一步——终端里自己打的话没有投递可言。 */}
                    {pipe?.acked === true && (
                      <span
                        title={t('tasks.msgAcked')}
                        className="mb-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full bg-neutral-500 text-neutral-900"
                      >
                        <Check className="h-2 w-2" strokeWidth={3} />
                      </span>
                    )}
                    {pipe && pipe.acked !== true && pipe.status === 'delivered' && (
                      <span
                        title={t('tasks.msgDeliveredHint')}
                        className="mb-0.5 h-3 w-3 shrink-0 rounded-full border border-neutral-500"
                      />
                    )}
                    {/* weave 发的（右栏投递）保持蓝底，终端里自己打的走中性底 */}
                    <div
                      className={cn(
                        'min-w-0 max-w-[85%] overflow-x-auto rounded-lg border px-2 py-1.5',
                        pipe
                          ? 'border-blue-500/20 bg-blue-500/[0.06]'
                          : 'border-white/[0.08] bg-white/[0.02]',
                      )}
                    >
                      {/* 时刻与左侧回复气泡同布局：气泡上部、靠屏幕边缘那一侧
                          （这里右对齐），weave 来源 tag 与投递状态徽标和它并排 */}
                      <div className="mb-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        {m.fromWeave && (
                          <span className="shrink-0 rounded bg-blue-500/15 px-1 py-px text-[10px] font-medium text-blue-300">
                            weave
                          </span>
                        )}
                        {/* 不是 weave 发的会话间消息（别的会话用 CC 自己的 SendMessage）：
                            挂发送方会话名，与终端里手敲的 prompt 区分开 */}
                        {m.fromWeave !== true && m.fromName != null && (
                          <span className="shrink-0 rounded border border-white/[0.12] px-1 py-px text-[10px] text-neutral-400">
                            {m.fromName}
                          </span>
                        )}
                        {pipe !== undefined && pipe.status !== 'delivered' && (
                          <Badge className={cn('shrink-0', STATUS_BADGE[pipe.status])}>
                            {t(STATUS_KEY[pipe.status])}
                          </Badge>
                        )}
                        {pipe !== undefined && pipe.via != null && (
                          <span className="shrink-0 text-[10px] text-neutral-500">
                            {t(VIA_KEY[pipe.via])}
                          </span>
                        )}
                        {pipe?.stalled === true && (
                          <span className="shrink-0 text-[10px] text-amber-400">
                            {t('tasks.msgStalled')}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 text-[10px] text-neutral-600">
                          {formatStamp(m.at)}
                        </span>
                      </div>
                      {/* 投递原文同样走 markdown 预览（与左侧回复气泡同渲染器）；
                          `pre-wrap` 保住段落里的软换行——markdown 默认把单换行并成
                          一行，而用户常整段粘贴多行文本 */}
                      <div className="[&_p]:whitespace-pre-wrap">
                        <AssistantMarkdown text={m.text} />
                      </div>
                      {pipe?.error && (
                        <p className="mt-1 break-words text-[11px] text-red-400">{pipe.error}</p>
                      )}
                      {pipe &&
                        (pipe.status === 'failed' ||
                          pipe.status === 'pending' ||
                          pipe.stalled === true) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {(pipe.status === 'failed' || pipe.stalled === true) && (
                            <button
                              type="button"
                              disabled={fb.stateOf(`resend:${pipe.id}`) === 'loading'}
                              onClick={() =>
                                void fb.run(
                                  `resend:${pipe.id}`,
                                  async () => {
                                    await api.resendSessionMessage(sessionId, pipe.id);
                                    await refreshMessages();
                                  },
                                  { fail: (e) => t('tasks.msgResendFailed', { error: errorText(e) }) },
                                )
                              }
                              className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-950/30 px-1.5 py-0.5 text-[10px] text-amber-300 transition-colors hover:border-amber-500/50 disabled:opacity-40"
                            >
                              <FeedbackIcon
                                state={fb.stateOf(`resend:${pipe.id}`)}
                                className="h-3 w-3"
                                icon={<RotateCcw className="h-3 w-3" />}
                              />
                              {t('tasks.msgResend')}
                            </button>
                          )}
                          {/* 删除：这条从对话里彻底消失（是暂停闸成因时一并解闸并续排空；
                              还在队列里的 pending 行则是取消发送） */}
                          <button
                            type="button"
                            title={t(
                              pipe.status === 'pending'
                                ? 'tasks.msgDismissQueuedHint'
                                : 'tasks.msgDismissHint',
                            )}
                            disabled={fb.stateOf(`dismiss:${pipe.id}`) === 'loading'}
                            onClick={() =>
                              void fb.run(
                                `dismiss:${pipe.id}`,
                                async () => {
                                  await api.dismissSessionMessage(sessionId, pipe.id);
                                  await refreshMessages();
                                },
                                { fail: (e) => t('tasks.msgDismissFailed', { error: errorText(e) }) },
                              )
                            }
                            className="inline-flex items-center gap-1 rounded border border-white/[0.1] px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-white/20 hover:text-neutral-200 disabled:opacity-40"
                          >
                            <FeedbackIcon
                              state={fb.stateOf(`dismiss:${pipe.id}`)}
                              className="h-3 w-3"
                              icon={<Trash2 className="h-3 w-3" />}
                            />
                            {t('tasks.msgDismiss')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {generating && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-neutral-800/50 px-2 py-1.5 text-[10px] text-neutral-500">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('tasks.msgGenerating')}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {error && (
          <p className="mt-1 shrink-0 rounded border border-red-500/30 bg-red-950/30 px-2 py-1 text-[11px] text-red-300">
            {error}
          </p>
        )}

        {/* Composer：无模式选择（服务端恒 prompt 通道全自动）；层①② 皆无的
            harness 才置灰，理由取能力矩阵 unsupportedReasons.prompt。 */}
        <div className="mt-2 flex shrink-0 items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={t('tasks.messagesPlaceholder')}
            rows={2}
            className="min-w-0 flex-1 resize-none rounded border border-white/[0.1] bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 focus:outline-none focus:border-blue-500/40"
          />
          <button
            type="button"
            disabled={
              !capability.prompt ||
              !draft.trim() ||
              fb.stateOf(`sendMsg:${sessionId}`) === 'loading'
            }
            title={
              capability.prompt
                ? undefined
                : (capability.unsupportedReasons?.prompt ?? t('tasks.msgUnsupported'))
            }
            onClick={send}
            className="inline-flex shrink-0 items-center justify-center gap-1 rounded bg-blue-600/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
          >
            <FeedbackIcon
              state={fb.stateOf(`sendMsg:${sessionId}`)}
              className="h-3 w-3"
              icon={<Send className="h-3 w-3" />}
            />
            {t('tasks.messagesSend')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
