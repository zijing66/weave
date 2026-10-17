import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ban, Check, CheckCheck, ChevronDown, Copy, CornerDownLeft, Download, HelpCircle, Image as ImageIcon, Loader2, Minus, RotateCcw, Send, Square, Trash2, X } from 'lucide-react';
import type { HarnessLifecycle } from '@weavecode/core/harness';
import {
  api,
  type HookEventRow,
  type MessagingCapability,
  type SessionMessageRow,
  type UploadImage,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { AssistantMarkdown } from '@/components/AiAssistant';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { ConfirmDialog } from '@/components/ConfirmDialog';
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
  rawOf,
  stripPromptDecor,
  taskNotificationOf,
  turnSummaryOf,
} from '@/lib/hook-payload';
import {
  HARNESS_COMPACTION,
  HARNESS_LIFECYCLE,
  isCompactionEnd,
  modeNamesFor,
  modeTintFor,
  modelNamesFor,
} from './lifecycle';
import { canInterrupt, hasTurnSignal, type SessionStatus } from './session-status';
import { useSessionStatus } from './session-status-store';
import { subscribeHook, type HookFrame } from '@/lib/sse';

/** 一页对话条目（默认首屏窗口 = 最新这一页；向上翻页同宽）。 */
const CONV_PAGE = 10;

/** 附件口径（与服务端 UPLOAD_* 同值）：harness 认的就是这四种，超出就地挡。 */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_MAX_COUNT = 8;

/** 图片判据：MIME 或扩展名（移动浏览器的剪贴板项偶尔不带 type）。 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const isImageFile = (f: File): boolean =>
  f.type.startsWith('image/') || (!f.type && IMAGE_EXT.test(f.name));

/**
 * 剪贴板/拖放里的图。**移动浏览器只填 `items`**（iOS Safari 的 `files` 恒空），桌面
 * 才稳定给 `files` ⇒ items 优先、files 兜底；只取 file 项，文字项留着走默认粘贴。
 */
export function imagesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const fromItems = Array.from(dt.items ?? [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
  const list = fromItems.length > 0 ? fromItems : Array.from(dt.files ?? []);
  return list.filter(isImageFile);
}

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

/** 对话条目：用户投递的 prompt、每轮 Stop 的最终总结，或一枚压缩分隔（不是
 *  对话内容，只标「上下文在这里断过一次」——正文恒空）。 */
export interface ConvEntry {
  key: string;
  /** 事件 id（向上翻页的游标锚）；只在尾巴上的投递行没有。 */
  eventId?: number;
  role: 'user' | 'assistant' | 'compaction';
  at: string;
  text: string;
  /** weave 投递的（直投或中继）：正文里的运输装饰已摘掉，改在气泡上呈现 tag。 */
  fromWeave?: boolean;
  /** 中继壳里的发送方名（非 weave = 别的会话自己发的 CC 会话间消息）。 */
  fromName?: string | null;
  /** 认领到的投递行：状态/回执/重发挂在气泡上，不另起一条。 */
  pipe?: SessionMessageRow;
  /** 随附图（挂在开轮事件上；气泡缩略图，点开看大图）。 */
  images?: UploadImage[];
}

/**
 * 事件 → 对话条目：只认开轮（用户 prompt 原文）与闭轮（Stop 携带的最终
 * assistant 消息）两类事件，外加**压缩分隔**（该 harness 的压缩收尾笔，见
 * `HARNESS_COMPACTION`——历史上哪里断过上下文，是读长会话时最想知道的一件事）。
 * 工具调用、通知、会话标记都不是对话，中间的 assistant 输出也不进——转录在
 * 会话自己那边，这里只要每轮的收尾总结。
 * prompt 原文先剥运输装饰（直投标记 / 中继壳 / 壳内单向注记）：装饰不是内容，
 * 留着既在气泡里露馅，也和投递行的原文对不上（同一条消息会显示两遍）。
 */
export function conversationOf(
  events: readonly HookEventRow[],
  lifecycle: HarnessLifecycle,
  harness?: string | null,
): ConvEntry[] {
  const out: ConvEntry[] = [];
  for (const e of events) {
    if (isCompactionEnd(harness, e.eventType, rawOf(e).source)) {
      out.push({ key: `e${e.id}`, eventId: e.id, role: 'compaction', at: e.createdAt, text: '' });
    } else if (e.eventType === lifecycle.open) {
      // 子代理返回通知不是人发的 prompt（分组同口径丢弃）
      if (taskNotificationOf(e)) continue;
      const raw = promptOf(e);
      if (!raw) continue;
      const { text, fromWeave, fromName } = stripPromptDecor(raw);
      out.push({
        key: `e${e.id}`,
        eventId: e.id,
        role: 'user',
        at: e.createdAt,
        text,
        fromWeave,
        fromName,
        ...(e.images?.length ? { images: e.images } : {}),
      });
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

/** 投递行与事件条目是不是同一条消息（归一后全等）。带图的放宽一档：claude 的
 *  粘贴处理会把多行文本的 chunk 用空串连起来，原文与回执可能差在空白上。 */
function claims(entryText: string, rowText: string, hasImages = false): boolean {
  const a = normalizeText(entryText);
  const b = normalizeText(rowText);
  if (a === b) return true;
  return hasImages && a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
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
      if (taken.has(m.id) || !claims(entry.text, m.text, (m.images?.length ?? 0) > 0)) continue;
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
    .map((m) => ({
      key: `m${m.id}`,
      role: 'user' as const,
      at: m.at,
      text: m.text,
      pipe: m,
      ...(m.images?.length ? { images: m.images } : {}),
    }))
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

/** 尾上的「回复还在路上」= 压缩中（与尾条是谁无关），或这一轮开着而尾条还是
 *  「我刚说的那句」/ 压缩收尾分隔——自动压缩常打断在一轮中间，收尾笔一落尾条
 *  就从 user 变成 compaction，不认它这一轮会一直不显「生成中…」。 */
export function isGenerating(
  status: SessionStatus | undefined,
  tailRole: ConvEntry['role'] | undefined,
): boolean {
  return (
    status === 'compacting' ||
    (status === 'running' && (tailRole === 'user' || tailRole === 'compaction'))
  );
}

/** 在光标处插一个换行（移动端没有 Shift+Enter 这个手势）。 */
export function spliceNewline(
  text: string,
  start: number,
  end: number,
): { text: string; caret: number } {
  return { text: text.slice(0, start) + '\n' + text.slice(end), caret: start + 1 };
}

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

/** 角色文案由调用方给（i18n 不写进纯函数），条目间空行分隔。压缩分隔不是对话
 *  内容，导出时略过（复制/导出的是「说了什么」，不是时间线排版）。随附图没法进
 *  纯文本，按 claude 自己的占位形态列在正文后（`[Image #N] 文件名`）。 */
export function exportConversationText(
  entries: readonly ConvEntry[],
  labels: { user: string; assistant: string },
): string {
  return entries
    .filter((e) => e.role !== 'compaction')
    .map((e) => {
      const imgs =
        e.images?.map((img, i) => `[Image #${i + 1}] ${img.name}`).join('\n') ?? '';
      const body = [e.text, imgs].filter(Boolean).join('\n');
      return `[${exportStamp(e.at)}] ${e.role === 'user' ? labels.user : labels.assistant}\n${body}`;
    })
    .join('\n\n');
}

/** 触屏双击开菜单的两枚门槛：两击须落在同一条气泡、间隔不超过 DOUBLE_TAP_MS；
 *  位移超过 TAP_SLOP 就当是滚动，这一击不算轻点。 */
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 8;

/** 弹出菜单两副面孔：气泡右键（进多选）/ 底栏分享图片（复制 | 下载）。 */
type ConvMenu =
  | { kind: 'bubble'; x: number; y: number; key: string }
  | { kind: 'share'; x: number; y: number };

const MENU_W = 168;
const MENU_H = 72;

/** 进图片的条目：正文原样（剥运输装饰是展示层的事，这里就是气泡里那串文本）。
 *  压缩分隔不是对话内容，不进图。 */
const toImageEntries = (entries: readonly ConvEntry[]): ConvImageEntry[] =>
  entries
    .filter((e) => e.role !== 'compaction')
    .map((e) => ({ role: e.role as ConvImageEntry['role'], at: e.at, text: e.text }));

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
 * 刷新挂 SSE 总线的 hook 订阅（开/闭轮事件 + message.*，sessionId 定向），
 * 不新开轮询。
 */
export function SessionMessages({
  sessionId,
  projectId,
  label,
  projectLabel,
  capability,
  answerPending,
  onOpenAnswer,
  onInterrupt,
  interruptStateOf,
  minimized,
  onMinimize,
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
  /** 本会话被阻塞问答挂起（弹窗状态归 TasksPanel，与会话行图标/组头 tag 同一份）。 */
  answerPending?: boolean;
  /** 开作答弹窗：尾部那枚「回答」按钮（关掉不丢入口，答完待答面没了按钮随之消失）。 */
  onOpenAnswer?: () => void;
  /** 停止会话（向 pane 打一记 ESC）：与事件链组头那枚同一实现、同一 fb 键，
   *  两处按钮同转同灭。 */
  onInterrupt: (sessionId: string) => void;
  interruptStateOf: (sessionId: string) => ActionState;
  /** 挂起中（只藏不卸）：草稿与已选图片都还在，几扇对话各自独立互不影响。 */
  minimized: boolean;
  onMinimize: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { show } = useToast();
  const fb = useActionFeedback();
  const { statuses, sessions, refresh, modelCatalog } = useSessionStatus();
  const lifecycle: HarnessLifecycle = HARNESS_LIFECYCLE[capability.harness];
  /** 对话事件类型（开轮 + 闭轮 + 压缩收尾笔）：闭轮表为空的 harness 没有对话面可取。 */
  const convTypes = useMemo(
    () =>
      [lifecycle.open, ...lifecycle.close, HARNESS_COMPACTION[capability.harness]?.end ?? ''].filter(
        Boolean,
      ),
    [capability.harness, lifecycle],
  );

  // 首屏先给缓存（有就即时出画），loadNewest 那一页回来按 eventId 对账
  const [entries, setEntries] = useState<ConvEntry[] | null>(() => readConvCache(sessionId));
  /** 更早的那头翻到底了（事件保留期的起点）。 */
  const [headDone, setHeadDone] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [messages, setMessages] = useState<SessionMessageRow[] | null>(null);
  const [draft, setDraft] = useState('');
  /** 本条待发的图（已落盘、还没投出去）；发走或关弹窗即清。 */
  const [staged, setStaged] = useState<UploadImage[]>([]);
  /** 在飞的上传张数（附件钮转圈；也是防连点的闸）。 */
  const [uploading, setUploading] = useState(0);
  /** 点开的大图（缩略图点击）；null = 没开。 */
  const [lightbox, setLightbox] = useState<UploadImage | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ConvFilter>('all');
  /** 多选态：气泡上出现复选框，点气泡即勾选，底栏换成工具条。 */
  const [selecting, setSelecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
  /** 手指这会儿落在哪条气泡上（判断这一击是不是轻点：位移超阈值即作废）。 */
  const tap = useRef<{ key: string; x: number; y: number } | null>(null);
  /** 上一次轻点：同一条气泡、间隔够短 = 双击，开右键菜单。 */
  const lastTap = useRef<{ key: string; at: number } | null>(null);
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
      const page = conversationOf(events, lifecycle, capability.harness);
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
  }, [capability.harness, convTypes, fail, lifecycle, projectId, sessionId]);

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
    const onHook = (f: HookFrame): void => {
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
    const off = subscribeHook(onHook);
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [lifecycle, loadNewest, refreshMessages, sessionId]);

  // Esc 逐层退：右键菜单 → 多选态 → 关闭确认 → 最小化（一层层退出，不一把关掉）。
  // 挂起中不挂这个监听：几扇对话同时存活时，只有露着的那扇该吃 ESC。
  useEffect(() => {
    if (minimized) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (menu) setMenu(null);
      else if (selecting) {
        setSelecting(false);
        setPicked(new Set());
      } else if (confirming) setConfirming(false);
      else onMinimize();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, selecting, confirming, minimized, onMinimize]);

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

  /** 向上翻页：游标 = 手上最旧那条的事件 id。 */
  const loadEarlier = useCallback(async (): Promise<void> => {
    const oldest = entries?.[0]?.eventId;
    if (oldest === undefined || loadingEarlier || headDone) return;
    setLoadingEarlier(true);
    try {
      const events = await api.listSessionHooks(projectId, sessionId, CONV_PAGE, oldest, convTypes);
      setHeadDone(events.length < CONV_PAGE);
      const older = conversationOf(events, lifecycle, capability.harness);
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
    capability.harness,
    convTypes,
    entries,
    fail,
    headDone,
    lifecycle,
    loadingEarlier,
    projectId,
    sessionId,
  ]);

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
   *  那条 → 回复还在路上，显「生成中…」；中断态压在这两者之上（ESC 打断后宿主
   *  多不发 Stop，回合口子还开着，不先判它就会一直卡在「生成中…」）。
   *  压缩收尾那枚分隔也算「还没回话」：自动压缩常发生在一轮中间，收尾笔一落
   *  尾条就从 user 变成 compaction，不认它这一轮会一直不显「生成中…」。 */
  const compacting = status === 'compacting';
  const interrupted = status === 'interrupted';
  const generating = isGenerating(status, thread[thread.length - 1]?.role);
  /** 尾部签名 = 尾条 + 在途尾行：「生成中…」那行一出现也是尾部进了新内容，只认
   *  尾条键会让刚发送时气泡滚到了底、提示行却留在视口外（下次打开才对）。 */
  const tailSig = `${tailKey ?? ''}|${generating ? 'g' : ''}${interrupted ? 'i' : ''}${
    answerPending ? 'a' : ''
  }`;
  const lastTail = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (minimized || entries === null || tailSig === lastTail.current) return;
    lastTail.current = tailSig;
    if (!stick.current) return;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, tailSig, minimized]);

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

  /** 可勾选的条目 = 除压缩分隔（它不是谁说的话，没有可复制的正文）。 */
  const selectable = thread.filter((e) => e.role !== 'compaction');

  /** 全选的范围 = 已加载的全部条目（不是当前过滤可见的那些：过滤只看显示，
   *  勾选面不跟着变，正如过滤不收回已有的勾）。 */
  const allPicked = selectable.length > 0 && selectable.every((e) => picked.has(e.key));
  const toggleAll = (): void =>
    setPicked(allPicked ? new Set() : new Set(selectable.map((e) => e.key)));

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

  /** 触屏双击开菜单（桌面走右键；鼠标不该有双击这回事）。
   *  多选不再是长按直达——它只是菜单里的一项，双击也只开菜单。 */
  const onPressDown = (key: string) => (e: React.PointerEvent): void => {
    if (!coarse || selecting || e.button !== 0) return;
    tap.current = { key, x: e.clientX, y: e.clientY };
  };
  const onPressMove = (e: React.PointerEvent): void => {
    const t = tap.current;
    if (!t) return;
    if (Math.abs(e.clientX - t.x) > TAP_SLOP || Math.abs(e.clientY - t.y) > TAP_SLOP) {
      tap.current = null;
    }
  };
  /** 抬手定这一击：够近才算轻点，紧接着的下一击落在同一条气泡上就是双击。 */
  const onPressUp = (key: string) => (e: React.PointerEvent): void => {
    const t = tap.current;
    tap.current = null;
    if (!t || t.key !== key) return;
    const now = Date.now();
    const prev = lastTap.current;
    lastTap.current = { key, at: now };
    if (!prev || prev.key !== key || now - prev.at > DOUBLE_TAP_MS) return;
    lastTap.current = null;
    setMenu({ kind: 'bubble', x: e.clientX, y: e.clientY, key });
  };
  const cancelTap = (): void => {
    tap.current = null;
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

  /** 每条气泡的交互面：桌面右键开菜单（进多选并勾上这条），触屏双击同效；
   *  多选态里点气泡即勾选/取消。 */
  const rowProps = (key: string): React.HTMLAttributes<HTMLDivElement> => ({
    onContextMenu: (e) => {
      if (selecting) return;
      // 触屏长按也会弹原生 contextmenu：压掉，触屏那条路走双击（见 onPressUp）
      e.preventDefault();
      if (coarse) return;
      setMenu({ kind: 'bubble', x: e.clientX, y: e.clientY, key });
    },
    onPointerDown: onPressDown(key),
    onPointerMove: onPressMove,
    onPointerUp: onPressUp(key),
    onPointerCancel: cancelTap,
    onClick: selecting ? () => togglePick(key) : undefined,
  });

  /** 一张图从 File 到落盘：base64 走 `/uploads`（内容寻址去重），拿回引用。 */
  const uploadOne = (file: File): Promise<UploadImage> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(file.name));
      reader.onload = () => {
        const data = String(reader.result ?? '');
        const comma = data.indexOf(',');
        api
          .uploadImage({
            name: file.name || 'image',
            mediaType: file.type,
            data: comma >= 0 ? data.slice(comma + 1) : data,
          })
          .then(resolve, reject);
      };
      reader.readAsDataURL(file);
    });

  /** 选图（文件选择器 / 粘贴 / 拖放三个入口共用）：类型与大小就地挡，失败可见告知。 */
  const stageFiles = (files: FileList | File[]): void => {
    const list = Array.from(files).filter(isImageFile);
    if (list.length === 0) return;
    setUploading((n) => n + list.length);
    void (async () => {
      for (const f of list) {
        try {
          if (!IMAGE_TYPES.includes(f.type)) {
            show('error', t('tasks.msgImageBadType'));
            continue;
          }
          if (f.size > IMAGE_MAX_BYTES) {
            show('error', t('tasks.msgImageTooLarge'));
            continue;
          }
          const up = await uploadOne(f);
          setStaged((s) => (s.length >= IMAGE_MAX_COUNT ? (show('error', t('tasks.msgImageTooMany')), s) : [...s, up]));
        } catch (e) {
          show('error', t('tasks.msgImageUploadFailed', { error: errorText(e) }));
        } finally {
          setUploading((n) => n - 1);
        }
      }
    })();
  };

  /** 换行（移动端那枚按钮）：插在光标处，光标跟到新行后。 */
  const insertNewline = (): void => {
    const el = draftRef.current;
    const at = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? at;
    const next = spliceNewline(draft, at, end);
    setDraft(next.text);
    requestAnimationFrame(() => {
      if (el) el.selectionStart = el.selectionEnd = next.caret;
    });
  };

  const send = (): void => {
    const text = draft.trim();
    const images = staged;
    if (!text && images.length === 0) return;
    setDraft('');
    setStaged([]);
    stick.current = true; // 自己发的必然要看一眼，不因正翻历史而沉在底下
    void fb.run(
      `sendMsg:${sessionId}`,
      async () => {
        const res = await api.sendSessionMessage(sessionId, {
          text,
          ...(images.length > 0 ? { images: images.map((i) => i.id) } : {}),
        });
        // 目标会话判死 → 后端当场落 failed（reason=offline）：行会说清，但发送
        // 这个手势本身也要有回音（「发了没反应」正是用户撞过的坑）。
        if (res.message?.reason === 'offline') show('error', t('tasks.msgOfflineToast'));
        await refreshMessages();
      },
      { fail: (e) => t('tasks.msgSendFailed', { error: errorText(e) }) },
    );
  };

  // ---- 会话控制面（执行模式 / 模型）：两者都只在转录里照会，故显示的是「最后已知」 ----
  const sessionRow = sessions?.find((s) => s.sessionId === sessionId);
  const modeNames = modeNamesFor(capability.harness);
  const modelNames = modelNamesFor(capability.harness);
  const modelTargets = modelCatalog[capability.harness] ?? [];
  const currentMode = sessionRow?.mode ?? null;
  const currentModel = sessionRow?.model ?? null;
  const modeTint = modeTintFor(capability.harness, currentMode);

  const cycleMode = (): void => {
    void fb.run(
      `cycleMode:${sessionId}`,
      async () => {
        await api.cycleSessionMode(sessionId);
        // 切换不留痕，标签多数时候不会变；仍刷一次——变了就即时跟上。
        await refresh();
        show('success', t('tasks.modeCycled'));
      },
      { fail: (e) => t('tasks.modeCycleFailed', { error: errorText(e) }) },
    );
  };

  const applyModel = (name: string): void => {
    void fb.run(
      `setModel:${sessionId}`,
      async () => {
        await api.setSessionModel(sessionId, name);
        await refresh();
        show('success', t('tasks.modelSet'));
      },
      { fail: (e) => t('tasks.modelSetFailed', { error: errorText(e) }) },
    );
  };

  /** 下拉选项 = 别名 + 真名（网关把别名换成自家 ID，两个都得看得见）；别名表是
   *  `/model` 的取值，真名只是标注。老 daemon 不回表就只摆别名。 */
  const modelOptions =
    modelTargets.length > 0
      ? modelTargets.map((t) => ({
          value: t.alias,
          label: t.actual === t.alias ? t.alias : `${t.alias} — ${t.actual}`,
        }))
      : modelNames.map((n) => ({ value: n, label: n }));
  /** 选中值取**别名**：转录里照会的是网关真名（`ftm`），那是别名 opus 的真身。 */
  const modelValue = sessionRow?.modelAlias ?? currentModel ?? '';

  /** 真销毁（关）：输入框里还有未提交内容时先问一句，别让点外面那一下悄悄把
   *  草稿带走。ESC 与最小化钮走挂起，不销毁。 */
  const requestClose = (): void => {
    if (draft.trim() || staged.length > 0) setConfirming(true);
    else onClose();
  };

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-50 items-center justify-center bg-black/50 p-4',
        // display 只给一个：hidden 与 flex 同体并列是 Tailwind 源序赌局
        minimized ? 'hidden' : 'flex',
      )}
      onClick={requestClose}
      // 拖放面 = 整个弹窗（拖进窗口任何一处都算，别让浏览器接管去打开那个文件）
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const imgs = imagesFrom(e.dataTransfer);
        if (imgs.length > 0) stageFiles(imgs);
      }}
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
            <button
              type="button"
              title={t('tasks.messagesMinimize')}
              aria-label={t('tasks.messagesMinimize')}
              onClick={onMinimize}
              className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title={t('tasks.messagesClose')}
              aria-label={t('tasks.messagesClose')}
              onClick={requestClose}
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
            cancelTap(); // 手指在滑 = 这一击不算轻点
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
                if (m.role === 'compaction') {
                  // 压缩分隔：不是谁说的话，只标上下文在这里断过一次（不参与勾选）
                  return (
                    <div key={m.key} className="flex items-center gap-2 py-1 text-[10px] text-neutral-600">
                      <span className="h-px flex-1 bg-white/[0.08]" />
                      <span className="shrink-0">
                        {t('hooks.mindmap.compactTag')} · {formatStamp(m.at)}
                      </span>
                      <span className="h-px flex-1 bg-white/[0.08]" />
                    </div>
                  );
                }
                if (m.role === 'assistant') {
                  return (
                    <div
                      key={m.key}
                      {...rowProps(m.key)}
                      className={cn(
                        // touch-manipulation：双击是我们开菜单的手势，压掉移动浏览器的双击缩放
                        'flex touch-manipulation justify-start',
                        selecting && 'select-none',
                      )}
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
                    className={cn(
                      // touch-manipulation：同助手气泡，双击开菜单不触发双击缩放
                      'flex touch-manipulation items-end justify-end gap-1',
                      selecting && 'select-none',
                    )}
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
                      {/* 随附图缩略图（点开大图）：多选态让位给「点气泡即勾选」 */}
                      {m.images?.length ? (
                        <div className="mb-1 flex flex-wrap gap-1.5">
                          {m.images.map((img) => (
                            <button
                              key={img.id}
                              type="button"
                              title={img.name}
                              onClick={(e) => {
                                if (selecting) return;
                                e.stopPropagation();
                                setLightbox(img);
                              }}
                              className="block h-14 w-14 overflow-hidden rounded border border-white/[0.12] bg-neutral-950"
                            >
                              <img
                                src={`/images/${img.id}`}
                                alt={img.name}
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {/* 投递原文同样走 markdown 预览（与左侧回复气泡同渲染器）；
                          `pre-wrap` 保住段落里的软换行——markdown 默认把单换行并成
                          一行，而用户常整段粘贴多行文本 */}
                      <div className="[&_p]:whitespace-pre-wrap">
                        <AssistantMarkdown text={m.text} />
                      </div>
                      {/* 判死落定（会话进程不在）：说人话，别把英文技术串端上来 */}
                      {pipe?.reason === 'offline' ? (
                        <p className="mt-1 break-words text-[11px] text-amber-400">
                          {t('tasks.msgOffline')}
                        </p>
                      ) : (
                        pipe?.error && (
                          <p className="mt-1 break-words text-[11px] text-red-400">{pipe.error}</p>
                        )
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
              {(answerPending || generating || interrupted) && (
                <div className="flex flex-wrap items-center justify-start gap-1.5">
                  {answerPending && (
                    <button
                      type="button"
                      title={t('tasks.answerTooltip')}
                      onClick={() => onOpenAnswer?.()}
                      className="flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2 py-1.5 text-[10px] font-medium text-amber-300 transition-colors hover:border-amber-400/60 hover:text-amber-200"
                    >
                      <HelpCircle className="h-3 w-3" />
                      {t('tasks.convAnswer')}
                    </button>
                  )}
                  {(generating || interrupted) && (
                    <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-neutral-800/50 px-2 py-1.5 text-[10px] text-neutral-500">
                      {interrupted ? (
                        <Ban className="h-3 w-3" />
                      ) : (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                      {interrupted
                        ? t('tasks.msgInterrupted')
                        : compacting
                          ? t('tasks.msgCompacting')
                          : t('tasks.msgGenerating')}
                    </div>
                  )}
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
             harness 才置灰，理由取能力矩阵 unsupportedReasons.prompt。
             会话控制面（执行模式 / 模型）收在输入框正上方的**一条控制行**里——
             两者切换都不留 hook 痕迹（Shift+Tab 一个事件都不发、/model 不落盘），
             故标注是「最后已知」而非此刻。宿主只有「切一档」没有定点设模式，故
             模式做成按钮（点 = Shift+Tab 一档）；模型有 `/model <名>`，做成下拉。
             **图片上传对齐位**：附件钮 + 预览缩略图居左，模式/模型居右（`ml-auto`），
             放不下即折行；别占到输入行与发送键那两格去。 */
          <div className="mt-2 flex shrink-0 flex-col gap-1.5">
            {/* 控制行（一条）：图片居左、模式/模型居右，放不下即折行。 */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {/* 附件钮 + 已选缩略图（× 移除、点开大图）。粘贴/拖放也走同一份 staged——三条入口，一份状态。 */}
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <input
                  ref={fileRef}
                  type="file"
                  accept={IMAGE_TYPES.join(',')}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) stageFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  disabled={!capability.imageAttach || uploading > 0}
                  title={
                    capability.imageAttach
                      ? t('tasks.msgImageAttach')
                      : (capability.unsupportedReasons?.prompt ?? t('tasks.msgImageUnsupported'))
                  }
                  aria-label={t('tasks.msgImageAttach')}
                  onClick={() => fileRef.current?.click()}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-white/[0.1] px-1.5 py-0.5 text-[11px] text-neutral-300 transition-colors hover:border-blue-500/40 hover:text-blue-300 disabled:opacity-40 max-lg:px-2.5 max-lg:py-1.5"
                >
                  {uploading > 0 ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ImageIcon className="h-3 w-3" />
                  )}
                  {t('tasks.msgImageAttach')}
                </button>
                {staged.map((img) => (
                  <span key={img.id} className="relative inline-flex shrink-0">
                    <button
                      type="button"
                      title={img.name}
                      onClick={() => setLightbox(img)}
                      className="block h-10 w-10 overflow-hidden rounded border border-white/[0.12] bg-neutral-950"
                    >
                      <img
                        src={`/images/${img.id}`}
                        alt={img.name}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    </button>
                    <button
                      type="button"
                      title={t('tasks.msgImageRemove')}
                      aria-label={t('tasks.msgImageRemove')}
                      onClick={() => setStaged((s) => s.filter((x) => x.id !== img.id))}
                      className="absolute -right-1 -top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white/[0.15] bg-neutral-800 text-neutral-300 hover:border-red-500/50 hover:text-red-300 max-lg:h-5 max-lg:w-5"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
              {(modeNames.length > 0 || modelNames.length > 0) && (
                <div className="ml-auto flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {modeNames.length > 0 && (
                    <button
                      type="button"
                      title={t('tasks.modeCycle')}
                      aria-label={t('tasks.modeCycle')}
                      onClick={cycleMode}
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-white/[0.1] px-1.5 py-0.5 transition-colors hover:border-blue-500/40"
                    >
                      <FeedbackIcon
                        state={fb.stateOf(`cycleMode:${sessionId}`)}
                        className="h-3 w-3 text-neutral-500"
                        icon={<RotateCcw className="h-3 w-3" />}
                      />
                      <span className="text-[10px] text-neutral-500">{t('tasks.modeLabel')}</span>
                      <span
                        title={t('tasks.modeLastKnown')}
                        style={{ color: modeTint ?? undefined }}
                        className={cn('font-mono text-[11px]', !modeTint && 'text-neutral-400')}
                      >
                        {currentMode ?? t('tasks.modeUnknown')}
                      </span>
                    </button>
                  )}
                  {modelNames.length > 0 && (
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="shrink-0 text-[10px] text-neutral-500">
                        {t('tasks.modelLabel')}
                      </span>
                      <div className="relative">
                        <select
                          value={modelValue}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v) applyModel(v);
                          }}
                          title={t('tasks.modelLastKnown')}
                          aria-label={t('tasks.modelLabel')}
                          className="max-w-[12rem] appearance-none rounded border border-white/[0.1] bg-neutral-950 py-0.5 pl-1.5 pr-6 font-mono text-[11px] text-neutral-200 focus:border-blue-500/40 focus:outline-none"
                        >
                          {!modelValue && <option value="">{t('tasks.modelUnknown')}</option>}
                          {modelOptions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                          {/* 认不出别名的真名（别名表缺配）也得能显示成选中 */}
                          {modelValue && !modelOptions.some((o) => o.value === modelValue) && (
                            <option value={modelValue}>{modelValue}</option>
                          )}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-500" />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-end gap-1.5">
              <textarea
                ref={draftRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                onPaste={(e) => {
                  // 只在真取到图时才压默认：粘贴文字（或 PDF 之类非图）照旧进输入框
                  const imgs = imagesFrom(e.clipboardData);
                  if (imgs.length === 0) return;
                  e.preventDefault();
                  stageFiles(imgs);
                }}
                placeholder={t('tasks.messagesPlaceholder')}
                rows={2}
                className="min-w-0 flex-1 resize-none rounded border border-white/[0.1] bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 focus:outline-none focus:border-blue-500/40"
              />
              {/* 停止：贴在发送按钮边上（回合开着才露、与事件链组头同一判据与 fb 键） */}
              {stoppable && (
                <button
                  type="button"
                  title={t('tasks.stopTooltip')}
                  aria-label={t('tasks.stopTooltip')}
                  onClick={() => onInterrupt(sessionId)}
                  className="inline-flex shrink-0 items-center justify-center gap-1 rounded border border-white/[0.1] px-2.5 py-1 text-[11px] text-neutral-400 transition-colors hover:border-red-500/40 hover:text-red-300"
                >
                  <FeedbackIcon
                    state={interruptStateOf(sessionId)}
                    className="h-3 w-3"
                    icon={<Square className="h-3 w-3" />}
                  />
                  {t('tasks.stop')}
                </button>
              )}
              {/* 换行：只在窄屏露面（桌面有 Shift+Enter）；触屏没有修饰键这一说 */}
              <button
                type="button"
                title={t('tasks.msgNewline')}
                aria-label={t('tasks.msgNewline')}
                onClick={insertNewline}
                className="hidden max-lg:inline-flex shrink-0 items-center justify-center rounded border border-white/[0.1] px-2.5 py-1 text-neutral-400 transition-colors hover:border-blue-500/40 hover:text-blue-300"
              >
                <CornerDownLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={
                  !capability.prompt ||
                  (!draft.trim() && staged.length === 0) ||
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

        {/* 大图（缩略图点击）：点空白/关钮即收；拖角/菜单同在 z-60 之上，别被压住 */}
        {lightbox &&
          createPortal(
            <div
              className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6"
              onClick={() => setLightbox(null)}
            >
              <button
                type="button"
                title={t('tasks.msgImagePreview')}
                aria-label={t('tasks.msgImagePreview')}
                onClick={() => setLightbox(null)}
                className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.15] bg-neutral-900 text-neutral-300 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
              <img
                src={`/images/${lightbox.id}`}
                alt={lightbox.name}
                onClick={(e) => e.stopPropagation()}
                className="max-h-full max-w-full rounded-lg border border-white/[0.12] object-contain"
              />
            </div>,
            document.body,
          )}

        {/* 关闭确认（非原生）：挂在面板内——面板自己 stopPropagation，
            点确认框的任何一处都不会被背后的遮罩当成「点外面即关」。 */}
        <ConfirmDialog
          open={confirming}
          title={t('tasks.msgCloseConfirmTitle')}
          message={t('tasks.msgCloseConfirm')}
          confirmLabel={t('tasks.messagesClose')}
          onConfirm={onClose}
          onClose={() => setConfirming(false)}
        />
      </div>
    </div>,
    document.body,
  );
}
