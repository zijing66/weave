import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCheck, Copy, Download, Image as ImageIcon, Loader2, RotateCcw, Send, Square, Trash2, X } from 'lucide-react';
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
import { useToast } from '@/components/Toast';
import { copyImage, copyText } from '@/lib/clipboard';
import {
  downloadBlob,
  imageFileName,
  renderConversationImage,
  type ConvImageEntry,
} from '@/lib/conv-image';
import { useMediaQuery } from '@/lib/use-media-query';
import { usePullLoad } from '@/lib/pull-load';
import { errorText, useActionFeedback, type ActionState } from '@/lib/action-feedback';
import {
  formatStamp,
  promptOf,
  stripPromptDecor,
  taskNotificationOf,
  turnSummaryOf,
} from '@/lib/hook-payload';
import { HARNESS_LIFECYCLE } from './lifecycle';
import { canInterrupt, hasTurnSignal } from './session-status';
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

/** 历史过滤：全部 / 只看自己发的 / 只看收到的回复（角色即过滤键）。 */
export type ConvFilter = 'all' | 'user' | 'assistant';

export const CONV_FILTERS = ['all', 'user', 'assistant'] as const;

const CONV_FILTER_KEY: Record<
  ConvFilter,
  'tasks.convFilterAll' | 'tasks.convFilterSent' | 'tasks.convFilterRecv'
> = {
  all: 'tasks.convFilterAll',
  user: 'tasks.convFilterSent',
  assistant: 'tasks.convFilterRecv',
};

export function filterThread(
  thread: readonly ConvEntry[],
  filter: ConvFilter,
): ConvEntry[] {
  return filter === 'all' ? [...thread] : thread.filter((e) => e.role === filter);
}

/** 导出用的时刻戳：本地 `YYYY-MM-DD HH:mm:ss`。展示用的 `formatStamp` 是给人扫的
 *  短形（当天只给时分秒），粘到别处会失去日期，导出单独一份。 */
export function exportStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 角色文案由调用方给（i18n 不写进纯函数），条目间空行分隔。 */
export function exportConversationText(
  entries: readonly ConvEntry[],
  labels: { user: string; assistant: string },
): string {
  return entries
    .map(
      (e) =>
        `[${exportStamp(e.at)}] ${e.role === 'user' ? labels.user : labels.assistant}\n${e.text}`,
    )
    .join('\n\n');
}

/** 触屏长按进多选的门槛：位移超过这个就当是滚动，不算长按。 */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 8;

/** 弹出菜单两副面孔：气泡右键（进多选）/ 底栏分享图片（复制 | 下载）。 */
type ConvMenu =
  | { kind: 'bubble'; x: number; y: number; key: string }
  | { kind: 'share'; x: number; y: number };

const MENU_W = 168;
const MENU_H = 72;

/** 进图片的条目：正文原样（剥运输装饰是展示层的事，这里就是气泡里那串文本）。 */
const toImageEntries = (entries: readonly ConvEntry[]): ConvImageEntry[] =>
  entries.map((e) => ({ role: e.role, at: e.at, text: e.text }));

/** 弹窗尺寸：宽度跟屏幕走（宽屏优先，窄屏交给 `w-full` 类），拖角可改并记住；
 *  高度缺省 0 = 不设行内高度，沿用 dvh 类（移动端地址栏伸缩才不失效）。 */
type ConvSize = { w: number; h: number };
const CONV_SIZE_KEY = 'weave:conv-size';
const SIZE_MIN = { w: 320, h: 220 };

const clampConvSize = (w: number, h: number): ConvSize => ({
  w: Math.min(Math.max(Math.round(w), SIZE_MIN.w), Math.max(SIZE_MIN.w + 40, innerWidth - 32)),
  h:
    h > 0
      ? Math.min(Math.max(Math.round(h), SIZE_MIN.h), Math.max(SIZE_MIN.h + 40, innerHeight - 32))
      : 0,
});

/** 默认宽 = 视口 62%，1100px 封顶（宽屏优先但不铺满整屏）。 */
const defaultConvSize = (): ConvSize =>
  clampConvSize(Math.min(1100, Math.round(innerWidth * 0.62)), 0);

function loadConvSize(): ConvSize {
  try {
    const raw = JSON.parse(localStorage.getItem(CONV_SIZE_KEY) ?? 'null') as ConvSize | null;
    if (!raw || typeof raw.w !== 'number' || typeof raw.h !== 'number') return defaultConvSize();
    return clampConvSize(raw.w, raw.h);
  } catch {
    return defaultConvSize();
  }
}

/** 多选态气泡旁的勾选框（点击面是整个气泡，这里只显示状态）。
 *  位置贴在气泡的「内容那一侧」的上沿：自己发的在气泡左边、回复在气泡右边
 *  （两类气泡的正文都朝中间流），`self-start` 让它在底部对齐的行里仍贴顶。 */
function CheckBox({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center self-start rounded border',
        on ? 'border-blue-400 bg-blue-500 text-white' : 'border-neutral-600 bg-neutral-900',
        className,
      )}
    >
      {on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
    </span>
  );
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
  onInterrupt,
  interruptStateOf,
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
  /** 停止会话（向 pane 打一记 ESC）：与事件链组头那枚同一实现、同一 fb 键，
   *  两处按钮同转同灭。 */
  onInterrupt: (sessionId: string) => void;
  interruptStateOf: (sessionId: string) => ActionState;
  onClose: () => void;
}) {
  const t = useT();
  const { show } = useToast();
  const fb = useActionFeedback();
  const { statuses, sessions } = useSessionStatus();
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
  const [filter, setFilter] = useState<ConvFilter>('all');
  /** 多选态：气泡上出现复选框，点气泡即勾选，底栏换成工具条。 */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  /** 弹出菜单（位置 = 指针处）：气泡右键（那条一并勾上）与底栏「分享图片」共用一套
   *  外点关闭/Esc/滚轮退场，故只留一份状态、用 kind 分面。 */
  const [menu, setMenu] = useState<ConvMenu | null>(null);
  const [size, setSize] = useState<ConvSize>(() => loadConvSize());
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const threadRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 向上翻页插入新条目后要补的滚动高度（渲染后按差值补，视口不跳）。 */
  const scrollFix = useRef<number | null>(null);
  const grip = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  /** 标题栏拖动（移动整扇窗）：与拖角改大小是两回事。 */
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  /** 长按刚生效那一下：抬手还会补一个 click，得吞掉（否则勾上又立刻勾掉）。 */
  const suppressTap = useRef<string | null>(null);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const coarse = useMediaQuery('(pointer: coarse)');

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

  // Esc 逐层退：右键菜单 → 多选态 → 关弹窗（一层层退出，不一把关掉）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (menu) setMenu(null);
      else if (selecting) {
        setSelecting(false);
        setPicked(new Set());
      } else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, onClose, selecting]);

  // 菜单外点一下就关（并吞掉这一下：否则同一击会顺手把整扇弹窗关掉）
  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: Event): void => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-conv-menu]')) return;
      e.stopPropagation();
      setMenu(null);
    };
    const close = (): void => setMenu(null);
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('contextmenu', dismiss, true);
    window.addEventListener('wheel', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('contextmenu', dismiss, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  useEffect(
    () => () => {
      if (press.current) window.clearTimeout(press.current.timer);
    },
    [],
  );

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
  const status = statuses.get(sessionId);
  /** 尾上的在途提示：压缩中（状态总线同一判据；压缩与尾条是谁无关，照挂）显
   *  「压缩会话中…」，否则会话正在跑这一轮（含 5min 静默兜底）而尾条仍是用户
   *  那条 → 回复还在路上，显「生成中…」。 */
  const compacting = status === 'compacting';
  const generating =
    compacting || (status === 'running' && thread[thread.length - 1]?.role === 'user');
  const lastTail = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (entries === null || tailKey === lastTail.current) return;
    lastTail.current = tailKey;
    if (!stick.current) return;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, tailKey]);

  const visible = useMemo(() => filterThread(thread, filter), [thread, filter]);
  /** 拉动加载（向上那头）：贴顶后继续滚/拖才取更早，且一拉只取一页。 */
  const pull = usePullLoad({
    axis: 'top',
    getEdge: () => (threadRef.current?.scrollTop ?? 1) <= 1,
    onFire: () => void loadEarlier(),
    enabled: entries !== null && !headDone && !loadingEarlier,
  });
  /** 停止（与事件链组头同一判据；无回合信号的 harness 传 undefined 回落状态）。 */
  const stoppable = canInterrupt(
    status ?? 'open',
    hasTurnSignal(capability.harness)
      ? sessions?.find((s) => s.sessionId === sessionId)?.turnOpen
      : undefined,
  );

  const togglePick = (key: string): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const enterSelect = (key?: string): void => {
    setMenu(null);
    setSelecting(true);
    if (key !== undefined) setPicked(new Set([key]));
  };

  /** 勾上的条目（顺序 = 对话序，与手上这批的顺序一致）。 */
  const pickedEntries = (): ConvEntry[] => thread.filter((e) => picked.has(e.key));

  /** 全选的范围 = 已加载的全部条目（不是当前过滤可见的那些：过滤只看显示，
   *  勾选面不跟着变，正如过滤不收回已有的勾）。 */
  const allPicked = thread.length > 0 && thread.every((e) => picked.has(e.key));
  const toggleAll = (): void =>
    setPicked(allPicked ? new Set() : new Set(thread.map((e) => e.key)));

  const copyPicked = (): void => {
    const chosen = pickedEntries();
    if (chosen.length === 0) return;
    const text = exportConversationText(chosen, {
      user: t('tasks.convRoleUser'),
      assistant: t('tasks.convRoleAssistant'),
    });
    // 通知权限那类失败不静默：复制失败要让用户看得见（还可手动选文本）。
    void copyText(text).then((ok) =>
      show(
        ok ? 'success' : 'error',
        ok ? t('tasks.convCopyOk', { n: chosen.length }) : t('tasks.convCopyFailed'),
      ),
    );
  };

  /** 对话 → 图片：canvas 文本卡片，复制到剪贴板或下载 PNG。生成失败与「浏览器
   *  不给写剪贴板」都当失败报出去（后者引导走下载）。 */
  const shareImage = (to: 'clipboard' | 'download'): void => {
    const chosen = pickedEntries();
    if (chosen.length === 0) return;
    setMenu(null);
    void fb.run(
      `convImg:${sessionId}`,
      async () => {
        let blob: Blob;
        try {
          blob = await renderConversationImage(toImageEntries(chosen), {
            title: label,
            subtitle: `${projectLabel} · ${t('tasks.convImgSubtitle', {
              at: exportStamp(new Date().toISOString()),
              n: chosen.length,
            })}`,
            labels: { user: t('tasks.convRoleUser'), assistant: t('tasks.convRoleAssistant') },
            stamp: exportStamp,
          });
        } catch (e) {
          throw new Error(t('tasks.convImgFailed', { error: errorText(e) }));
        }
        if (to === 'download') {
          downloadBlob(blob, imageFileName(label));
          show('success', t('tasks.convImgSaved'));
        } else if (await copyImage(blob)) {
          show('success', t('tasks.convImgOk', { n: chosen.length }));
        } else {
          throw new Error(t('tasks.convImgCopyFailed'));
        }
      },
      { fail: errorText },
    );
  };

  /** 分享菜单往上开：底栏在下沿，向下没有可用的地方。 */
  const openShareMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ kind: 'share', x: r.right - MENU_W, y: r.top - MENU_H });
  };

  /** 触屏长按进多选（桌面走右键菜单；鼠标不该有长按这回事）。 */
  const onPressDown = (key: string) => (e: React.PointerEvent): void => {
    // 上一轮长按若没等到补发的那个 click，别把这一次的点击也吞了
    suppressTap.current = null;
    if (!coarse || selecting || e.button !== 0) return;
    const timer = window.setTimeout(() => {
      press.current = null;
      suppressTap.current = key;
      enterSelect(key);
    }, LONG_PRESS_MS);
    press.current = { x: e.clientX, y: e.clientY, timer };
  };
  const onPressMove = (e: React.PointerEvent): void => {
    const p = press.current;
    if (!p) return;
    if (Math.abs(e.clientX - p.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - p.y) > LONG_PRESS_SLOP) {
      window.clearTimeout(p.timer);
      press.current = null;
    }
  };
  const cancelPress = (): void => {
    if (!press.current) return;
    window.clearTimeout(press.current.timer);
    press.current = null;
  };

  const clampPos = (x: number, y: number, s: ConvSize): { x: number; y: number } => {
    const box = panelRef.current?.getBoundingClientRect();
    const limX = Math.max(0, (innerWidth - (box?.width ?? s.w)) / 2 - 12);
    const limY = Math.max(0, (innerHeight - (box?.height ?? 0)) / 2 - 12);
    return { x: Math.max(-limX, Math.min(limX, x)), y: Math.max(-limY, Math.min(limY, y)) };
  };

  const onGripDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const box = panelRef.current?.getBoundingClientRect();
    grip.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h || Math.round(box?.height ?? 0) };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onGripMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const g = grip.current;
    if (!g) return;
    const next = clampConvSize(g.w + (e.clientX - g.x), g.h + (e.clientY - g.y));
    setSize(next);
    setPos((p) => clampPos(p.x, p.y, next));
  };
  const onGripUp = (): void => {
    if (!grip.current) return;
    grip.current = null;
    setSize((s) => {
      try {
        localStorage.setItem(CONV_SIZE_KEY, JSON.stringify(s));
      } catch {
        // 隐私模式禁写：尺寸只在本次会话有效
      }
      return s;
    });
  };

  const onDragDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // 标题栏上的按钮（停止/关闭/过滤）不是拖动把手
    if (!isDesktop || (e.target as HTMLElement).closest('button')) return;
    drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    setPos(clampPos(d.px + (e.clientX - d.x), d.py + (e.clientY - d.y), size));
  };
  const onDragUp = (): void => {
    drag.current = null;
  };

  /** 每条气泡的交互面：桌面右键开菜单（进多选并勾上这条），触屏长按同效；
   *  多选态里点气泡即勾选/取消。 */
  const rowProps = (key: string): React.HTMLAttributes<HTMLDivElement> => ({
    onContextMenu: (e) => {
      if (selecting) return;
      // 触屏长按同样会弹 contextmenu：原生菜单一律压掉，但那条路我们不用自己的菜单
      e.preventDefault();
      if (coarse) return;
      setMenu({ kind: 'bubble', x: e.clientX, y: e.clientY, key });
    },
    onPointerDown: onPressDown(key),
    onPointerMove: onPressMove,
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onClick: selecting
      ? () => {
          if (suppressTap.current === key) {
            suppressTap.current = null;
            return;
          }
          togglePick(key);
        }
      : undefined,
  });

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
        ref={panelRef}
        // 桌面：宽度跟屏幕走、拖角可改（记住）、拖标题栏可挪位；<lg 铺满可视宽
        style={
          isDesktop
            ? {
                width: size.w,
                height: size.h || undefined,
                transform: pos.x || pos.y ? `translate(${pos.x}px, ${pos.y}px)` : undefined,
              }
            : undefined
        }
        className="relative flex h-[70dvh] max-lg:h-[88dvh] w-full flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-neutral-900 p-3 shadow-mac"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          onPointerDown={onDragDown}
          onPointerMove={onDragMove}
          onPointerUp={onDragUp}
          onPointerCancel={onDragUp}
          className={cn(
            'flex items-center justify-between gap-2 pb-2',
            isDesktop && 'cursor-grab active:cursor-grabbing',
          )}
        >
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-neutral-200">
              {t('tasks.messagesTitle')} · {label}
            </p>
            <p className="truncate text-[10px] text-neutral-500">{projectLabel}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* 停止：与事件链组头那枚同一判据（回合开着才露）、同一动作、同一 fb 键 */}
            {stoppable && (
              <button
                type="button"
                title={t('tasks.stopTooltip')}
                aria-label={t('tasks.stopTooltip')}
                onClick={() => onInterrupt(sessionId)}
                className="inline-flex h-6 w-6 items-center justify-center rounded border border-white/[0.08] bg-white/[0.02] text-neutral-500 transition-colors hover:border-white/[0.16] hover:bg-white/[0.08] hover:text-red-300"
              >
                <FeedbackIcon
                  state={interruptStateOf(sessionId)}
                  className="h-3.5 w-3.5"
                  icon={<Square className="h-3.5 w-3.5" />}
                />
              </button>
            )}
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
        </div>

        {/* 历史过滤：只改显示，不动手上的翻页游标与勾选 */}
        <div className="flex shrink-0 items-center gap-1 pb-2">
          {CONV_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
                filter === f
                  ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                  : 'border-white/[0.08] text-neutral-500 hover:text-neutral-300',
              )}
            >
              {t(CONV_FILTER_KEY[f])}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-neutral-600">
            {t('tasks.convCount', { n: thread.length })}
          </span>
        </div>

        {/* 对话 = 用户投递 + 每轮 Stop 的最终总结（历史查事件流，不落库）；
            尾巴上常驻还没落进事件流的投递行（Held/失败/暂停闸成因 + 重发） */}
        <div
          ref={threadRef}
          onScroll={() => {
            stick.current = atBottom();
            cancelPress(); // 手指在滑 = 不是长按
            pull.syncEdge();
          }}
          onWheel={(e) => pull.wheel(e.deltaY, e.deltaMode)}
          onTouchStart={(e) => pull.touchStart(e.touches[0]?.clientY ?? 0)}
          onTouchMove={(e) => pull.touchMove(e.touches[0]?.clientY ?? 0)}
          onTouchEnd={pull.touchEnd}
          onTouchCancel={pull.touchEnd}
          className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pr-1"
        >
          {/* 拉动位移：正文整体往下让位（transform 不进布局，故不影响翻页时的滚动补偿），
              提示贴在这段空隙里跟着走 */}
          {pull.px > 0 && (
            <div
              aria-hidden
              className="pointer-events-none absolute left-0 right-0 top-1 flex justify-center"
              style={{ transform: `translateY(${pull.px}px)` }}
            >
              <span className="text-[10px] text-neutral-600">{t('tasks.pullMore')}</span>
            </div>
          )}
          <div
            className="space-y-2"
            style={pull.px > 0 ? { transform: `translateY(${pull.px}px)` } : undefined}
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
              {visible.length === 0 && (
                <p className="pt-6 text-center text-xs text-neutral-600">
                  {t('tasks.convFilterEmpty')}
                </p>
              )}
              {visible.map((m) => {
                if (m.role === 'assistant') {
                  return (
                    <div
                      key={m.key}
                      {...rowProps(m.key)}
                      className={cn('flex justify-start', selecting && 'select-none')}
                    >
                      {/* 长内容（markdown 里没得换行的长串）在气泡自己里面横滚，
                          不把整块对话撑出横向滚动条 */}
                      <div className="min-w-0 max-w-[92%] overflow-x-auto rounded-lg border border-white/[0.08] bg-neutral-800/50 px-2 py-1.5">
                        <span className="mb-0.5 block text-[10px] text-neutral-600">
                          {formatStamp(m.at)}
                        </span>
                        <AssistantMarkdown text={m.text} />
                      </div>
                      {selecting && <CheckBox on={picked.has(m.key)} className="ml-1.5 mt-1" />}
                    </div>
                  );
                }
                const pipe = m.pipe;
                return (
                  <div
                    key={m.key}
                    {...rowProps(m.key)}
                    className={cn('flex items-end justify-end gap-1', selecting && 'select-none')}
                  >
                    {selecting && <CheckBox on={picked.has(m.key)} className="mr-1.5 mt-1" />}
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
                    {/* 气泡色分两侧：**回复（左）走中性灰、发送（右）走蓝**，一眼分得开；
                        同一侧再按投递来源分深浅——weave 投递的深一点，终端里手敲的浅一点
                        （tag/回执点另说，那两样才是「投递成功与否」） */}
                    <div
                      className={cn(
                        'min-w-0 max-w-[85%] overflow-x-auto rounded-lg border px-2 py-1.5',
                        pipe
                          ? 'border-blue-500/30 bg-blue-500/[0.12]'
                          : 'border-blue-500/15 bg-blue-500/[0.05]',
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
                      {/* 多选态里重发/删除不渲染——它们会跟「点气泡即勾选」抢点击 */}
                      {!selecting &&
                        pipe &&
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
                    {compacting ? t('tasks.msgCompacting') : t('tasks.msgGenerating')}
                  </div>
                </div>
              )}
            </>
          )}
          </div>
        </div>

        {error && (
          <p className="mt-1 shrink-0 rounded border border-red-500/30 bg-red-950/30 px-2 py-1 text-[11px] text-red-300">
            {error}
          </p>
        )}

        {/* 多选态：composer 换成工具条（投递与挑选是两件事，不并排摆）。窄屏放不下
            就整组折到第二行——按钮不等宽也不做横向滚动 */}
        {selecting ? (
          <div className="mt-2 flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="min-w-0 truncate text-[11px] text-neutral-400">
              {t('tasks.convSelected', { n: picked.size })}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                disabled={thread.length === 0}
                onClick={toggleAll}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-40',
                  allPicked
                    ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                    : 'border-white/[0.1] text-neutral-200 hover:border-white/20',
                )}
              >
                <CheckCheck className="h-3 w-3" />
                {t(allPicked ? 'tasks.convDeselectAll' : 'tasks.convSelectAll')}
              </button>
              <button
                type="button"
                disabled={picked.size === 0}
                onClick={copyPicked}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-white/[0.1] px-2 py-1 text-[11px] text-neutral-200 transition-colors hover:border-white/20 disabled:opacity-40"
              >
                <Copy className="h-3 w-3" />
                {t('tasks.convCopy')}
              </button>
              <button
                type="button"
                disabled={picked.size === 0}
                onClick={openShareMenu}
                title={t('tasks.convShare')}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-white/[0.1] px-2 py-1 text-[11px] text-neutral-200 transition-colors hover:border-white/20 disabled:opacity-40"
              >
                <FeedbackIcon
                  state={fb.stateOf(`convImg:${sessionId}`)}
                  className="h-3 w-3"
                  icon={<ImageIcon className="h-3 w-3" />}
                />
                {t('tasks.convShare')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelecting(false);
                  setPicked(new Set());
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-white/[0.1] px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-white/20 hover:text-neutral-200"
              >
                {t('tasks.convCancel')}
              </button>
            </div>
          </div>
        ) : (
          /* Composer：无模式选择（服务端恒 prompt 通道全自动）；层①② 皆无的
             harness 才置灰，理由取能力矩阵 unsupportedReasons.prompt。 */
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
        )}

        {/* 拖角改大小（桌面专属：触屏没有拖窗口这回事） */}
        {isDesktop && (
          <div
            role="separator"
            title={t('app.resizeDialog')}
            aria-label={t('app.resizeDialog')}
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none"
          >
            <span className="pointer-events-none absolute bottom-1 right-1 h-2 w-2 rounded-br border-b border-r border-white/20" />
          </div>
        )}

        {/* 弹出菜单：气泡右键一项「多选」／分享图片两项（复制 / 下载） */}
        {menu &&
          createPortal(
            <div
              data-conv-menu
              className="fixed z-[60] rounded-lg border border-white/[0.1] bg-neutral-900 py-1 shadow-mac"
              style={{
                left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_W - 8)),
                top: Math.max(8, Math.min(menu.y, window.innerHeight - MENU_H)),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {menu.kind === 'bubble' ? (
                <button
                  type="button"
                  onClick={() => enterSelect(menu.key)}
                  className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-neutral-200 hover:bg-white/[0.06]"
                >
                  <Check className="h-3 w-3 text-neutral-500" />
                  {t('tasks.convSelect')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => shareImage('clipboard')}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-neutral-200 hover:bg-white/[0.06]"
                  >
                    <Copy className="h-3 w-3 text-neutral-500" />
                    {t('tasks.convShareCopy')}
                  </button>
                  <button
                    type="button"
                    onClick={() => shareImage('download')}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-neutral-200 hover:bg-white/[0.06]"
                  >
                    <Download className="h-3 w-3 text-neutral-500" />
                    {t('tasks.convShareDownload')}
                  </button>
                </>
              )}
            </div>,
            document.body,
          )}
      </div>
    </div>,
    document.body,
  );
}
