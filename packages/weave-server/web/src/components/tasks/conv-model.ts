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
/** 滑动窗口 100 条（用户裁决）：只留尾巴这么多，超出从头裁。 */
const CONV_CACHE_MAX = 100;

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
 *  在队列里标「已送达」自相矛盾——那是对话气泡上的事，这里它叫「已发出」。
 *  已回执的命令行（`/compact` 之类）更进一步：内建命令没有气泡，宿主后续事件
 *  即「已执行」的旁证——标「已执行」，别让它顶着「已发出」挂到行消失。 */
export const queueStatusKey = (
  m: Pick<SessionMessageRow, 'status' | 'acked'>,
): (typeof STATUS_KEY)[SessionMessageRow['status']] | 'tasks.msgStatusSent' | 'tasks.msgStatusExecuted' => {
  if (m.status === 'delivered') return m.acked === true ? 'tasks.msgStatusExecuted' : 'tasks.msgStatusSent';
  return STATUS_KEY[m.status];
};

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
  /** 阻塞提问前模型写下的说明（转录里认的，没有自己的事件）。 */
  preQuestion?: boolean;
  /** 旁白：转录补采的中间 assistant 输出（Stop.lam 之外的段落，没有自己的事件）。 */
  narration?: boolean;
  /** 已被回退（宿主 rewind 把这段对话退掉了）：置灰保留展示，不参与「最新回复」。 */
  rewound?: boolean;
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
        // `[Image #N]` 占位记号**保留在正文里**：气泡按它把图内联回原位置
        // （渲染层把记号换成缩略图），大预览行照旧挂在气泡上。
        text,
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

/** 正文切段的一节：文本段或内联图。 */
export type ImageSeg = { kind: 'text'; text: string } | { kind: 'image'; image: UploadFile };

/**
 * 正文按 `[Image #N]` 占位记号切段：记号处内联回对应的图（`images[i]` 按出现
 * 顺序对应），其余是文本段。记号比图多的尾段照常给文本；图比记号多时多余的
 * 图不内联（大预览行里还有）。**只对带图条目用**——没图的条目记号是死文本
 * （宿主没真的配上图），照原样显示。
 *
 * 记号的位置是宿主给的：claude 粘贴处理器把独立成行的图片路径抽出转图后，
 * `[Image #N] ` 记号与剩余文本**先后都插在光标点**（2.1.296 取证）⇒ 记号恒聚在
 * 消息开头，不管原路径写在句中还是句尾。气泡按记号位置渲染 = 忠实还原宿主
 * TUI 里用户看到的形态（图在开头），不是 weave 丢了位置。
 */
export function imageMarkerSegments(text: string, images: readonly UploadFile[]): ImageSeg[] {
  if (images.length === 0) return [{ kind: 'text', text }];
  const out: ImageSeg[] = [];
  let at = 0;
  let n = 0;
  for (const m of text.matchAll(IMAGE_MARKER)) {
    if (m.index! > at) out.push({ kind: 'text', text: text.slice(at, m.index) });
    if (n < images.length) out.push({ kind: 'image', image: images[n]! });
    else out.push({ kind: 'text', text: m[0] });
    n += 1;
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/**
 * 投递行原文按图片路径切段（web 发的带图消息用）：占位胶囊原地展开，路径在
 * 原文里的位置就是用户摆的位置。宿主粘贴处理会把独立成行的图片路径抽走转图、
 * `[Image #N]` 记号聚到消息开头（见上）——会话侧正文已丢位置，投递行存的用户
 * 原文里位置完好，按它切段才能把图内联回用户摆的地方。认不出任何路径返回
 * null（调用方退回记号切段，图归预览行）。
 */
export function pipePathSegments(pipeText: string, images: readonly UploadFile[]): ImageSeg[] | null {
  const spots = images
    .flatMap((image) => (image.path ? [{ image, at: pipeText.indexOf(image.path) }] : []))
    .filter((s) => s.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (spots.length === 0) return null;
  const out: ImageSeg[] = [];
  let at = 0;
  for (const spot of spots) {
    if (spot.at > at) out.push({ kind: 'text', text: pipeText.slice(at, spot.at) });
    out.push({ kind: 'image', image: spot.image });
    at = spot.at + spot.image.path!.length;
  }
  if (at < pipeText.length) out.push({ kind: 'text', text: pipeText.slice(at) });
  return out;
}

/**
 * 渲染块引用行（weave 渲染块协议，文法常量镜像自 core `VISUALIZATION_PROTOCOL`
 * ——web 运行时不能 import core 值，import type 纪律，见 lifecycle.ts 同款说辞）：
 * U+E200 + `visualize` + U+E202 + JSON + 可选 U+E201，独立成行出现在 assistant
 * 最终回复里，指向一个 HTML fragment 文件的绝对路径。
 */
const VIZ_REF_PREFIX = '\u{e200}visualize\u{e202}';
const VIZ_REF_SUFFIX = '\u{e201}';

/** 渲染块引用（引用行解析产物）：fragment 文件绝对路径 + 可选标题/宽幅。 */
export interface VisualizeRef {
  path: string;
  title?: string;
  mode?: 'wide';
}

/** 对话正文切段的一节：文本段或渲染块。 */
export type VizSeg = { kind: 'text'; text: string } | { kind: 'viz'; ref: VisualizeRef };

/** 引用行 → ref；认不出（JSON 坏 / 缺 path / path 非字符串）返回 null，调用方当普通文本。 */
function visualizeRefOf(line: string): VisualizeRef | null {
  if (!line.startsWith(VIZ_REF_PREFIX)) return null;
  const body = line.slice(VIZ_REF_PREFIX.length).endsWith(VIZ_REF_SUFFIX)
    ? line.slice(VIZ_REF_PREFIX.length, -VIZ_REF_SUFFIX.length)
    : line.slice(VIZ_REF_PREFIX.length);
  try {
    const parsed = JSON.parse(body) as { path?: unknown; title?: unknown; mode?: unknown };
    if (typeof parsed.path !== 'string' || !parsed.path) return null;
    return {
      path: parsed.path,
      ...(typeof parsed.title === 'string' && parsed.title ? { title: parsed.title } : {}),
      ...(parsed.mode === 'wide' ? { mode: 'wide' as const } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * assistant 正文按渲染块引用行切段：引用行整行替换成 viz 段（气泡里渲染成
 * sandbox iframe），其余是文本段。坏行（前缀对但 JSON 认不出）当普通文本——
 * 最宽容，不摆错误壳。**只对 assistant 条目用**（引用行只出现在最终回复）。
 */
export function visualizeSegments(text: string): VizSeg[] {
  const out: VizSeg[] = [];
  let buf: string[] = [];
  for (const line of text.split('\n')) {
    const ref = visualizeRefOf(line.trim());
    if (ref) {
      if (buf.length) {
        out.push({ kind: 'text', text: buf.join('\n') });
        buf = [];
      }
      out.push({ kind: 'viz', ref });
    } else {
      buf.push(line);
    }
  }
  if (buf.length) out.push({ kind: 'text', text: buf.join('\n') });
  return out;
}

/** 正文里有没有渲染块引用行（渲染层零开销短路用）。 */
export function hasVisualizeRef(text: string): boolean {
  return text.includes(VIZ_REF_PREFIX);
}

/** 剥掉全部渲染块引用行（HTML 导出与分享图片用——私有区字符在那两种载体里是乱码）。 */
export function stripVisualizeRefs(text: string): string {
  return text
    .split('\n')
    .filter((line) => !visualizeRefOf(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 投递行与事件条目是不是同一条消息（归一后全等）。带图的放宽一档：claude 的
 *  粘贴处理会把多行文本的 chunk 用空串连起来，且正文里的图会变成 `[Image #N]`
 *  占位——不剥占位就永远认领不到，同一条消息会显示两遍（一遍真气泡、一遍停在
 *  投递样式上）。占位胶囊原地展开的图片路径行（`rowPaths` 里那些）在会话那侧
 *  同样被换成占位记号，归一时一并剥掉。 */
function claims(entryText: string, rowText: string, rowPaths: readonly string[] = []): boolean {
  const a = normalizeText(entryText);
  const b = normalizeText(rowText);
  if (a === b) return true;
  if (rowPaths.length === 0) return false;
  const drop = (s: string): string =>
    s
      .replace(IMAGE_MARKER, '')
      .replace(
        new RegExp(
          rowPaths
            .filter((p) => p)
            .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|'),
          'g',
        ),
        '',
      )
      .replace(/\s+/g, '');
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
      if (taken.has(m.id)) continue;
      if (!claims(entry.text, m.text, (m.attachments ?? []).map((a) => a.path ?? ''))) continue;
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

/** 提问前说明插进对话流（位置 = 按时刻，与命令回显同一条时间线）：阻塞提问不发
 *  Stop，这段话没有自己的事件，只有转录时刻——摆在提问气泡（若有）之前才对味。 */
export function withPreQuestion(
  entries: readonly ConvEntry[],
  pre: { at: string; text: string } | null,
): ConvEntry[] {
  if (!pre || !pre.text.trim()) return [...entries];
  const entry: ConvEntry = {
    key: `q${pre.at}`,
    role: 'assistant',
    at: pre.at,
    text: pre.text,
    preQuestion: true,
  };
  const at = entries.findIndex((e) => e.at > pre.at);
  return at < 0 ? [...entries, entry] : [...entries.slice(0, at), entry, ...entries.slice(at)];
}

/** 旁白文本与既有气泡同文案的归一比对（空白折叠后相等 = 同一句话）。 */
function sameNarration(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/**
 * 旁白插进对话流（位置 = 按时刻）：hook 域只有 Stop.lam 一个文本载体，一轮里
 * 多次输出只有最后一句能进对话气泡——转录里的其余段落（写工具后又补的收尾、
 * 分段讲解）按时刻补进来。**与 close 气泡同文案的跳过**（Stop.lam 本来就在，
 * 补进来就是同一条显示两遍）；时刻取不到的旁白不摆（插哪儿都是猜）。
 */
export function withNarration(
  entries: readonly ConvEntry[],
  narration: ReadonlyArray<{ at: string | null; text: string }> | null,
): ConvEntry[] {
  if (!narration?.length) return [...entries];
  const closeTexts = entries.filter((e) => e.role === 'assistant' && !e.preQuestion).map((e) => e.text);
  const out = [...entries];
  let n = 0;
  for (const seg of narration) {
    const at0 = seg.at;
    if (!at0 || !seg.text.trim()) continue;
    if (closeTexts.some((t) => sameNarration(t, seg.text))) continue;
    const entry: ConvEntry = {
      key: `n${at0}:${n++}`,
      role: 'assistant',
      at: at0,
      text: seg.text,
      narration: true,
    };
    const idx = out.findIndex((e) => e.at > at0);
    if (idx < 0) out.push(entry);
    else out.splice(idx, 0, entry);
  }
  return out;
}

/**
 * 回退标记：宿主 rewind（Esc Esc / `/rewind`）把对话退回历史某处后，被退掉的
 * 那段（上一次回退边界 → 这一次回退时刻之间的既有气泡）置灰保留展示。锚点
 * 时刻是「回退前最后活动」的上界——**晚于它**的既有气泡都在被退掉的区间里；
 * 更早的回退同理逐段叠加（多次 rewind 各管各的段）。
 */
export function withRewinds(
  entries: readonly ConvEntry[],
  rewinds: ReadonlyArray<{ at: string; boundaryAt: string | null }> | null,
): ConvEntry[] {
  if (!rewinds?.length) return [...entries];
  const bounds = rewinds.map((r) => Date.parse(r.at)).filter(Number.isFinite);
  if (bounds.length === 0) return [...entries];
  return entries.map((e) => {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) return e;
    // 任一回退锚点晚于该气泡 = 这一段被退掉过（多次回退取并集）
    if (bounds.some((b) => b > at)) return { ...e, rewound: true };
    return e;
  });
}
