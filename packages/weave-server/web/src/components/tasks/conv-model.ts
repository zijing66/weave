import type { HarnessLifecycle } from '@weavecode/core/harness';
import type {
  CommandExecutionRow,
  HookEventRow,
  SessionMessageRow,
  SessionPlan,
  UploadFile,
} from '@/lib/api';
import { promptOf, rawOf, stripPromptDecor, taskNotificationOf, turnSummaryOf } from '@/lib/hook-payload';
import { isCompactionEnd } from './lifecycle';
import type { SessionStatus } from './session-status';

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

const CONV_KEY = (sessionId: string): string => `weave:conv:${sessionId}`;

/** 命中且没过期才用；读不出/写满了都当没有——缓存是加速，不是功能。 */
export function readConvCache(sessionId: string): ConvEntry[] | null {
  try {
    const raw = sessionStorage.getItem(CONV_KEY(sessionId));
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
      CONV_KEY(sessionId),
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
export const STATUS_BADGE: Record<SessionMessageRow['status'], string> = {
  pending: 'bg-amber-900/40 text-amber-300',
  delivering: 'bg-sky-900/40 text-sky-300',
  running: 'bg-sky-900/40 text-sky-300',
  injected: 'bg-sky-900/40 text-sky-300',
  delivered: 'bg-emerald-900/40 text-emerald-300',
  succeeded: 'bg-emerald-900/40 text-emerald-300',
  failed: 'bg-red-900/40 text-red-300',
  timeout: 'bg-red-900/40 text-red-300',
};
export const STATUS_KEY: Record<
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
export const queueStatusKey = (
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
  /** 随附文件（挂在开轮事件上；图出缩略图，其余出文件行）。 */
  attachments?: UploadFile[];
  /** 这一轮以失败收尾（`lifecycle.closeFailed`）：正文是宿主报的错，不是回答。 */
  failed?: boolean;
  /** 计划模式交出的计划正文（不是某轮的收尾总结，单独标出来给人批阅）。 */
  plan?: boolean;
  /** 命令执行回显（内建命令没有 hook 事件，正文来自转录）：气泡里摆成胶囊 + 输出。 */
  commandOutput?: string;
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
        ...(e.images?.length ? { attachments: e.images } : {}),
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
      if (taken.has(m.id) || !claims(entry.text, m.text, (m.attachments?.length ?? 0) > 0)) continue;
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
 *  活着的进程藏起来。**已发出且拿到回执（delivered + acked）删不掉**——会话那边
 *  已经收到了、气泡随后就来，删掉等于假装撤回一条已经进了对话的消息。**没回执的
 *  已发出行能删**：它正是压着整队的成因行，等到闸超时才有按钮等于把人锁住，而这一
 *  条多半压根没进去，留着只是化石。 */
export function removableOf(m: SessionMessageRow): boolean {
  if (m.status === 'running') return false;
  if (m.status === 'delivered') return m.acked !== true;
  return true;
}

/** 历史过滤：全部 / 我 / 宿主回复 / 其他会话投递（角色 + 来源即过滤键）。 */
export type ConvFilter = 'all' | 'user' | 'assistant' | 'remote';

export const CONV_FILTERS = ['all', 'user', 'assistant', 'remote'] as const;

/** 别的会话投递进来的 prompt：中继壳带 `from-name`，且不是 weave 自己发的
 *  （weave 投递=用户经 dashboard 发话，仍算「我」）。它照样是 user 角色，
 *  但发话的不是用户——不单列就会被算进「我」。 */
export function isRemotePrompt(e: ConvEntry): boolean {
  return e.role === 'user' && e.fromName != null && e.fromWeave !== true;
}

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

/** 命令执行记录插进对话流（按时刻定位；与事件条目同一条时间线）。 */
export function withCommands(
  entries: readonly ConvEntry[],
  executions: readonly CommandExecutionRow[] | null,
): ConvEntry[] {
  if (!executions || executions.length === 0) return [...entries];
  const out = [...entries];
  for (const x of executions) {
    const entry: ConvEntry = {
      key: `x${x.at}:${x.name}`,
      role: 'user',
      at: x.at,
      text: `/${x.name}${x.args ? ` ${x.args}` : ''}`,
      ...(x.output ? { commandOutput: x.output } : {}),
    };
    const at = out.findIndex((e) => e.at > x.at);
    if (at < 0) out.push(entry);
    else out.splice(at, 0, entry);
  }
  return out;
}

export function filterThread(
  thread: readonly ConvEntry[],
  filter: ConvFilter,
): ConvEntry[] {
  if (filter === 'all') return [...thread];
  if (filter === 'remote') return thread.filter(isRemotePrompt);
  if (filter === 'user') return thread.filter((e) => e.role === 'user' && !isRemotePrompt(e));
  return thread.filter((e) => e.role === filter);
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
