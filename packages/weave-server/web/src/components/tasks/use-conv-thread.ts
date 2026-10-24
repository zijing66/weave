import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HarnessLifecycle } from '@weavecode/core/harness';
import {
  api,
  type CommandExecutionRow,
  type HookEventRow,
  type SessionMessageRow,
  type SessionPlan,
} from '@/lib/api';
import { summarizeEvent } from '@/lib/hook-payload';
import { usePullLoad } from '@/lib/pull-load';
import { subscribeHook, type HookFrame } from '@/lib/sse';
import { HARNESS_COMPACTION } from './lifecycle';
import { useSessionStatus } from './session-status-store';
import {
  attachDeliveries,
  conversationOf,
  filterThread,
  isGenerating,
  failedTail,
  removableOf,
  withCommands,
  withPlan,
  readConvCache,
  writeConvCache,
  type ConvEntry,
  type ConvFilter,
} from './conv-model';

/** 一页对话条目（默认首屏窗口 = 最新这一页；向上翻页同宽）。 */
const CONV_PAGE = 10;

/** 生成中那一行的素材窗口：取最近多少条事件（展示只挑最新那条有内容的）。 */
const LIVE_FETCH = 40;

/**
 * 对话数据域：翻页加载（最新一页 + 向上取更早）、SSE 增量（三路共用一次防抖）、
 * 投递行认领（thread/outbox）、生成中滚动带、贴底跟随与拉动加载。
 * 数据形状与刷新节奏都在这里定，SessionMessages 只消费。
 */
export function useConvThread(deps: {
  sessionId: string;
  projectId: number;
  lifecycle: HarnessLifecycle;
  harness: string;
  /** 会话被阻塞问答挂起：尾部签名要带上它（那行也是「尾部进了新内容」）。 */
  answerPending: boolean;
  /** 挂起中不贴底（藏起来的扇子不抢滚动）。 */
  minimized: boolean;
}) {
  const { sessionId, projectId, lifecycle, harness, answerPending, minimized } = deps;
  const { statuses } = useSessionStatus();

  const fail = useCallback((e: unknown): void => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  /** 对话事件类型（开轮 + 闭轮 + 压缩收尾笔）：闭轮表为空的 harness 没有对话面可取。 */
  const convTypes = useMemo(
    () =>
      [lifecycle.open, ...lifecycle.close, (HARNESS_COMPACTION as Record<string, { end: string | null }>)[harness]?.end ?? ''].filter(
        Boolean,
      ),
    [harness, lifecycle],
  );

  // 首屏先给缓存（有就即时出画），loadNewest 那一页回来按 eventId 对账
  const [entries, setEntries] = useState<ConvEntry[] | null>(() => readConvCache(sessionId));
  /** 更早的那头翻到底了（事件保留期的起点）。 */
  const [headDone, setHeadDone] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [messages, setMessages] = useState<SessionMessageRow[] | null>(null);
  /** 生成中滚动带的素材（会话最近几十条事件；展示时只认本轮，见 liveItems）。 */
  const [liveEvents, setLiveEvents] = useState<HookEventRow[]>([]);
  /** 计划模式最近交出的那份计划（没进计划模式 / 正文取不到 = null，不摆气泡）。 */
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  /** 内建命令的执行回显（转录里认出来的；null = 这个 harness 不记）。 */
  const [executions, setExecutions] = useState<CommandExecutionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 历史过滤：全部 / 我 / 宿主回复 / 其他会话投递（只改显示，不动翻页游标与勾选）。 */
  const [filter, setFilter] = useState<ConvFilter>('all');

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
      const page = conversationOf(events, lifecycle, harness);
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
  }, [convTypes, fail, lifecycle, harness, projectId, sessionId]);

  /** 内建命令的执行回显（转录里认；没有该面的 harness 答 null = 不摆）。 */
  const loadExecutions = useCallback(async (): Promise<void> => {
    try {
      const r = await api.listCommandExecutions(sessionId);
      setExecutions(r.executions);
    } catch {
      setExecutions(null);
    }
  }, [sessionId]);

  /** 在途投递面（消息域管道视图，送达即删的本地队列 + 内存态）。 */
  const refreshMessages = useCallback(async (): Promise<void> => {
    try {
      setMessages(await api.listSessionMessages(sessionId));
      setError(null);
    } catch (e) {
      fail(e);
    }
  }, [fail, sessionId]);

  /** 生成中滚动带的素材：最近几十条事件（不分类型，工具调用才是有内容的那批）。
   *  纯装饰面——取不到就退回「生成中…」，不报错也不挡发送。 */
  const loadLive = useCallback(async (): Promise<void> => {
    try {
      setLiveEvents(await api.listSessionHooks(projectId, sessionId, LIVE_FETCH));
    } catch {
      // 装饰面失败静默：下一帧事件还会再来一次
    }
  }, [projectId, sessionId]);

  /** 计划正文（只读展示面）：取不到就当没有，不挡对话也不报错——多半是这轮没进
   *  计划模式，`plan: null` 才是常态。 */
  const loadPlan = useCallback(async (): Promise<void> => {
    try {
      setPlan(await api.sessionPlan(sessionId));
    } catch {
      setPlan(null);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadNewest();
    void refreshMessages();
    void loadPlan();
    void loadExecutions();
  }, [loadExecutions, loadNewest, loadPlan, refreshMessages]);

  useEffect(() => {
    if (entries && entries.length > 0) writeConvCache(sessionId, entries);
  }, [entries, sessionId]);

  // SSE：开/闭轮事件帧补对话尾部，其余事件帧刷生成中的滚动带，message.* 帧刷
  // 在途投递行（三路共用一次防抖）。**防抖窗内的事件只累加、不互相覆盖**：
  // 开轮帧后面紧跟着一票工具事件（500ms 内），按「最后一个帧说了算」排拍会把
  // 开轮那一拍顶掉——气泡要刷新页面才出来，正是这么来的。
  useEffect(() => {
    let timer: number | null = null;
    let wantConv = false;
    let wantMessages = false;
    let wantLive = false;
    let wantPlan = false;
    const onHook = (f: HookFrame): void => {
      if (f.sessionId !== sessionId) return;
      const ingested = f.kind === 'event.ingested';
      if (!ingested && !f.kind?.startsWith('message.') && f.kind !== 'question.pending') return;
      if (ingested) {
        wantLive = true;
        if (f.eventType === lifecycle.open || lifecycle.close.includes(f.eventType ?? '')) {
          wantConv = true;
        }
      } else if (f.kind === 'question.pending') {
        // 计划待批阅也走问答那条路（问句/选项归 harness，这边不认工具名）
        wantPlan = true;
      } else {
        wantMessages = true;
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const conv = wantConv;
        const messages = wantMessages;
        const live = wantLive;
        const planWanted = wantPlan;
        wantConv = wantMessages = wantLive = wantPlan = false;
        if (conv) void loadNewest();
        if (conv) void loadExecutions();
        if (messages) void refreshMessages();
        if (live) void loadLive();
        if (planWanted) void loadPlan();
      }, 500);
    };
    const off = subscribeHook(onHook);
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [lifecycle, loadExecutions, loadLive, loadNewest, loadPlan, refreshMessages, sessionId]);

  /** 向上翻页：游标 = 手上最旧那条的事件 id。 */
  const loadEarlier = useCallback(async (): Promise<void> => {
    const oldest = entries?.[0]?.eventId;
    if (oldest === undefined || loadingEarlier || headDone) return;
    setLoadingEarlier(true);
    try {
      const events = await api.listSessionHooks(projectId, sessionId, CONV_PAGE, oldest, convTypes);
      setHeadDone(events.length < CONV_PAGE);
      const older = conversationOf(events, lifecycle, harness);
      if (older.length > 0) {
        scrollFix.current = threadRef.current?.scrollHeight ?? null;
        setEntries((prev) => [...older, ...(prev ?? [])]);
      }
    } catch (e) {
      fail(e);
    } finally {
      setLoadingEarlier(false);
    }
  }, [
    convTypes,
    entries,
    fail,
    headDone,
    lifecycle,
    harness,
    loadingEarlier,
    projectId,
    sessionId,
  ]);

  /** 向上翻页插入新条目后要补的滚动高度（渲染后按差值补，视口不跳）。 */
  const scrollFix = useRef<number | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

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
  const { thread, outbox } = useMemo(
    () => attachDeliveries(withCommands(withPlan(entries ?? [], plan), executions), manualDeliveries),
    [entries, executions, manualDeliveries, plan],
  );
  /** 最新那条回复（计划也算一条）：缺省只展开它，更早的回复在气泡里收成三行。 */
  const newestAssistantKey = useMemo(() => {
    for (let i = thread.length - 1; i >= 0; i--) {
      if (thread[i]!.role === 'assistant') return thread[i]!.key;
    }
    return null;
  }, [thread]);
  /** 队尾那条**还没送出去的**（排队中 / 失败 / 超时）——只有它能出队回输入框改。
   *  已发出的不取回：它已经在会话那边了，放回输入框再发一遍就是重复发送
   *  （暂停闸成因行同理——那条能删能重发，但不给「改完再发」）。 */
  const newestQueuedId = [...outbox]
    .reverse()
    .find((m) => m.status !== 'delivered' && m.status !== 'delivering' && removableOf(m))?.id;
  /** 暂停闸成因行的清除倒计时走针：有带时刻的行才起 1s（纯展示，不拉数据）。 */
  const [now, setNow] = useState(() => Date.now());
  const clearDeadline = outbox.some((m) => m.stalled === true && m.releaseAt != null);
  useEffect(() => {
    if (!clearDeadline) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [clearDeadline]);

  // 贴底意图只在滚动时记：新内容一进 DOM 容器就变高，渲染完再判「是否贴底」必然
  // 判成「用户在上翻」，长回复于是永不跟随。尾条变了 = 尾部真进了新内容 → 跟随；
  // 向上翻页是往头部插，尾条不动、视口不被抢。
  const stick = useRef(true);
  const atBottom = (): boolean => {
    const el = threadRef.current;
    return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
  };
  /** 藏起来那一刻读到哪：切走的对话只藏不卸（`display:none` 拆掉布局盒），滚动
   *  位置跟着丢、切回来恒在 0 = 会话顶部。显形时按这份记录补回——原来贴着尾巴
   *  就仍贴尾巴（日常进来要看见最新那条）。 */
  const lastScroll = useRef({ top: 0, atBottom: true });
  // 判「重新显形」按尺寸 0 → 正，不按 minimized：藏它的既可能是 minimized，也可能是
  // 外层的抽屉/整屏容器，而这两条路都会让布局盒消失（高度归零）。
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    let shown = el.clientHeight > 0;
    const ro = new ResizeObserver(() => {
      const now = el.clientHeight > 0;
      if (now && !shown) {
        el.scrollTop = lastScroll.current.atBottom ? el.scrollHeight : lastScroll.current.top;
      }
      shown = now;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tailKey = thread[thread.length - 1]?.key;
  const status = statuses.get(sessionId);
  /** 尾上的在途提示：压缩中（状态总线同一判据；压缩与尾条是谁无关，照挂）显
   *  「压缩会话中…」，否则会话正在跑这一轮（含 5min 静默兜底）而尾条仍是用户
   *  那条 → 回复还在路上，显「生成中…」；中断态压在这两者之上（ESC 打断后宿主
   *  多不发 Stop，回合口子还开着，不先判它就会一直卡在「生成中…」）。
   *  压缩收尾那枚分隔也算「还没回话」：自动压缩常发生在一轮中间，收尾笔一落
   *  尾条就从 user 变成 compaction，不认它这一轮会一直不显「生成中…」。 */
  const compacting = status === 'compacting';
  const interrupted = status === 'interrupted';
  const generating = isGenerating(status, thread[thread.length - 1]?.role);
  /** 这一轮是失败收尾（API 报错）→ 尾上显那条错，压过「生成中…」与压缩态。 */
  const failed = interrupted ? null : failedTail(thread, outbox.length > 0);
  /** 滚动带只认**本轮**的事（晚到事件里混着上一轮的尾巴，同一份素材还要跨轮）：
   *  锚 = 最后一条用户条目的那个开轮事件，只取它之后；从新往旧找第一条有正文的
   *  （SessionStart 这类没有正文，不能让它把上一句顶成空白）。 */
  const liveText = useMemo(() => {
    const from = [...thread].reverse().find((e) => e.role === 'user')?.eventId ?? 0;
    for (let i = liveEvents.length - 1; i >= 0; i--) {
      const e = liveEvents[i]!;
      if (e.id <= from) break;
      const text = summarizeEvent(e).trim();
      if (text) return text;
    }
    return null;
  }, [liveEvents, thread]);
  /** 尾部签名 = 尾条 + 队列尾行 + 在途尾行：「生成中…」那行一出现也是尾部进了新内容，
   *  只认尾条键会让刚发送时气泡滚到了底、提示行却留在视口外（下次打开才对）；刚发出的
   *  消息先以队列气泡露面，那一行也是尾部。 */
  const queueSig = outbox.map((m) => `${m.id}:${m.status}${m.stalled === true ? '!' : ''}`).join(',');
  const tailSig = `${tailKey ?? ''}|${queueSig}|${generating ? 'g' : ''}${interrupted ? 'i' : ''}${
    answerPending ? 'a' : ''
  }`;
  const lastTail = useRef<string | undefined>(undefined);
  // 布局阶段就贴底（不是渲染完再补）：首屏那一页回来时先画在顶部再跳一下很难看
  useLayoutEffect(() => {
    if (minimized || entries === null || tailSig === lastTail.current) return;
    lastTail.current = tailSig;
    if (!stick.current) return;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, tailSig, minimized]);
  /** 内容包裹层：气泡里的异步内容（mermaid 图渲染完成、图片解码出尺寸）在贴底
   *  **之后**才撑高 scrollHeight——tail-follow 的依赖（entries/tailSig）不感知
   *  这种变化，尾部就留在视口外了。内容变高且仍贴着（stick）就补一记贴底；
   *  用户已上翻（stick=false）不抢视口。 */
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const inner = contentRef.current;
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (minimized || !stick.current) return;
      const el = threadRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [minimized]);

  const visible = useMemo(() => filterThread(thread, filter), [thread, filter]);
  /** 拉动加载（向上那头）：贴顶后继续滚/拖才取更早，且一拉只取一页。 */
  const pull = usePullLoad({
    axis: 'top',
    getEdge: () => (threadRef.current?.scrollTop ?? 1) <= 1,
    onFire: () => void loadEarlier(),
    enabled: entries !== null && !headDone && !loadingEarlier,
  });

  return {
    status,
    filter, setFilter,
    entries, setEntries, headDone, loadingEarlier, loadEarlier,
    thread, outbox, visible, newestAssistantKey, newestQueuedId, now,
    error, setError,
    threadRef, contentRef, scrollFix,
    stick, atBottom, lastScroll,
    compacting, interrupted, generating, failed, liveText,
    pull,
    refreshMessages,
  };
}
