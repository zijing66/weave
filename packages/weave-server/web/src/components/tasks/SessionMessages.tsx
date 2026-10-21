import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Activity, AlertTriangle, Ban, Check, CheckCheck, ChevronDown, Copy, CornerDownLeft, Download, FileCode, FileDiff, HelpCircle, Image as ImageIcon, Loader2, MessageCircleQuestion, Minus, Pencil, RotateCcw, Send, Trash2, X } from 'lucide-react';
import type { HarnessLifecycle } from '@weavecode/core/harness';
import {
  API_BASE,
  api,
  type HookEventRow,
  type MessagingCapability,
  type RecognizedRef,
  type SessionMessageRow,
  type SessionPlan,
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
  type ConvImageTag,
} from '@/lib/conv-image';
import { useMediaQuery } from '@/lib/use-media-query';
import { usePullLoad } from '@/lib/pull-load';
import { useTheme } from '@/lib/theme';
import { FilePicker, type PickItem, type PickTarget } from './FilePicker';
import { SessionEditsDialog } from './SessionEditsDialog';
import { SideQuestionDialog } from './SideQuestionDialog';
import { StatuslineBar } from './StatuslineBar';
import { errorText, useActionFeedback, type ActionState } from '@/lib/action-feedback';
import {
  formatStamp,
  promptOf,
  rawOf,
  stripPromptDecor,
  summarizeEvent,
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
import { type SessionStatus } from './session-status';
import { useSessionStatus } from './session-status-store';
import { subscribeHook, type HookFrame } from '@/lib/sse';

/** 一页对话条目（默认首屏窗口 = 最新这一页；向上翻页同宽）。 */
const CONV_PAGE = 10;

/** 附件口径（与服务端 UPLOAD_* 同值）：harness 认的就是这四种，超出就地挡。 */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_MAX_COUNT = 8;

/** 生成中那一行的素材窗口：取最近多少条事件（展示只挑最新那条有内容的）。 */
const LIVE_FETCH = 40;

/** 输入框高度（行数）：桌面顶边可拖，2~20 行，localStorage 记住。 */
const INPUT_ROWS_MIN = 2;
const INPUT_ROWS_MAX = 20;
/** 一行的高度（px）：拖拽位移换算行数用，与 textarea 的实际行高同量级。 */
const INPUT_ROW_PX = 16;

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

/** 「切换中」最多挂这么久：宿主下一拍事件就回报新模式，一直没事件（会话闲着）就
 *  回落「最后已知」——一个永久的「切换中」比旧值更像卡死。 */
const MODE_PENDING_MS = 60_000;

/** ESC 键帽点完歇几秒：连点会连发好几记（宿主的 ESC 后面接 rewind，连发会把
 *  刚开的那层菜单也退掉）。冷却只为防连发，与「能不能点」无关。 */
const ESC_COOLDOWN_S = 3;

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

/** 队列里的状态文案：已送达的行**还没落进对话**（气泡随会话自己的 UPS 事件来），
 *  在队列里标「已送达」自相矛盾——那是对话气泡上的事，这里它叫「已发出」。 */
const queueStatusKey = (
  status: SessionMessageRow['status'],
): (typeof STATUS_KEY)[SessionMessageRow['status']] | 'tasks.msgStatusSent' =>
  status === 'delivered' ? 'tasks.msgStatusSent' : STATUS_KEY[status];

/** 自动清除的倒计时读数：mm:ss（窗口以分钟计，看秒才像在走）。 */
export function countdownLabel(releaseAt: string, now: number): string {
  const total = Math.ceil(Math.max(0, Date.parse(releaseAt) - now) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

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
  /** 这一轮以失败收尾（`lifecycle.closeFailed`）：正文是宿主报的错，不是回答。 */
  failed?: boolean;
  /** 计划模式交出的计划正文（不是某轮的收尾总结，单独标出来给人批阅）。 */
  plan?: boolean;
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
        // `[Image #N]` 是宿主输入框的占位记号、不是正文：图缩略图已经挂在气泡上，
        // 留着就成一串没人看得懂的标记（剥不掉的话，两条气泡也长得不像同一条）。
        text: e.images?.length ? text.replace(IMAGE_MARKER, '').trim() : text,
        fromWeave,
        fromName,
        ...(e.images?.length ? { images: e.images } : {}),
      });
    } else if (lifecycle.close.includes(e.eventType)) {
      const text = turnSummaryOf(e);
      if (text)
        out.push({
          key: `e${e.id}`,
          eventId: e.id,
          role: 'assistant',
          at: e.createdAt,
          text,
          // 失败收尾（claude = StopFailure）的正文是宿主报的 API 错误：它长得像
          // 回答、位置也在回答那儿，不标出来就只能当普通回复读。
          ...(lifecycle.closeFailed.includes(e.eventType) ? { failed: true } : {}),
        });
    }
  }
  return out;
}

/** 按轮取数的窗口（改动汇总的取数范围）：锚及其后第一条回复的 `at` 为上界、
 *  锚之前最近一条回复的 `at` 为下界——同一轮里的气泡算出同一个窗口。全程没有
 *  回复条目 → 双 null = 退化为「全部」。 */
export function editsWindowOf(
  entries: readonly ConvEntry[],
  key: string,
): { since: string | null; until: string | null } {
  const idx = entries.findIndex((e) => e.key === key);
  if (idx < 0) return { since: null, until: null };
  let until: string | null = null;
  for (let i = idx; i < entries.length; i++) {
    if (entries[i]!.role === 'assistant') {
      until = entries[i]!.at;
      break;
    }
  }
  let since: string | null = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (entries[i]!.role === 'assistant') {
      since = entries[i]!.at;
      break;
    }
  }
  return { since, until };
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

/** 会话那侧把随图的路径换成这个占位（与服务端回执比对剥的是同一个记号）。 */
const IMAGE_MARKER = /\[Image #\d+\]/gi;

/** 投递行与事件条目是不是同一条消息（归一后全等）。带图的放宽一档：claude 的
 *  粘贴处理会把多行文本的 chunk 用空串连起来，且正文里的图会变成 `[Image #N]`
 *  占位——不剥占位就永远认领不到，同一条消息会显示两遍（一遍真气泡、一遍停在
 *  投递样式上）。 */
function claims(entryText: string, rowText: string, hasImages = false): boolean {
  const a = normalizeText(entryText);
  const b = normalizeText(rowText);
  if (a === b) return true;
  if (!hasImages) return false;
  const drop = (s: string): string => s.replace(IMAGE_MARKER, '').replace(/\s+/g, '');
  return drop(a) === drop(b);
}

/**
 * 投递行归位：同文案、时刻相近的事件条目认领它（气泡上挂状态/回执点，不重复渲染）；
 * **认领不到的不进对话**——对话里的气泡只能是会话真说过的话（hook 事件），
 * 还没送出去 / 送失败 / 被暂扣的行混进来就是凭空多一条消息。它们归 `outbox`，
 * 在对话尾巴上**当最新那几条气泡**摆着（虚线框 = 还没落定）——**已送达、气泡还
 * 没来的也在里面**：那一段正是「发出去了、还没落进对话」的过程，抹掉它新发的
 * 消息就凭空消失一下再冒出来。可见期由服务端给，本视图不另设窗口。
 */
export function attachDeliveries(
  entries: readonly ConvEntry[],
  deliveries: readonly SessionMessageRow[],
): { thread: ConvEntry[]; outbox: SessionMessageRow[] } {
  const taken = new Set<string>();
  const claim = (entry: ConvEntry): SessionMessageRow | undefined => {
    // 回执记下了它命中的那条开轮事件 = 同一条消息的确定答案，不必比文案：重发只
    // 补的那记回车提交的是**整个输入框**（用户在终端里又敲了别的字），投递行记的
    // 原文与真正提交的文本可以差出一大截，比文案就永远认领不到、同一条显示两遍。
    if (entry.eventId !== undefined) {
      // 同一条 UPS 可能核销多条在途（宿主把连着发的几条合成一次提交）：它们全归
      // 这一条气泡，谁也不再留在队列尾巴上。
      const exact = deliveries.filter((m) => !taken.has(m.id) && m.ackedEventId === entry.eventId);
      if (exact.length > 0) {
        for (const m of exact) taken.add(m.id);
        return exact[0];
      }
    }
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
  // 没被气泡认领的一律留在队列里：「已送达」只说明交给了会话，不代表它已落进对话
  // （气泡随会话自己的 UPS 事件来）。认领即退场，同一条消息不会两处都露。
  const outbox = deliveries
    .filter((m) => !taken.has(m.id))
    .sort((a, b) => a.at.localeCompare(b.at));
  return { thread: out, outbox };
}

/** 能不能从队列里移除。**在飞的 delivering 也能删**——投递卡住时它就是队头，压着
 *  后面每一条都发不出去，不给动手就永远解不开（删除会连泵闸一起解除，服务端那条
 *  落定回调发现行没了即收手）。running 删不掉：编排域的一条真实子进程，删行只是把
 *  活着的进程藏起来。**已发出（delivered）删不掉**——会话那边已经收到了，只是 hook
 *  还没到（气泡随后就来），删掉等于假装撤回一条已经进了对话的消息。**例外 = 它正是
 *  暂停闸的成因**：闸没有可操作的成因行就永远开不了，而这一条又等不来回执（多半
 *  压根没进去），留着只是化石——用户得能亲手把它清出去。 */
export function removableOf(m: SessionMessageRow): boolean {
  if (m.status === 'running') return false;
  return m.status !== 'delivered' || m.stalled === true;
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

/** 尾条是一次失败收尾（宿主把 API 报错当闭轮事件送来）→ 尾巴上那行要换成它报的
 *  错：这一轮已经结束了，不是还在生成，也不是什么都没发生。队列里还有没送出去的
 *  行时不算——那行才是「最新的一件事」，把上一条的错摆在它下面会读成它失败了。 */
export function failedTail(
  thread: readonly ConvEntry[],
  hasQueued: boolean,
): ConvEntry | null {
  const tail = thread[thread.length - 1];
  return !hasQueued && tail?.failed === true ? tail : null;
}

/** 输入框里一枚引用胶囊的标记属性：`contenteditable="false"` 让它成原子块——
 *  退格整枚删、光标进不去；它的值就是 harness 的引用表达式（服务端算好的）。 */
export const REF_ATTR = 'data-ref';
/** 胶囊自己留的账（路径 / 类型 / 行区间）：点它要能回到这个文件再改一次。
 *  这几项是服务端给过的原值，不是对表达式的解析——前端始终不认识 `@` 与 `#L`。 */
export const REF_PATH_ATTR = 'data-ref-path';
export const REF_KIND_ATTR = 'data-ref-kind';
export const REF_LINES_ATTR = 'data-ref-lines';

/** `nodeType` 的取值写死成字面量：测试环境是 node（没有 `Node` 全局），
 *  而这些数与 DOM 规范同寿，不会变。 */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** composer DOM → 要发出去的原文：胶囊取 `data-ref`，换行（浏览器插的 `<br>`）还原成 `\n`。
 *  **表达式绝不在前端拼**——这里只把服务端回给的值吐出来。 */
export function serializeDraft(root: Node | null): string {
  if (!root || root.nodeType !== ELEMENT_NODE) return '';
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const ref = el.getAttribute(REF_ATTR);
    if (ref != null) {
      out += ref;
      return;
    }
    // Enter / 插入文本都会落成 <br>，块级元素同理（兜底，正常路径不会走到）
    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  // 末尾那个 <br> 是浏览器给空行留的占位，不当换行算
  return out.endsWith('\n') && out.trim() === '' ? '' : out;
}

/** 敲下 `@` 之后该怎么处理（纯函数，DOM 那边只负责把「光标之前那截」喂进来）：
 *  `escape` = `\@`，吃掉反斜杠留字面 `@`；`ignore` = 前面不是空白；`open` = 唤出选择器。
 *  **`@` 前面必须是空白（或行首）**——与服务端认引用的文法同一套判据：粘在字里
 *  （邮箱 `foo@bar`、中文 `看@a.ts`）既不是引用，也就不该弹框。 */
export type PickerIntent = 'open' | 'escape' | 'ignore';

export function pickerIntent(before: string): PickerIntent {
  if (!before.endsWith('@')) return 'ignore';
  if (before.endsWith('\\@')) return 'escape';
  const prev = before[before.length - 2];
  if (prev !== undefined && !/\s/.test(prev)) return 'ignore';
  return 'open';
}

/** 粘贴回填切成的一小段：一段原文，或一枚认出来的引用（`PickItem` 直接能喂给
 *  `insertRefs`，与选择器落定走同一条路）。 */
export type DraftSegment = { kind: 'text'; text: string } | { kind: 'ref'; item: PickItem };

/** 文本 + 服务端认出来的引用区间 → 交替的片段（粘贴时把表达式还原成胶囊）。
 *  区间按起点排序、重叠或越界的一律跳过（服务端给的是原文坐标，认错也不该吞字）。 */
export function buildSegments(text: string, refs: readonly RecognizedRef[]): DraftSegment[] {
  const out: DraftSegment[] = [];
  let at = 0;
  for (const r of [...refs].sort((a, b) => a.start - b.start)) {
    if (r.start < at || r.end > text.length || r.end <= r.start) continue;
    if (r.start > at) out.push({ kind: 'text', text: text.slice(at, r.start) });
    out.push({
      kind: 'ref',
      item: { ref: r.ref, target: { path: r.path, kind: r.kind, ...(r.lines ? { lines: r.lines } : {}) } },
    });
    at = r.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/** 光标之前那截文字。`Range.toString()` 不吐 `<br>` 的换行，而行首那枚 `@` 正靠
 *  「前面是空白」才成立——所以自己走一遍，`<br>` 折成 `\n`。 */
export function textBeforeCaret(root: Node, range: Range): string {
  let out = '';
  let hit = false;
  const walk = (node: Node): void => {
    if (hit) return;
    if (node === range.startContainer) {
      if (node.nodeType === TEXT_NODE) {
        out += (node.nodeValue ?? '').slice(0, range.startOffset);
      } else {
        const limit = Math.min(range.startOffset, node.childNodes.length);
        for (let i = 0; i < limit; i++) walk(node.childNodes[i]!);
      }
      hit = true;
      return;
    }
    if (node.nodeType === TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    if ((node as HTMLElement).tagName === 'BR') {
      out += '\n';
      return;
    }
    for (const child of Array.from(node.childNodes)) {
      if (hit) return;
      walk(child);
    }
  };
  if (root === range.startContainer) {
    const limit = Math.min(range.startOffset, root.childNodes.length);
    for (let i = 0; i < limit; i++) walk(root.childNodes[i]!);
    return out;
  }
  for (const child of Array.from(root.childNodes)) {
    if (hit) break;
    walk(child);
  }
  return out;
}

/** 胶囊的样式（动态建元素也想吃 Tailwind：类名写死在源码里才生成得出）。
 *  称呼与发送出去的表达式一致，不做好看的别名——用户看见的就是会发出去的。 */
const REF_CHIP_CLASS =
  'mx-0.5 inline-block max-w-[16rem] truncate rounded-full border border-blue-500/40 bg-blue-500/15 px-1.5 align-baseline font-mono text-[11px] leading-[1.5] text-blue-200';

export function filterThread(
  thread: readonly ConvEntry[],
  filter: ConvFilter,
): ConvEntry[] {
  return filter === 'all' ? [...thread] : thread.filter((e) => e.role === filter);
}

/** 计划本体插进对话流（位置 = 提交那次工具调用的事件 id）：它不是某一轮的收尾
 *  总结、也永远不是用户说的，但正是这一轮要人拍板的东西，摆在尾巴上就错位了。 */
export function withPlan(entries: readonly ConvEntry[], plan: SessionPlan | null): ConvEntry[] {
  if (!plan || !plan.text.trim()) return [...entries];
  const entry: ConvEntry = {
    key: `p${plan.eventId}`,
    eventId: plan.eventId,
    role: 'assistant',
    at: plan.at,
    text: plan.text,
    plan: true,
  };
  const at = entries.findIndex((e) => (e.eventId ?? 0) > plan.eventId);
  return at < 0 ? [...entries, entry] : [...entries.slice(0, at), entry, ...entries.slice(at)];
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
 *  纯文本，按 claude 自己的占位形态列在正文后（`[Image #N] 文件名`）。**取原文
 *  全量**（气泡里收着的也照全文），计划条目的角色行带上计划 tag。 */
export function exportConversationText(
  entries: readonly ConvEntry[],
  labels: { user: string; assistant: string; plan: string },
): string {
  const role = (e: ConvEntry): string => {
    const base = e.role === 'user' ? labels.user : labels.assistant;
    return e.plan === true ? `${base} · ${labels.plan}` : base;
  };
  return entries
    .filter((e) => e.role !== 'compaction')
    .map((e) => {
      const imgs =
        e.images?.map((img, i) => `[Image #${i + 1}] ${img.name}`).join('\n') ?? '';
      const body = [e.text, imgs].filter(Boolean).join('\n');
      return `[${exportStamp(e.at)}] ${role(e)}\n${body}`;
    })
    .join('\n\n');
}

/** 触屏双击开菜单的两枚门槛：两击须落在同一条气泡、间隔不超过 DOUBLE_TAP_MS；
 *  位移超过 TAP_SLOP 就当是滚动，这一击不算轻点。 */
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 8;

/** 弹出菜单两副面孔：气泡右键（进多选）/ 底栏分享图片（复制 | 下载），都挂在
 *  body 上按视口坐标定位。 */
type ConvMenu =
  | { kind: 'bubble'; x: number; y: number; key: string }
  | { kind: 'share'; x: number; y: number };

const MENU_W = 168;
const MENU_H = 72;

/** 进图片的条目：正文原样全量（气泡里收着的也照全文；剥运输装饰是展示层的事，
 *  这里就是气泡里那串文本）。压缩分隔不是对话内容，不进图。气泡上的那几枚 tag
 *  （weave 来源 / 发送方 / 计划）照面板带过去——出图与窗口看到的是同一件事。 */
const toImageEntries = (entries: readonly ConvEntry[], planLabel: string): ConvImageEntry[] =>
  entries
    .filter((e) => e.role !== 'compaction')
    .map((e) => {
      const tags: ConvImageTag[] = [];
      if (e.role === 'user' && e.fromWeave === true) tags.push({ kind: 'weave', text: 'weave' });
      if (e.role === 'user' && e.fromWeave !== true && e.fromName != null)
        tags.push({ kind: 'name', text: e.fromName });
      if (e.plan === true) tags.push({ kind: 'plan', text: planLabel });
      return {
        role: e.role as ConvImageEntry['role'],
        at: e.at,
        text: e.text,
        ...(tags.length > 0 ? { tags } : {}),
        ...(e.pipe !== undefined ? { viaWeave: true } : {}),
        ...(e.failed === true ? { failed: true } : {}),
      };
    });

/** 弹窗尺寸：宽度跟屏幕走（宽屏优先，窄屏交给 `w-full` 类），拖角可改并记住；
 *  高度缺省 0 = 不设行内高度，沿用 dvh 类（移动端地址栏伸缩才不失效）。 */
type ConvSize = { w: number; h: number };
const CONV_SIZE_KEY = 'weave:conv-size';
/** 浮窗位置（相对居中位的位移）：拖标题栏挪过就记住，下次开在同一处。 */
const CONV_POS_KEY = 'weave:conv-pos';
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

/** 记住的浮窗位移（相对居中位）；越界由挂载后的 clampPos 再收一次。 */
function loadConvPos(): { x: number; y: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(CONV_POS_KEY) ?? 'null') as {
      x?: unknown;
      y?: unknown;
    } | null;
    if (typeof raw?.x === 'number' && typeof raw?.y === 'number') return { x: raw.x, y: raw.y };
  } catch {
    // 坏值就当没记过
  }
  return { x: 0, y: 0 };
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
 * 生成中那一行：只摆**最新**那条事件摘要（同事件链卡片口径）。新事件一到就换
 * 一条——`key` 变即重挂，新的从下面滚进来（keyframes 见 index.css 的
 * `weave-ticker-in`），于是一轮里这行一直在往上滚。
 */
function EventTicker({ text }: { text: string }) {
  return (
    <span className="relative min-w-0 flex-1 overflow-hidden">
      <span key={text} className="weave-ticker-in block truncate whitespace-nowrap">
        {text}
      </span>
    </span>
  );
}

/** 折叠态的高度 ≈ 三行正文（`text-xs leading-relaxed` 19.5px/行）。 */
const CLAMP_Y = '3.75rem';
/** 收起门槛：不足六行不收——短回复（几句话的答案）本来一眼看得完，收起来只是
 *  多点一下，还把「这几行就完了」变成「后面是不是还有」。 */
const CLAMP_MIN_PX = 6 * 19.5;
/** 收起时的底部渐隐：用遮罩而不是盖一层底色——气泡底色半透明，叠色在亮/暗两
 *  套主题下都露馅。 */
const CLAMP_FADE = {
  WebkitMaskImage: `linear-gradient(to bottom, #000 55%, transparent 100%)`,
  maskImage: `linear-gradient(to bottom, #000 55%, transparent 100%)`,
};

/**
 * 可折叠的回复正文：收起时只留三行、底部渐隐。**只有底部那枚箭头能收/展**——正文
 * 自己一概不接点击（点一下就收会把「拖选复制」变成赌运气：慢机上一个 pointerup
 * 落偏就把气泡收了）。**超过六行才收**——短回复不该出现渐变或箭头，故量一次
 * `scrollHeight`；这一量在收起态（照报整段高度）与展开态（就是内容高度）下同样有效，
 * 展开中的最新那条因此也能收。展开过再收起仍认旧账（`tall` 只涨不落），否则一点开
 * 就丢掉「这条能收」的记忆、收不回去了。**折叠只是气泡里的排版**：复制/导出/分享
 * 图片一律取条目原文，收着的也照全文给出去。
 */
function Collapsible({
  text,
  open,
  onToggle,
  disabled,
  children,
}: {
  text: string;
  open: boolean;
  onToggle: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = (): void => {
      if (el.scrollHeight > CLAMP_MIN_PX) setTall(true);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  return (
    <div className="relative">
      <div
        ref={ref}
        style={!open && tall ? { maxHeight: CLAMP_Y, overflow: 'hidden', ...CLAMP_FADE } : undefined}
      >
        {children}
      </div>
      {/* 收/展的唯一入口：贴着渐隐居中的这枚箭头（它自己不被遮罩）。正文不接点击，
          拖选复制因此永远安全。 */}
      {tall && !disabled && (
        <button
          type="button"
          aria-label={t(open ? 'tasks.convFold' : 'tasks.convUnfold')}
          onClick={onToggle}
          className={cn(
            'mx-auto flex w-7 items-center justify-center rounded-full py-0.5',
            'border border-edge/[0.08] bg-neutral-900/80 text-neutral-500 hover:text-neutral-300',
            // 收起时压在渐隐上、贴气泡底边；展开时让它自己占一行，别盖住最后一行正文
            open ? 'mt-1' : 'absolute inset-x-0 bottom-0',
          )}
        >
          {/* 收起态朝下（点开看全）、展开态朝上（收回去）。箭头不做任何动效：
              常驻的上下浮动在慢机上就是白烧的每帧合成，也不安分 */}
          <ChevronDown className={cn('h-3 w-3', open && 'rotate-180')} />
        </button>
      )}
    </div>
  );
}

/**
 * 会话对话：双向时间线 = 用户投递的消息 + 每轮 Stop 的最终总结，外加还
 * 没落进事件流的在途投递行（含暂停闸成因的重发入口）。历史就是既有的事件
 * 流本身——**不落库、不复制存储**，前端翻页直接查事件（`types` 只取开/闭
 * 轮两类，不拉整条事件链），翻过的页留在组件状态里，向上滚到顶再取更早。
 * 投递无模式选择——服务端恒走 prompt 通道全自动（原生 SendMessage 中继 →
 * 终端 send-text 降级 → 未开会话积压队列），故 web 不展示也不传 mode。
 * 刷新挂 SSE 总线的 hook 订阅（开/闭轮事件 + message.*，sessionId 定向），
 * 不新开轮询。两种形态共用同一份面板：任务视图右栏嵌入（`embedded`，事件链
 * 改从头部那枚按钮开弹窗），编排画布仍是浮窗。
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
  embedded,
  onOpenChain,
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
  /** 挂起（浮窗限定：嵌入形态下切走由调用方置 `minimized`）。 */
  onMinimize?: () => void;
  /** 真销毁（浮窗限定：嵌入形态右栏就是这扇对话，没有关闭这回事）。 */
  onClose?: () => void;
  /** 嵌进任务视图右栏（不再套门户与蒙版、不可拖拽缩放，填满容器）。 */
  embedded?: boolean;
  /** 右上角「事件链」：把事件链开成弹窗（嵌入形态下才有这一枚）。 */
  onOpenChain?: () => void;
}) {
  const t = useT();
  const { show } = useToast();
  const fb = useActionFeedback();
  const theme = useTheme();
  /** 旁路会话弹窗（旁路历史与提问都在这扇里）。 */
  const [sideOpen, setSideOpen] = useState(false);
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
  /** 输入框的**镜像**（真源是 contenteditable 的 DOM）：只给按钮置灰、占位、关闭
   *  确认这几处读；发出去的内容恒从 DOM 序列化，不信这份。 */
  const [draft, setDraft] = useState('');
  /** 本条待发的图（已落盘、还没投出去）；发走或关弹窗即清。 */
  const [staged, setStaged] = useState<UploadImage[]>([]);
  /** 在飞的上传张数（附件钮转圈；也是防连点的闸）。 */
  const [uploading, setUploading] = useState(0);
  /** 点开的大图（缩略图点击）；null = 没开。 */
  const [lightbox, setLightbox] = useState<UploadImage | null>(null);
  /** 文件引用选择器开着（三层：父目录 | 当前目录 | 预览）；`chip` 非空 = 在改那枚胶囊。 */
  const [picker, setPicker] = useState<{ chip: HTMLElement | null; initial?: PickTarget } | null>(null);
  /** `@` 触发时那枚 `@` 被删掉了，记下它的位置：取消就补回去，落定就地插胶囊。 */
  const atRange = useRef<Range | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** composer 用 contenteditable 而不是 textarea：内联引用胶囊要成原子块
   *  （`contenteditable=false` 的 span 里退格整枚删、光标进不去）。 */
  const draftRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ConvFilter>('all');
  /** 多选态：气泡上出现复选框，点气泡即勾选，底栏换成工具条。 */
  const [selecting, setSelecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** 切模式前先问一句：一记 Shift+Tab 就拨一格、没有反向入口，误触可能越过 plan。 */
  const [confirmMode, setConfirmMode] = useState(false);
  /** ESC 的冷却剩余秒数（0 = 可点），防连发。 */
  const [escCooldown, setEscCooldown] = useState(0);
  /** 生成中滚动带的素材（会话最近几十条事件；展示时只认本轮，见 liveItems）。 */
  const [liveEvents, setLiveEvents] = useState<HookEventRow[]>([]);
  /** 计划模式最近交出的那一份计划（没进计划模式 / 正文取不到 = null，不摆气泡）。 */
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  /** 手动展开/收起的账（键 → 展开）：不记 = 按「最新那条展开、更早的收起」默认。 */
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  /** 弹出菜单（位置 = 指针处）：气泡右键（那条一并勾上）与底栏「分享图片」共用一套
   *  外点关闭/Esc/滚轮退场，故只留一份状态、用 kind 分面。 */
  const [menu, setMenu] = useState<ConvMenu | null>(null);
  /** 改动汇总弹窗（默认按轮：右键哪条气泡就看那一轮的改动；「全部对话」是逃生门）。 */
  const [editsOpen, setEditsOpen] = useState(false);
  const [editsRange, setEditsRange] = useState<{ since: string | null; until: string | null }>({
    since: null,
    until: null,
  });
  /** 队列气泡里展开看全文的那一行（多条时每行一句，点开才完整）。 */
  const [openQueued, setOpenQueued] = useState<string | null>(null);
  const [size, setSize] = useState<ConvSize>(() => loadConvSize());
  const [pos, setPos] = useState(loadConvPos);
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
  /** 输入框高度可拖：鼠标才有这回事（触屏的拖拽是滚动）。 */
  const fine = useMediaQuery('(pointer: fine)');
  const [inputRows, setInputRows] = useState<number>(() => {
    const v = Number(localStorage.getItem('weave:conv-input-rows'));
    return Number.isFinite(v) && v > 0
      ? Math.min(INPUT_ROWS_MAX, Math.max(INPUT_ROWS_MIN, v))
      : INPUT_ROWS_MIN;
  });
  useEffect(() => localStorage.setItem('weave:conv-input-rows', String(inputRows)), [inputRows]);
  const rowsGrip = useRef<{ y: number; rows: number } | null>(null);

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
  }, [loadNewest, loadPlan, refreshMessages]);

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
  }, [lifecycle, loadLive, loadNewest, loadPlan, refreshMessages, sessionId]);

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
      } else if (confirmMode) setConfirmMode(false);
      else if (confirming) setConfirming(false);
      else onMinimize?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, selecting, confirmMode, confirming, minimized, onMinimize]);

  // ESC 键帽的冷却：一秒一格倒数，数到 0 才允许下一记。
  useEffect(() => {
    if (escCooldown <= 0) return;
    const id = window.setTimeout(() => setEscCooldown((n) => n - 1), 1000);
    return () => window.clearTimeout(id);
  }, [escCooldown]);

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
  const { thread, outbox } = useMemo(
    () => attachDeliveries(withPlan(entries ?? [], plan), manualDeliveries),
    [entries, manualDeliveries, plan],
  );
  /** 最新那条回复（计划也算一条）：缺省只展开它，更早的回复在气泡里收成三行。 */
  const newestAssistantKey = useMemo(() => {
    for (let i = thread.length - 1; i >= 0; i--) {
      if (thread[i]!.role === 'assistant') return thread[i]!.key;
    }
    return null;
  }, [thread]);
  /** 这条此刻展开没有：手动账优先，没记过账就看是不是最新那条。 */
  const isOpen = (key: string): boolean => expanded.get(key) ?? key === newestAssistantKey;
  const toggleOpen = (key: string): void =>
    setExpanded((prev) => new Map(prev).set(key, !isOpen(key)));
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

  const visible = useMemo(() => filterThread(thread, filter), [thread, filter]);
  /** 拉动加载（向上那头）：贴顶后继续滚/拖才取更早，且一拉只取一页。 */
  const pull = usePullLoad({
    axis: 'top',
    getEdge: () => (threadRef.current?.scrollTop ?? 1) <= 1,
    onFire: () => void loadEarlier(),
    enabled: entries !== null && !headDone && !loadingEarlier,
  });
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
      plan: t('tasks.convPlan'),
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
          blob = await renderConversationImage(toImageEntries(chosen, t('tasks.convPlan')), {
            stamp: exportStamp,
            theme,
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

  // 记住的位移按面板实测尺寸收一次：换了屏幕/窗口大小之后，旧位移可能出界。
  // 只在挂载时收（之后每次拖动/拖角自己就在 clamp 里）。
  useLayoutEffect(() => {
    if (embedded || !isDesktop) return;
    setPos((p) => clampPos(p.x, p.y, size));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        // 拖角会连带 clamp 位位移，一起记下来
        localStorage.setItem(CONV_POS_KEY, JSON.stringify(pos));
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
    if (!drag.current) return;
    drag.current = null;
    try {
      localStorage.setItem(CONV_POS_KEY, JSON.stringify(pos));
    } catch {
      // 隐私模式禁写：位置只在本次会话有效
    }
  };

  /** 每条气泡的交互面：桌面右键开菜单（进多选并勾上这条），触屏双击同效；
   *  多选态里点气泡即勾选/取消。 */
  const rowProps = (key: string): React.HTMLAttributes<HTMLDivElement> => ({
    onContextMenu: (e) => {
      if (selecting) return;
      // 触屏不压原生长按：那条路是「选中文字 + 系统复制」，压掉就再也复制不了；
      // 自家菜单在触屏走双击（见 onPressUp），桌面才用右键接管
      if (coarse) return;
      e.preventDefault();
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

  /** 当前选区在 composer 里就返回它，否则 null（选择器关掉后焦点已不在框里，
   *  这时一律追加到末尾——比猜一个旧位置可预期）。 */
  const caretInDraft = (el: HTMLDivElement): Range | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    return el.contains(range.commonAncestorContainer) ? range : null;
  };

  /** 在光标处插节点；框里没有有效选区就追加到末尾。光标落在插入内容之后，
   *  并滚进视野（插入的行可能落在框外）。 */
  const insertNodes = (nodes: Node[]): void => {
    const el = draftRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    // 选择器开着时焦点不在框里，浏览器那份选区已经没了；`@` 触发的那次要回到
    // 那枚 `@` 的位置，而不是末尾（focus 之后才设，否则会被 focus 抢走）。
    const saved = atRange.current;
    atRange.current = null;
    // 等落定的这段时间里那截文字可能已经被删掉（粘贴要先问一趟服务端）：
    // 挂一个游离节点的 Range 会抛，退回末尾追加
    if (saved && el.contains(saved.startContainer)) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(saved);
    }
    const range = caretInDraft(el);
    if (range) {
      range.deleteContents();
      const frag = document.createDocumentFragment();
      nodes.forEach((n) => frag.appendChild(n));
      const tail = nodes[nodes.length - 1] ?? null;
      range.insertNode(frag);
      if (tail) {
        const after = document.createRange();
        after.setStartAfter(tail);
        after.collapse(true);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(after);
      }
    } else {
      // 追加到末尾：手上那截若不是空白结尾，先补一个空格——否则胶囊会粘在字上
      const last = el.lastChild;
      const tail = last?.nodeType === TEXT_NODE ? (last.nodeValue ?? '') : '';
      if (tail && !/\s$/.test(tail)) el.appendChild(document.createTextNode(' '));
      nodes.forEach((n) => el.appendChild(n));
    }
    setDraft(serializeDraft(el));
  };

  /** 插纯文本（换行钮 / 粘贴 / 出队回填）。走 `execCommand` 是为了留在浏览器的
   *  撤销栈里；不支持就退回手插节点（那条路没有撤销，但不至于插不进去）。 */
  const insertText = (text: string): void => {
    const el = draftRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (!caretInDraft(el)) {
      // 没选区时 execCommand 会落在一个不可预期的位置，直接追加更可控
      insertNodes([document.createTextNode(text)]);
      return;
    }
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }
    if (!ok) insertNodes([document.createTextNode(text)]);
    else setDraft(serializeDraft(el));
  };

  /** 换行（移动端那枚按钮）：移动端没有 Shift+Enter 这个手势。 */
  const insertNewline = (): void => insertText('\n');

  /** 造一枚胶囊：正文 = 服务端算好的表达式，另存路径/类型/行区间供再次编辑。 */
  const buildChip = (ref: string, target: PickTarget): HTMLElement => {
    const chip = document.createElement('span');
    chip.setAttribute('contenteditable', 'false');
    chip.setAttribute(REF_ATTR, ref);
    chip.setAttribute(REF_PATH_ATTR, target.path);
    chip.setAttribute(REF_KIND_ATTR, target.kind);
    if (target.lines) chip.setAttribute(REF_LINES_ATTR, `${target.lines.start}-${target.lines.end}`);
    chip.className = REF_CHIP_CLASS;
    chip.textContent = ref;
    chip.title = ref; // 长路径被截断时，悬停还看得见全文
    return chip;
  };

  /** 落定一批引用：在改既有胶囊就就地换掉（位置不动、只换一枚），否则在光标处
   *  依次插入，每枚后面补一个空格——接着打字才不粘在胶囊上。 */
  const insertRefs = (items: PickItem[]): void => {
    const head = items[0];
    if (!head) return;
    const editing = picker?.chip ?? null;
    atRange.current = null;
    setPicker(null);
    if (editing) {
      editing.replaceWith(buildChip(head.ref, head.target));
      setDraft(serializeDraft(draftRef.current));
      return;
    }
    insertNodes(
      items.flatMap((it) => [buildChip(it.ref, it.target), document.createTextNode(' ')]),
    );
  };

  /** 粘贴回填：先把这段文本交给服务端认引用（文法归 harness、存在性归索引），
   *  认到的片段落成胶囊、其余照原文插入。认不出或这趟挂了就整段当纯文本——
   *  粘贴不能因为一个可选的服务而丢字。 */
  const insertRichText = (text: string): void => {
    const el = draftRef.current;
    if (!el) return;
    const range = caretInDraft(el);
    atRange.current = range ? range.cloneRange() : null;
    const plain = (): void => insertNodes([document.createTextNode(text)]);
    api.recognizeRefs(sessionId, text).then((refs) => {
      insertNodes(
        buildSegments(text, refs).flatMap((seg): Node[] =>
          seg.kind === 'text'
            ? [document.createTextNode(seg.text)]
            : [buildChip(seg.item.ref, seg.item.target)],
        ),
      );
    }, plain);
  };

  /** 关掉选择器：**不动正文**，只把光标放回唤出它的那枚 `@` 原来的位置（那枚 `@`
   *  已经是选择器自己的记账，不补回去——「点蒙版收起」不该是一次改写输入框的动作，
   *  想打字面 `@` 用 `\@`）。 */
  const closePicker = (): void => {
    setPicker(null);
    const saved = atRange.current;
    atRange.current = null;
    if (!saved) return;
    draftRef.current?.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(saved);
  };

  /** 点胶囊 = 改这条引用：带上它的路径与行区间重开选择器。 */
  const openChip = (chip: HTMLElement): void => {
    const path = chip.getAttribute(REF_PATH_ATTR);
    const kind = chip.getAttribute(REF_KIND_ATTR);
    if (!path || (kind !== 'file' && kind !== 'dir')) return;
    const m = /^(\d+)-(\d+)$/.exec(chip.getAttribute(REF_LINES_ATTR) ?? '');
    setPicker({
      chip,
      initial: m
        ? { path, kind, lines: { start: Number(m[1]), end: Number(m[2]) } }
        : { path, kind },
    });
  };

  /** `\@` 是转义：吃掉反斜杠、留下字面 `@`、不弹选择器。 */
  const escapeAt = (el: HTMLDivElement): void => {
    const sel = window.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    const node = range?.startContainer;
    const off = range?.startOffset ?? 0;
    if (node && node.nodeType === TEXT_NODE && off >= 2) {
      const value = node.nodeValue ?? '';
      if (value[off - 1] === '@' && value[off - 2] === '\\') {
        node.nodeValue = `${value.slice(0, off - 2)}@${value.slice(off)}`;
        const after = document.createRange();
        after.setStart(node, off - 1);
        after.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(after);
      }
    }
    setDraft(serializeDraft(el));
  };

  /** 敲 `@` 直接唤出选择器（`\@` 除外）。返回 true = 这次输入已被接管。 */
  const maybeOpenPicker = (el: HTMLDivElement, native: InputEvent): boolean => {
    // 只认真的敲进来一个半角 `@`：IME 组字、粘贴、替换都不算
    if (native.inputType !== 'insertText' || native.data !== '@') return false;
    const range = caretInDraft(el);
    if (!range) return false;
    // 光标之前那截文字（含刚敲进来的 `@`）。胶囊按词边界算，`@` 紧跟胶囊之后
    // 照样弹；粘在 `foo` 后面（邮箱）不弹；`\@` 是转义，只吃反斜杠不弹框。
    const intent = pickerIntent(textBeforeCaret(el, range));
    if (intent === 'ignore') return false;
    if (intent === 'escape') {
      escapeAt(el);
      return true;
    }

    document.execCommand('delete'); // 收掉这枚 `@`：胶囊自己带
    const caret = window.getSelection();
    atRange.current = caret?.rangeCount ? caret.getRangeAt(0).cloneRange() : null;
    setDraft(serializeDraft(el));
    setPicker({ chip: null });
    return true;
  };

  /** 整段写回（出队编辑 / 发走清空）：DOM 与镜像一起换。胶囊在这里退化回
   *  表达式原文——那是它本来就等于的东西，再拼回去也不能保证还是同一枚。 */
  const setDraftText = (text: string): void => {
    const el = draftRef.current;
    if (el) el.textContent = text;
    setDraft(text);
  };

  /** 顶边拖拽调输入框高度：位移换行数（向上拖变高），期间只改本地态。 */
  const onRowsDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    rowsGrip.current = { y: e.clientY, rows: inputRows };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onRowsMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = rowsGrip.current;
    if (!g) return;
    const rows = g.rows + Math.round((g.y - e.clientY) / INPUT_ROW_PX);
    setInputRows(Math.min(INPUT_ROWS_MAX, Math.max(INPUT_ROWS_MIN, rows)));
  };
  const onRowsUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    rowsGrip.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const send = (): void => {
    // 从 DOM 现序列化：镜像可能落后一拍，而这一份是要真发出去的
    const text = serializeDraft(draftRef.current).trim();
    const images = staged;
    if (!text && images.length === 0) return;
    setDraftText('');
    setStaged([]);
    stick.current = true; // 自己发的必然要看一眼，不因正翻历史而沉在底下
    void fb.run(
      `sendMsg:${sessionId}`,
      async () => {
        const res = await api.sendSessionMessage(sessionId, {
          text,
          ...(images.length > 0 ? { images: images.map((i) => i.id) } : {}),
          // 手动面恒走层② 终端击键：直投/中继在宿主眼里都是「另一个会话发的」、
          // 且不带发送方，对方会话可能答给一个随机同伴——人工对话要的是用户权威
          forceTerminal: true,
        });
        // 目标会话判死 → 后端当场落 failed（reason=offline）：行会说清，但发送
        // 这个手势本身也要有回音（「发了没反应」正是用户撞过的坑）。
        if (res.message?.reason === 'offline') show('error', t('tasks.msgOfflineToast'));
        await refreshMessages();
      },
      { fail: (e) => t('tasks.msgSendFailed', { error: errorText(e) }) },
    );
  };

  /** 出队编辑：从队列里取回队尾那条（最新未发送），放回输入框改完再发。 */
  const dequeue = (row: SessionMessageRow): void => {
    void fb.run(
      `dequeue:${row.id}`,
      async () => {
        await api.dismissSessionMessage(sessionId, row.id);
        const cur = serializeDraft(draftRef.current);
        setDraftText(cur.trim() ? `${cur}\n${row.text}` : row.text);
        setStaged((s) => [...s, ...(row.images ?? [])].slice(0, IMAGE_MAX_COUNT));
        await refreshMessages();
      },
      { fail: (e) => t('tasks.msgDequeueFailed', { error: errorText(e) }) },
    );
  };

  /** 队列每行右侧的操作（常显、纯图标，不占正文宽度）：重发 / 取回编辑 / 删除。 */
  const queueActions = (m: SessionMessageRow) => (
    <>
      {(m.status === 'failed' || m.stalled === true) && (
        <button
          type="button"
          title={t('tasks.msgResend')}
          aria-label={t('tasks.msgResend')}
          disabled={fb.stateOf(`resend:${m.id}`) === 'loading'}
          onClick={() =>
            void fb.run(
              `resend:${m.id}`,
              async () => {
                await api.resendSessionMessage(sessionId, m.id);
                await refreshMessages();
              },
              { fail: (err) => t('tasks.msgResendFailed', { error: errorText(err) }) },
            )
          }
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-amber-500/30 bg-amber-950/30 text-amber-300 transition-colors hover:border-amber-500/50 disabled:opacity-40"
        >
          <FeedbackIcon
            state={fb.stateOf(`resend:${m.id}`)}
            className="h-3 w-3"
            icon={<RotateCcw className="h-3 w-3" />}
          />
        </button>
      )}
      {/* 队尾那条（最新还没送出去的）取回输入框改完再发——已送出去的行没有「改」这回事 */}
      {m.id === newestQueuedId && (
        <button
          type="button"
          title={t('tasks.outboxDequeueHint')}
          aria-label={t('tasks.outboxDequeue')}
          disabled={fb.stateOf(`dequeue:${m.id}`) === 'loading'}
          onClick={() => dequeue(m)}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-blue-500/30 bg-blue-500/10 text-blue-300 transition-colors hover:border-blue-500/50 disabled:opacity-40"
        >
          <FeedbackIcon
            state={fb.stateOf(`dequeue:${m.id}`)}
            className="h-3 w-3"
            icon={<Pencil className="h-3 w-3" />}
          />
        </button>
      )}
      {removableOf(m) && (
        <button
          type="button"
          title={t(
            m.status === 'pending'
              ? 'tasks.msgDismissQueuedHint'
              : m.status === 'delivering'
                ? 'tasks.msgDismissInflightHint'
                : 'tasks.msgDismissHint',
          )}
          aria-label={t('tasks.msgDismiss')}
          disabled={fb.stateOf(`dismiss:${m.id}`) === 'loading'}
          onClick={() =>
            void fb.run(
              `dismiss:${m.id}`,
              async () => {
                await api.dismissSessionMessage(sessionId, m.id);
                await refreshMessages();
              },
              { fail: (err) => t('tasks.msgDismissFailed', { error: errorText(err) }) },
            )
          }
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-edge/[0.12] text-neutral-400 transition-colors hover:border-edge/20 hover:text-neutral-200 disabled:opacity-40"
        >
          <FeedbackIcon
            state={fb.stateOf(`dismiss:${m.id}`)}
            className="h-3 w-3"
            icon={<Trash2 className="h-3 w-3" />}
          />
        </button>
      )}
    </>
  );


  // ---- 会话控制面（执行模式 / 模型）：两者都只在转录里照会，故显示的是「最后已知」 ----
  const sessionRow = sessions?.find((s) => s.sessionId === sessionId);
  const modeNames = modeNamesFor(capability.harness);
  const modelNames = modelNamesFor(capability.harness);
  const modelTargets = modelCatalog[capability.harness] ?? [];
  const currentMode = sessionRow?.mode ?? null;
  const currentModel = sessionRow?.model ?? null;
  /** 刚打出 Shift+Tab、新模式还没被任何事件回报：记下切换前的值，变了即收。 */
  const [modePending, setModePending] = useState<string | null>(null);
  const modeTint = modePending !== null ? null : modeTintFor(capability.harness, currentMode);
  useEffect(() => {
    if (modePending === null) return;
    if (currentMode !== modePending) {
      setModePending(null);
      return;
    }
    const timer = window.setTimeout(() => setModePending(null), MODE_PENDING_MS);
    return () => window.clearTimeout(timer);
  }, [modePending, currentMode]);

  const cycleMode = (): void => {
    const before = currentMode ?? '';
    void fb.run(
      `cycleMode:${sessionId}`,
      async () => {
        await api.cycleSessionMode(sessionId);
        // 新值是宿主自己算的（它的循环列表还会被 settings 过滤），猜不得——只标「切换中」，
        // 等下一次事件自带的 permission_mode 回报。
        setModePending(before);
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

  /** 真销毁（关）：输入框里还有未提交内容时先问一句。只有浮窗的关闭钮走这条路——
   *  ESC、最小化钮、点蒙版都走挂起，不销毁。 */
  const requestClose = (): void => {
    if (draft.trim() || staged.length > 0) setConfirming(true);
    else onClose?.();
  };

  /** 面板本体：两种形态共用（浮窗与嵌入右栏只差容器类、定位样式与是否套门户）。 */
  const body = (
      <div
        ref={panelRef}
        // 浮窗：桌面宽高跟屏幕走、拖角可改（记住）、拖标题栏可挪位；<lg 铺满可视宽
        style={
          !embedded && isDesktop
            ? {
                width: size.w,
                height: size.h || undefined,
                transform: pos.x || pos.y ? `translate(${pos.x}px, ${pos.y}px)` : undefined,
              }
            : undefined
        }
        className={cn(
          'relative min-h-0 w-full flex-col overflow-hidden p-3',
          embedded
            ? // 嵌入右栏不再套卡片壳：右栏就是这扇对话，再描一圈边框只是多一道线
              // display 只给一个：hidden 与 flex 同体并列是 Tailwind 源序赌局
              cn('flex-1', minimized ? 'hidden' : 'flex')
            : 'flex h-[70dvh] max-lg:h-[88dvh] rounded-xl border border-edge/[0.08] bg-neutral-900 shadow-mac',
        )}
        onClick={(e) => e.stopPropagation()}
        // 拖放面 = 整块面板（拖进任何一处都算，别让浏览器接管去打开那个文件）
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const imgs = imagesFrom(e.dataTransfer);
          if (imgs.length > 0) stageFiles(imgs);
        }}
      >
        <div
          {...(embedded
            ? {}
            : {
                onPointerDown: onDragDown,
                onPointerMove: onDragMove,
                onPointerUp: onDragUp,
                onPointerCancel: onDragUp,
              })}
          className={cn(
            'flex items-center justify-between gap-2 pb-2',
            !embedded && isDesktop && 'cursor-grab active:cursor-grabbing',
          )}
        >
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-neutral-200">
              {t('tasks.messagesTitle')} · {label}
            </p>
            <p className="truncate text-[10px] text-neutral-500">{projectLabel}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* 嵌入形态：事件链不再占右栏，从这枚按钮开成弹窗 */}
            {embedded && (
              <>
                {/* 旁路会话（claude 的 /btw）：能力面没有这种机制就不渲染 */}
                {capability.sideQuestion && (
                  <button
                    type="button"
                    title={t('tasks.sideTitle')}
                    onClick={() => setSideOpen(true)}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.08] px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-edge/[0.16] hover:text-neutral-200 max-lg:py-1.5"
                  >
                    <MessageCircleQuestion className="h-3 w-3 text-violet-400" />
                    {t('tasks.sideTitle')}
                  </button>
                )}
                <button
                  type="button"
                  title={t('tasks.chainTitle')}
                  onClick={onOpenChain}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.08] px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-edge/[0.16] hover:text-neutral-200 max-lg:py-1.5"
                >
                  <Activity className="h-3 w-3 text-rose-400" />
                  {t('tasks.chainTitle')}
                </button>
              </>
            )}
            {/* 嵌入形态没有挂起/关闭：右栏就是这扇对话，关掉等于把这块地方空出来 */}
            {!embedded && (
              <>
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
              </>
            )}
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
                  : 'border-edge/[0.08] text-neutral-500 hover:text-neutral-300',
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
            尾巴上把还没落进事件流的投递行当最新气泡摆着（Held/失败/暂停闸成因 + 重发） */}
        <div
          ref={threadRef}
          onScroll={() => {
            const el = threadRef.current;
            // 藏起来那一下的 scroll 事件（布局盒已拆、clientHeight 为 0）不算数：
            // 它会把「读到一半」误记成贴底
            if (el && el.clientHeight > 0) {
              const bottom = atBottom();
              lastScroll.current = { top: el.scrollTop, atBottom: bottom };
              stick.current = bottom;
            }
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
          ) : thread.length === 0 && outbox.length === 0 ? (
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
                      <span className="h-px flex-1 bg-edge/[0.08]" />
                      <span className="shrink-0">
                        {t('hooks.mindmap.compactTag')} · {formatStamp(m.at)}
                      </span>
                      <span className="h-px flex-1 bg-edge/[0.08]" />
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
                      <div
                        className={cn(
                          'min-w-0 max-w-[92%] overflow-x-auto rounded-lg border px-2 py-1.5',
                          m.failed
                            ? 'border-red-500/30 bg-red-950/20'
                            : 'border-edge/[0.08] bg-neutral-800/50',
                        )}
                      >
                        <span className="mb-0.5 flex items-center gap-1.5 text-[10px] text-neutral-600">
                          {formatStamp(m.at)}
                          {m.plan === true && (
                            <span className="shrink-0 rounded bg-amber-500/15 px-1 py-px text-[10px] font-medium text-amber-300">
                              {t('tasks.convPlan')}
                            </span>
                          )}
                        </span>
                        {/* 宿主报的错不是回答：不排 markdown（原文就是一行技术串），
                            一律红字——系统错误得和正文一眼分得开 */}
                        {m.failed ? (
                          <p className="flex items-start gap-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-red-300">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            {m.text}
                          </p>
                        ) : (
                          <Collapsible
                            text={m.text}
                            open={isOpen(m.key)}
                            onToggle={() => toggleOpen(m.key)}
                            disabled={selecting}
                          >
                            <AssistantMarkdown text={m.text} />
                          </Collapsible>
                        )}
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
                          <span className="shrink-0 rounded border border-edge/[0.12] px-1 py-px text-[10px] text-neutral-400">
                            {m.fromName}
                          </span>
                        )}
                        {pipe !== undefined && pipe.status !== 'delivered' && (
                          <Badge className={cn('shrink-0', STATUS_BADGE[pipe.status])}>
                            {t(STATUS_KEY[pipe.status])}
                          </Badge>
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
                              className="block h-14 w-14 overflow-hidden rounded border border-edge/[0.12] bg-neutral-950"
                            >
                              <img
                                // 走 API_BASE：dev 由 vite 代理剥离 /api，裸 /images 会被 SPA 回退成 index.html
                                src={`${API_BASE}/images/${img.id}`}
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
                      {/* 多选态里重发/删除不渲染——它们会跟「点气泡即勾选」抢点击。
                          这条已经落进对话了，按钮只对「还没成真」的状态有意义（已送达的
                          行要删去队列尾巴上删，这里的删除会留一条删不掉的气泡） */}
                      {!selecting &&
                        pipe &&
                        (pipe.status === 'failed' || pipe.status === 'pending' || pipe.stalled === true) && (
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
                            className="inline-flex items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-edge/20 hover:text-neutral-200 disabled:opacity-40"
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
              {/* 发送队列 = 尾巴上的「最新几条」：还没落进事件流的行（排队/在飞/已发出
                  未回执/失败/被闸住）就摆在它将来会出现的位置上等。多条收进同一个气泡、
                  每行一句（点开看全文），操作纯图标常显在右。虚线边框标「还没落定」——
                  认领即退场，真气泡接手时位置不变。 */}
              {!selecting && outbox.length > 0 && (
                <div className="flex justify-end">
                  <div className="min-w-0 max-w-[95%] overflow-x-auto rounded-lg border border-dashed border-blue-500/30 bg-blue-500/[0.07] px-2 py-1.5">
                    {outbox.map((m, i) => {
                      const open = outbox.length === 1 || openQueued === m.id;
                      const toggle = (): void => {
                        if (outbox.length > 1) setOpenQueued((id) => (id === m.id ? null : m.id));
                      };
                      return (
                        <div
                          key={`q:${m.id}`}
                          className={cn(
                            'flex gap-1.5',
                            open ? 'items-start' : 'items-center',
                            i > 0 && 'mt-1 border-t border-blue-500/10 pt-1',
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            {open ? (
                              <div
                                onClick={toggle}
                                className={cn(
                                  'mb-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5',
                                  outbox.length > 1 && 'cursor-pointer',
                                )}
                              >
                                <Badge className={cn('shrink-0', STATUS_BADGE[m.status])}>
                                  {t(queueStatusKey(m.status))}
                                </Badge>
                                {m.stalled === true && (
                                  <span className="shrink-0 text-[10px] text-amber-400">
                                    {t('tasks.msgStalled')}
                                  </span>
                                )}
                                {/* 闸会自己放掉这条（服务端时刻），倒计时是给人看清还剩多久的 */}
                                {m.stalled === true && m.releaseAt != null && (
                                  <span className="shrink-0 text-[10px] text-neutral-500">
                                    {t('tasks.msgClearIn', {
                                      left: countdownLabel(m.releaseAt, now),
                                    })}
                                  </span>
                                )}
                                {m.images?.length ? (
                                  <ImageIcon className="h-3 w-3 shrink-0 text-neutral-500" />
                                ) : null}
                                <span className="ml-auto shrink-0 text-[10px] text-neutral-600">
                                  {formatStamp(m.at)}
                                </span>
                              </div>
                            ) : (
                              <button
                                type="button"
                                title={m.text}
                                onClick={toggle}
                                className="flex w-full min-w-0 items-center gap-1.5 text-left"
                              >
                                <Badge className={cn('shrink-0', STATUS_BADGE[m.status])}>
                                  {t(queueStatusKey(m.status))}
                                </Badge>
                                {m.stalled === true && (
                                  <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
                                )}
                                {m.images?.length ? (
                                  <ImageIcon className="h-3 w-3 shrink-0 text-neutral-500" />
                                ) : null}
                                <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-200">
                                  {m.text || m.images?.[0]?.name}
                                </span>
                                <span className="shrink-0 text-[10px] text-neutral-600">
                                  {formatStamp(m.at)}
                                </span>
                              </button>
                            )}
                            {open && (
                              <>
                                <div className="whitespace-pre-wrap break-words text-[12px] text-neutral-200">
                                  {m.text || m.images?.[0]?.name}
                                </div>
                                {/* 判死落定（会话进程不在）：说人话，别把英文技术串端上来 */}
                                {m.reason === 'offline' ? (
                                  <p className="mt-1 break-words text-[11px] text-amber-400">
                                    {t('tasks.msgOffline')}
                                  </p>
                                ) : m.error ? (
                                  <p className="mt-1 break-words text-[11px] text-red-400">
                                    {m.error}
                                  </p>
                                ) : null}
                              </>
                            )}
                          </div>
                          <div className={cn('flex shrink-0 items-center gap-1', open && 'pt-0.5')}>
                            {queueActions(m)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

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
                  {(generating || interrupted || failed) && (
                    <div
                      className={cn(
                        'flex min-w-0 grow basis-48 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px]',
                        failed
                          ? 'border-red-500/30 bg-red-950/30 text-red-300'
                          : 'border-edge/[0.08] bg-neutral-800/50 text-neutral-500',
                      )}
                    >
                      {interrupted ? (
                        <Ban className="h-3 w-3 shrink-0" />
                      ) : failed ? (
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                      ) : (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                      )}
                      {interrupted ? (
                        t('tasks.msgInterrupted')
                      ) : failed ? (
                        <span className="min-w-0 truncate" title={failed.text}>
                          {failed.text}
                        </span>
                      ) : compacting ? (
                        t('tasks.msgCompacting')
                      ) : liveText ? (
                        <EventTicker text={liveText} />
                      ) : (
                        t('tasks.msgGenerating')
                      )}
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
                    : 'border-edge/[0.1] text-neutral-200 hover:border-edge/20',
                )}
              >
                <CheckCheck className="h-3 w-3" />
                {t(allPicked ? 'tasks.convDeselectAll' : 'tasks.convSelectAll')}
              </button>
              <button
                type="button"
                disabled={picked.size === 0}
                onClick={copyPicked}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-[11px] text-neutral-200 transition-colors hover:border-edge/20 disabled:opacity-40"
              >
                <Copy className="h-3 w-3" />
                {t('tasks.convCopy')}
              </button>
              <button
                type="button"
                disabled={picked.size === 0}
                onClick={openShareMenu}
                title={t('tasks.convShare')}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-[11px] text-neutral-200 transition-colors hover:border-edge/20 disabled:opacity-40"
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
                className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:border-edge/20 hover:text-neutral-200"
              >
                {t('tasks.convCancel')}
              </button>
            </div>
          </div>
        ) : (
          /* Composer：无模式选择（服务端恒 prompt 通道全自动）；发送键旁的箭头
             只选**投递通道**（自动 / 强制终端），不是 inject/headless 那套模式。
             层①② 皆无的 harness 才置灰，理由取能力矩阵 unsupportedReasons.prompt。
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
              {/* 不挂 flex-1：`flex: 1 1 0%` 的基准是 0，换行判定时它永远「放得下」→
                  右组从不折行，左组被压到 0 宽、里面的附件钮溢出去盖在模式/模型上。
                  让左组按内容占位，放不下时父级的 flex-wrap 才会把右组挪到下一行。 */}
              <div className="flex flex-wrap items-center gap-1.5">
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
                  disabled={!capability.pathRefs}
                  title={
                    capability.pathRefs
                      ? t('tasks.fileAttachHint')
                      : (capability.unsupportedReasons?.pathRefs ?? t('tasks.fileUnsupported'))
                  }
                  aria-label={t('tasks.fileAttach')}
                  onClick={() => setPicker({ chip: null })}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-[11px] text-neutral-300 transition-colors hover:border-blue-500/40 hover:text-blue-300 disabled:opacity-40 max-lg:px-2.5 max-lg:py-1.5"
                >
                  <FileCode className="h-3 w-3" />
                  {t('tasks.fileAttach')}
                </button>
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
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-[11px] text-neutral-300 transition-colors hover:border-blue-500/40 hover:text-blue-300 disabled:opacity-40 max-lg:px-2.5 max-lg:py-1.5"
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
                      className="block h-10 w-10 overflow-hidden rounded border border-edge/[0.12] bg-neutral-950"
                    >
                      <img
                        src={`${API_BASE}/images/${img.id}`}
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
                      className="absolute -right-1 -top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-edge/[0.15] bg-neutral-800 text-neutral-300 hover:border-red-500/50 hover:text-red-300 max-lg:h-5 max-lg:w-5"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
              {(modeNames.length > 0 || modelNames.length > 0) && (
                <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-x-2 gap-y-1 max-lg:ml-0 max-lg:basis-full max-lg:justify-between">
                  {modeNames.length > 0 && (
                    <button
                      type="button"
                      title={t('tasks.modeCycle')}
                      aria-label={t('tasks.modeCycle')}
                      onClick={() => setConfirmMode(true)}
                      className="inline-flex min-w-0 shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 transition-colors hover:border-blue-500/40"
                    >
                      <FeedbackIcon
                        state={fb.stateOf(`cycleMode:${sessionId}`)}
                        className="h-3 w-3 text-neutral-500"
                        icon={<RotateCcw className="h-3 w-3" />}
                      />
                      <span className="shrink-0 text-[10px] text-neutral-500">
                        {t('tasks.modeLabel')}
                      </span>
                      <span
                        title={
                          modePending !== null
                            ? t('tasks.modeSwitchingHint')
                            : (currentMode ?? t('tasks.modeLastKnown'))
                        }
                        style={{ color: modeTint ?? undefined }}
                        className={cn(
                          'truncate font-mono text-[11px] max-lg:max-w-[7rem]',
                          !modeTint && 'text-neutral-400',
                        )}
                      >
                        {modePending !== null
                          ? t('tasks.modeSwitching')
                          : (currentMode ?? t('tasks.modeUnknown'))}
                      </span>
                    </button>
                  )}
                  {modelNames.length > 0 && (
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="shrink-0 text-[10px] text-neutral-500">
                        {t('tasks.modelLabel')}
                      </span>
                      <div className="relative min-w-0">
                        <select
                          value={modelValue}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v) applyModel(v);
                          }}
                          title={t('tasks.modelLastKnown')}
                          aria-label={t('tasks.modelLabel')}
                          className="max-w-[12rem] appearance-none rounded border border-edge/[0.1] bg-neutral-950 py-0.5 pl-1.5 pr-6 font-mono text-[11px] text-neutral-200 focus:border-blue-500/40 focus:outline-none max-lg:max-w-[8rem]"
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
            {/* 顶边拖拽手柄：鼠标才有（触屏的拖拽是滚动）。贴在两行之间，
                负边距吃掉 gap，免得常显多出一条空隙。 */}
            {fine && (
              <div
                role="separator"
                title={t('tasks.msgResizeInput')}
                aria-label={t('tasks.msgResizeInput')}
                onPointerDown={onRowsDown}
                onPointerMove={onRowsMove}
                onPointerUp={onRowsUp}
                onPointerCancel={onRowsUp}
                className="group -mb-1 flex h-2 cursor-ns-resize touch-none items-center justify-center"
              >
                <span className="h-0.5 w-8 rounded-full bg-edge/[0.12] transition-colors group-hover:bg-blue-500/50" />
              </div>
            )}
            <div className="flex flex-wrap items-end gap-1.5">
              {/* 输入框是 contenteditable 而非 textarea：内联引用胶囊必须是
                  `contenteditable=false` 的原子块（退格整枚删、光标进不去），
                  textarea 里塞不了元素。高度仍按行数算（顶边可拖），换行靠自己
                  插——浏览器 Enter 那套会给出 `<div>`，序列化就不干净了。 */}
              <div className="relative min-w-0 flex-1 max-lg:basis-full">
                {draft === '' && (
                  <span className="pointer-events-none absolute left-2 top-1.5 text-xs text-neutral-600">
                    {t('tasks.messagesPlaceholder')}
                  </span>
                )}
                <div
                  ref={draftRef}
                  role="textbox"
                  aria-multiline="true"
                  aria-label={t('tasks.messagesPlaceholder')}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={(e) => {
                    if (maybeOpenPicker(e.currentTarget, e.nativeEvent as InputEvent)) return;
                    setDraft(serializeDraft(e.currentTarget));
                  }}
                  onClick={(e) => {
                    // 点胶囊 = 改这枚引用（胶囊是原子块，点它不会落光标）
                    const chip = (e.target as HTMLElement | null)?.closest?.(`[${REF_ATTR}]`);
                    if (chip instanceof HTMLElement) openChip(chip);
                  }}
                  onKeyDown={(e) => {
                    // 输入法组字中的 Enter 是「确认候选词」，不是发送
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                      return;
                    }
                    if (e.key === 'Enter' && e.shiftKey) {
                      e.preventDefault();
                      insertText('\n');
                    }
                  }}
                  onPaste={(e) => {
                    // 只在真取到图时才压默认：粘贴文字（或 PDF 之类非图）走纯文本
                    const imgs = imagesFrom(e.clipboardData);
                    if (imgs.length > 0) {
                      e.preventDefault();
                      stageFiles(imgs);
                      return;
                    }
                    // 一律走纯文本：粘进来的 HTML 会把样式和结构一起带进 DOM，
                    // 序列化就再也吐不回一句干净的话。文本里的引用表达式认得出
                    // 就落成胶囊（那本来就是它发出去时的样子）
                    const text = e.clipboardData.getData('text/plain');
                    if (text) {
                      e.preventDefault();
                      insertRichText(text);
                    }
                  }}
                  style={{ height: `calc(${inputRows * INPUT_ROW_PX}px + 0.75rem)` }}
                  className="w-full overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1.5 text-xs leading-4 text-neutral-100 focus:border-blue-500/40 focus:outline-none"
                />
              </div>
              {/* 换行：只在窄屏露面（桌面有 Shift+Enter）；触屏没有修饰键这一说。
                  尺寸与 ESC 键帽同一格（正方形），窄屏那排三枚钮因此一条线对齐。
                  `pointerdown` 压掉默认 = 不把焦点从输入框抢走（抢了软键盘会收）。 */}
              <button
                type="button"
                title={t('tasks.msgNewline')}
                aria-label={t('tasks.msgNewline')}
                onPointerDown={(e) => e.preventDefault()}
                onClick={insertNewline}
                className="hidden shrink-0 items-center justify-center rounded border border-edge/[0.1] text-neutral-400 transition-colors hover:border-blue-500/40 hover:text-blue-300 max-lg:inline-flex max-lg:h-8 max-lg:w-8"
              >
                <CornerDownLeft className="h-3.5 w-3.5" />
              </button>
              {/* 停止 / 发送（+ 通道下拉）：靠右。窄屏输入框独占一行、这三枚钮折到
                  第二行靠右（`ml-auto`，与左边那枚换行分开拇指够得到的两头）；
                  桌面并排一行。停止与事件链组头同一判据与 fb 键。通道下拉贴着
                  发送键——它改的是「这条从哪出去」，与停止是两回事，故只管自己那一格。 */}
              <div className="flex shrink-0 items-center gap-1 max-lg:ml-auto">
                {/* 停止 = 一枚 ESC 键帽：位置恒在（进出会拉动旁边的发送键），尺寸恒方
                    （`h-6 w-6`、窄屏 `h-8 w-8`，与发送键和换行键同高）；**恒可点**
                    （宿主里 ESC 后面还要接 rewind，这一枚就是那记键），只在点完之后
                    冷却几秒——连发会把刚开的那层菜单也退掉。 */}
                <button
                  type="button"
                  title={t('tasks.stopTooltip')}
                  aria-label={t('tasks.stopTooltip')}
                  disabled={escCooldown > 0}
                  onClick={() => {
                    onInterrupt(sessionId);
                    setEscCooldown(ESC_COOLDOWN_S);
                  }}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-edge/[0.1] text-neutral-400 transition-colors hover:border-red-500/40 hover:text-red-300 disabled:opacity-30 disabled:hover:border-edge/[0.1] disabled:hover:text-neutral-400 max-lg:h-8 max-lg:w-8"
                >
                  <FeedbackIcon
                    state={interruptStateOf(sessionId)}
                    className="h-3 w-3"
                    icon={
                      <span className="text-[9px] font-medium tracking-tight max-lg:text-[10px]">
                        {escCooldown > 0 ? escCooldown : 'ESC'}
                      </span>
                    }
                  />
                </button>
                {/* 发送键只有一枚：手动面恒走层② 终端击键，没有通道可选（直投/中继
                    留给后续的会话协作与编排域）。恒为方块（文字会把它撑宽，还让
                    它与 ESC、换行那两枚不同高）。 */}
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
                  aria-label={t('tasks.messagesSend')}
                  onClick={send}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-blue-600/80 text-white transition-colors hover:bg-blue-500 disabled:opacity-40 max-lg:h-8 max-lg:w-8"
                >
                  <FeedbackIcon
                    state={fb.stateOf(`sendMsg:${sessionId}`)}
                    className="h-3 w-3"
                    icon={<Send className="h-3 w-3" />}
                  />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 状态栏条（输入框下方、贴底边）：只读，配置入口在个性化配置里；
            一块都渲染不出（配置里的块都要宿主 stdin 字段）就不摆（见 StatuslineBar）。 */}
        <StatuslineBar
          projectId={projectId}
          sessionName={sessionRow?.title ?? label}
          model={modelValue || null}
          effort={sessionRow?.effort ?? null}
        />

        {/* 拖角改大小（浮窗限定：嵌入右栏时尺寸归布局） */}
        {!embedded && isDesktop && (
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
            <span className="pointer-events-none absolute bottom-1 right-1 h-2 w-2 rounded-br border-b border-r border-edge/20" />
          </div>
        )}

        {/* 弹出菜单：气泡右键一项「多选」／分享图片两项（复制 / 下载）。 */}
        {menu &&
          createPortal(
            <div
              data-conv-menu
              className="fixed z-[60] rounded-lg border border-edge/[0.1] bg-neutral-900 py-1 shadow-mac"
              style={{
                left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_W - 8)),
                top: Math.max(8, Math.min(menu.y, window.innerHeight - MENU_H)),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {menu.kind === 'bubble' ? (
                <>
                  <button
                    type="button"
                    onClick={() => enterSelect(menu.key)}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-neutral-200 hover:bg-edge/[0.06]"
                  >
                    <Check className="h-3 w-3 text-neutral-500" />
                    {t('tasks.convSelect')}
                  </button>
                  {/* 汇总的是这一轮（锚所在轮：上一次回复 → 这一次回复）；「全部」在弹窗里切 */}
                  <button
                    type="button"
                    onClick={() => {
                      setMenu(null);
                      setEditsRange(editsWindowOf(thread, menu.key));
                      setEditsOpen(true);
                    }}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-neutral-200 hover:bg-edge/[0.06]"
                  >
                    <FileDiff className="h-3 w-3 text-neutral-500" />
                    {t('tasks.editsTitle')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => shareImage('clipboard')}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-neutral-200 hover:bg-edge/[0.06]"
                  >
                    <Copy className="h-3 w-3 text-neutral-500" />
                    {t('tasks.convShareCopy')}
                  </button>
                  <button
                    type="button"
                    onClick={() => shareImage('download')}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-neutral-200 hover:bg-edge/[0.06]"
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
                className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-full border border-edge/[0.15] bg-neutral-900 text-neutral-300 hover:text-neutral-100"
              >
                <X className="h-4 w-4" />
              </button>
              <img
                src={`${API_BASE}/images/${lightbox.id}`}
                alt={lightbox.name}
                onClick={(e) => e.stopPropagation()}
                className="max-h-full max-w-full rounded-lg border border-edge/[0.12] object-contain"
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
          onConfirm={() => onClose?.()}
          onClose={() => setConfirming(false)}
        />

        {/* 切模式确认：同上一份弹窗范式（z-50 同层，后渲染的那扇在上）。 */}
        <ConfirmDialog
          open={confirmMode}
          title={t('tasks.modeConfirmTitle')}
          message={t('tasks.modeConfirm')}
          confirmLabel={t('tasks.modeConfirmAction')}
          onConfirm={cycleMode}
          onClose={() => setConfirmMode(false)}
        />

        {/* 文件引用选择器：选中的表达式由服务端按 harness 文法算好，这里只管贴进输入框；
            带着 `chip` 来的那次是「改这枚胶囊」，落定就地替换 */}
        {picker && (
          <FilePicker
            sessionId={sessionId}
            rootLabel={projectLabel}
            linesSupported={capability.pathRefLines}
            dirSupported={capability.pathRefKinds.includes('dir')}
            initial={picker.initial}
            onPick={insertRefs}
            onClose={closePicker}
          />
        )}

        {/* 改动汇总：默认这一轮的文件（取数归 harness 能力面，diff 在本页算） */}
        <SessionEditsDialog
          sessionId={sessionId}
          range={editsRange}
          open={editsOpen}
          onClose={() => setEditsOpen(false)}
        />

        {/* 旁路会话（claude = /btw）：问句只有 weave 自己记，回答由采集事件认领回来 */}
        {sideOpen && (
          <SideQuestionDialog
            sessionId={sessionId}
            label={label}
            onClose={() => setSideOpen(false)}
          />
        )}
      </div>
  );

  if (embedded) return body;

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-50 items-center justify-center bg-black/50 p-4',
        minimized ? 'hidden' : 'flex',
      )}
      onClick={onMinimize}
    >
      {body}
    </div>,
    document.body,
  );
}
