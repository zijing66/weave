/**
 * 桌面宠物页（pet.html 独立入口，WebView2 壳加载，不进 React 树）。
 *
 * 职责三件：精灵动画（sprite.ts 契约驱动）、全局聚合状态机（待答 > 失败 >
 * 运行中 > 刚完成 > 空闲——与任务面板同一判据源：/sessions + /hooks/dispatches +
 * /messaging/questions + 既有 hook 帧）、提醒气泡 + 系统通知（tag 与 dashboard
 * 三腿同值去重）。
 *
 * 认证与 dashboard 同一条会话 cookie（宿主 exe 首导航前种进独立 profile）；
 * SSE 走裸 EventSource（本页不引 sse.ts——那是 React 生态的单例总线，这里
 * 一页一线程一条流，断线重连 EventSource 自带）。
 */

import { createSpritePlayer, GAZE_ROW, SPRITE_GRID, type PetAnimation } from './sprite';

const API_BASE = '/api';

// ---------------------------------------------------------------------------
// 数据面：与任务面板同源的三个列表 + 聚合状态机
// ---------------------------------------------------------------------------

interface SessionRow {
  sessionId: string;
  projectId: number | null;
  title: string | null;
  lastSeenAt: string;
  turnOpen?: boolean;
  lastEventType?: string | null;
  pidAlive?: boolean | null;
  interruptedAt?: number | null;
}

interface HookDispatch {
  sessionId: string | null;
  status: 'pending' | 'injected' | 'running' | 'succeeded' | 'failed' | 'timeout';
  startedAt: string;
}

interface PendingQuestionEntry {
  sessionId: string;
}

/** 跟随状态的常驻气泡（当前只有待答：问题没了才撤）。 */
interface StateBubble {
  key: string;
  text: string;
  focusSessionId: string | null;
}

interface Aggregated {
  /** 聚合态 → 动画名。 */
  anim: PetAnimation;
  /** 一次性提醒文案（失败/完成；null = 无）。 */
  bubble: string | null;
  /** 触发气泡的会话（通知 tag 用）。 */
  focusSessionId: string | null;
  /** 要常驻的气泡（待答可多条并列）。 */
  stateBubbles: StateBubble[];
}

/** 会话短标签（与 hook-payload.ts sessionLabel 同法）。 */
function labelOf(s: SessionRow | undefined, sessionId: string): string {
  return s?.title ?? sessionId.slice(0, 8);
}

/**
 * 全局聚合：失败 > 运行中 > 刚完成 > 空闲（待答只进气泡，不抢动画——
 * 提问时宠物该干嘛干嘛，问题挂起不等于活儿停了）。
 * 判据与 session-status.ts 同源（turnOpen/lastEventType/pidAlive/interruptedAt
 * + dispatch 状态），只是压成全局一态。
 */
function aggregate(
  sessions: SessionRow[],
  dispatches: HookDispatch[],
  questions: PendingQuestionEntry[],
): Aggregated {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const now = Date.now();

  const runningDispatch = new Set(
    dispatches.filter((d) => d.status === 'running').map((d) => d.sessionId),
  );
  const failedLatest = new Map<string, string>(); // sessionId → startedAt
  for (const d of dispatches) {
    if (d.sessionId && (d.status === 'failed' || d.status === 'timeout')) {
      const prev = failedLatest.get(d.sessionId);
      if (!prev || d.startedAt > prev) failedLatest.set(d.sessionId, d.startedAt);
    }
  }

  // 待答：每个待答会话各一条常驻气泡，答完才撤；动画不因此切换
  const stateBubbles: StateBubble[] = questions.map((entry) => ({
    key: `q:${entry.sessionId}`,
    text: `⏳ ${labelOf(byId.get(entry.sessionId), entry.sessionId)} 等你回答`,
    focusSessionId: entry.sessionId,
  }));
  // 失败（最新一次失败的派发，30 分钟内才算新闻）
  const failed = [...failedLatest.entries()]
    .filter(([, at]) => now - Date.parse(at) < 30 * 60_000)
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))[0];
  if (failed) {
    return {
      anim: 'failed',
      bubble: `✗ ${labelOf(byId.get(failed[0]), failed[0])} 任务失败`,
      focusSessionId: failed[0],
      stateBubbles,
    };
  }
  // 运行中：running dispatch / 回合开着且有近期活动 → 结网循环（织网=干活）。
  // 口径与 session-status.ts 的 deriveSessionStatus 对齐：turnOpen 只在静默不超
  // STALE_TURN_MS 时算运行中（回合开着的会话可能早被丢下，卡住就永远在织网），
  // turnOpen 已知为 false 时即使刚有事件也不算运行中。
  for (const s of sessions) {
    if (s.pidAlive === false || s.lastEventType === 'SessionEnd' || s.interruptedAt != null) continue;
    const quiet = now - Date.parse(s.lastSeenAt);
    const busy =
      runningDispatch.has(s.sessionId) ||
      (s.turnOpen === true ? quiet < STALE_TURN_MS : s.turnOpen !== false && quiet < ACTIVE_WINDOW_MS);
    if (busy) {
      return { anim: 'review', bubble: null, focusSessionId: null, stateBubbles };
    }
  }
  // 刚完成：3 分钟内有过运行、现在没了 → 挥腿庆祝一小段（review 已让给运行中的结网循环）
  if (wasRunningRecently(now)) {
    return { anim: 'waving', bubble: '✓ 全部完成', focusSessionId: null, stateBubbles };
  }
  return { anim: 'idle', bubble: null, focusSessionId: null, stateBubbles };
}

/** 「刚完成」判据的运行痕迹：上一拍聚合成运行中（结网循环）的时刻。 */
let lastRunningAt = 0;
const JUST_FINISHED_MS = 3 * 60_000;
/** 与 session-status.ts 同值：回合开着的静默兜底窗 / 回合未知时的活动窗。 */
const STALE_TURN_MS = 5 * 60_000;
const ACTIVE_WINDOW_MS = 30_000;

function wasRunningRecently(now: number): boolean {
  return lastRunningAt > 0 && now - lastRunningAt < JUST_FINISHED_MS;
}

// ---------------------------------------------------------------------------
// 拉取与 SSE
// ---------------------------------------------------------------------------

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    if (res.status === 401) return null; // cookie 失效：宿主会重开窗补种
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

let sessions: SessionRow[] = [];
let dispatches: HookDispatch[] = [];
let questions: PendingQuestionEntry[] = [];

async function refreshAll(): Promise<void> {
  const [s, d, q] = await Promise.all([
    fetchJson<{ sessions: SessionRow[] }>('/sessions'),
    fetchJson<{ dispatches: HookDispatch[] }>('/hooks/dispatches?limit=200'),
    fetchJson<{ questions: PendingQuestionEntry[] }>('/messaging/questions'),
  ]);
  if (s) sessions = s.sessions;
  if (d) dispatches = d.dispatches;
  if (q) questions = q.questions;
}

function connectSse(onEvent: () => void): void {
  const es = new EventSource(`${API_BASE}/events`);
  es.onmessage = (ev) => {
    try {
      const frame = JSON.parse(ev.data) as { type?: string; kind?: string };
      if (frame.type === 'ping') return;
      // hook 域帧（event.ingested/dispatch.*/watch.fired/question.pending）与
      // resync 都值得重算；其余帧忽略
      if (frame.type === 'hook' || frame.type === 'resync') onEvent();
    } catch {
      // 坏帧忽略
    }
  };
  // EventSource 自带重连；401 时服务端关流，重连风暴由浏览器背压兜住
}

// ---------------------------------------------------------------------------
// 提醒：气泡 + 系统通知（tag 与 dashboard 三腿同值去重）
// ---------------------------------------------------------------------------

/** 气泡栈：宠物上方一列。待答条目跟着状态常驻（问题没了才撤），
 * 其余提醒一次性——失败 6s、会话完成 10s。 */
const bubblesEl = document.getElementById('bubbles')!;
const zzzEl = document.getElementById('zzz')!;
/** 一列最多几条：窗口小，再多就盖住宠物了（超出丢最旧的）。 */
const MAX_BUBBLES = 4;
const FAILED_TTL_MS = 6_000;
const DONE_TTL_MS = 10_000;

interface BubbleItem {
  el: HTMLDivElement;
  /** 过期时刻（ms）；null = 跟着状态常驻。 */
  until: number | null;
  focusSessionId: string | null;
}

const bubbleItems = new Map<string, BubbleItem>();

/** 会话 → dashboard 对话深链：三级路由 `/p/<projectId>/tasks/<sid>` 直接落进
 *  对应项目的对话（route.ts 的唯一真源）；会话不在列表上（归属未知）才退回首页。 */
function dashboardUrlFor(sessionId: string | null): string {
  if (!sessionId) return '/';
  const pid = sessions.find((s) => s.sessionId === sessionId)?.projectId;
  return pid != null
    ? `${location.origin}/p/${pid}/tasks/${encodeURIComponent(sessionId)}`
    : `${location.origin}/?focus=${encodeURIComponent(sessionId)}`;
}

/** 在默认浏览器里打开 dashboard：WebView2 壳内 window.open 只在壳里开新窗
 * （宿主没有 NewWindowRequested 处理，会被吞）——宿主认 `open:<url>` 走
 * Process.Start；普通浏览器调试没有 chrome.webview，退回 window.open。 */
function openDashboard(url: string): void {
  if (hostWebview()) postToHost(`open:${url}`);
  else window.open(url, 'weave-dashboard');
}

function upsertBubble(
  key: string,
  text: string,
  opts: { ttlMs?: number; focusSessionId?: string | null } = {},
): void {
  let item = bubbleItems.get(key);
  if (!item) {
    const el = document.createElement('div');
    el.className = 'bubble';
    el.onclick = () => {
      const sid = bubbleItems.get(key)?.focusSessionId;
      if (sid) openDashboard(dashboardUrlFor(sid));
    };
    bubblesEl.appendChild(el);
    item = { el, until: null, focusSessionId: null };
    bubbleItems.set(key, item);
    requestAnimationFrame(() => el.classList.add('show'));
  }
  item.el.textContent = text;
  item.focusSessionId = opts.focusSessionId ?? null;
  item.until = opts.ttlMs != null ? Date.now() + opts.ttlMs : null;
  while (bubblesEl.children.length > MAX_BUBBLES) {
    const oldest = bubblesEl.children[0]!;
    const keyOfOldest = [...bubbleItems.entries()].find(([, b]) => b.el === oldest)?.[0];
    if (!keyOfOldest || keyOfOldest === key) break;
    removeBubble(keyOfOldest);
  }
}

function removeBubble(key: string): void {
  const item = bubbleItems.get(key);
  if (!item) return;
  bubbleItems.delete(key);
  item.el.classList.remove('show');
  window.setTimeout(() => item.el.remove(), 260);
}

function pruneBubbles(): void {
  const now = Date.now();
  for (const [key, item] of bubbleItems) {
    if (item.until !== null && now >= item.until) removeBubble(key);
  }
}

window.setInterval(pruneBubbles, 500);

function notifySystem(title: string, body: string, tag: string, url: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    // 系统通知点击 → 默认浏览器落深链（WebView2 桌面通知带 onclick）
    n.onclick = () => openDashboard(url);
  } catch {
    // 构造失败不影响动画
  }
}


// ---------------------------------------------------------------------------
// 渲染循环
// ---------------------------------------------------------------------------

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// 贴边偷窥：窗贴屏幕边缘时「沉下去」只露一小条（头），鼠标移入探出全身，
// 移走自动收回。**窗永远完整在工作区内**——WPF 分层窗透明像素对鼠标穿透，
// 窗滑出屏后露出的窄条若没有不透明像素就永远 hover 不到（CDP 实证）；
// 故藏/露全部用绘制实现：canvas 底边/侧边就是天然的「屏幕边缘」裁剪线，
// 精灵朝边外平移、身子被画布裁掉，视觉与沉到屏外一致而命中测试始终可靠。
// ---------------------------------------------------------------------------

/** 偷窥态露出的宽度（CSS px）：够一眼认出「那儿蹲着个东西」且可 hover。 */
const PEEK_PX = 36;
/** 偷窥全藏时的缩放：缩小躲进边缘，悬停滑出并放大回常态。 */
const PEEK_SCALE = 0.55;
/** 贴边判定：窗缘距所在屏工作区缘 ≤ 此值算贴边。 */
const SNAP_TOLERANCE = 24;
/** 展开/收回过渡时长（毫秒）。 */
const PEEK_TRANSITION_MS = 220;

type PeekSide = 'left' | 'right' | 'bottom';

let peekSide: PeekSide | null = null; // 当前贴边侧（null = 自由位，不管窗）
let peekExpanded = false; // 鼠标在窗上 → 展开；移走/从未进来 → 收回头（初值 false：daemon 拉窗落贴边位就直接藏）
let dragging = false; // DragMove 模态循环进行中：暂停一切自动挪窗
let peekProgress = 1; // 1 = 常态位，0 = 全藏（只露 PEEK_PX）
let snapped = false; // 已完成一次性吸附（窗 flush 到工作区缘）
let lastTs = 0;

/** 窗口位置（屏幕 CSS px）。WebView2 的 screenX/Y 不随宿主挪窗更新 ⇒ 以宿主 pos: 回执为准。 */
let hostPos = { x: window.screenX, y: window.screenY };

/** 当前窗相对所在屏工作区的几何（CSS px）。 */
function windowGeometry(): {
  wx: number; wy: number; ww: number; wh: number;
  availLeft: number; availTop: number; sw: number; sh: number;
} {
  const scr = window.screen;
  // 多屏：窗口可能落在副屏（坐标为负），availLeft/availTop 补工作区原点
  const availLeft = (scr as Screen & { availLeft?: number }).availLeft ?? 0;
  const availTop = (scr as Screen & { availTop?: number }).availTop ?? 0;
  return {
    wx: hostPos.x,
    wy: hostPos.y,
    ww: window.innerWidth,
    wh: window.innerHeight,
    availLeft,
    availTop,
    sw: scr.availWidth,
    sh: scr.availHeight,
  };
}

type Geo = ReturnType<typeof windowGeometry>;

/** 贴边侧：窗缘距工作区缘 ≤ 容差即贴边。 */
function detectPeekSide(g: Geo): PeekSide | null {
  if (g.wx - g.availLeft <= SNAP_TOLERANCE) return 'left';
  if (g.availLeft + g.sw - (g.wx + g.ww) <= SNAP_TOLERANCE) return 'right';
  if (g.availTop + g.sh - (g.wy + g.wh) <= SNAP_TOLERANCE) return 'bottom';
  return null;
}

/**
 * 一次性吸附：进入贴边态时沿贴边轴把窗 flush 到工作区缘（另一轴不动）。
 * 只在这一刻挪窗——之后窗稳稳贴在缘上，整个窗都在屏内，命中区恒可靠。
 */
function snapToEdge(side: PeekSide, g: Geo): void {
  let nx = g.wx;
  let ny = g.wy;
  if (side === 'left') nx = g.availLeft;
  else if (side === 'right') nx = g.availLeft + g.sw - g.ww;
  else ny = g.availTop + g.sh - g.wh;
  // 目标与当前差不足半像素就视为已到位：浮点严格比较会把 DIP 换算的零点几
  // 像素残差当「没到位」，moveto 每拍重发、窗持续微挪。
  if (Math.abs(nx - g.wx) >= 0.5 || Math.abs(ny - g.wy) >= 0.5) postToHost(`moveto:${nx},${ny}`);
}

/** 每帧推进：贴边检测、一次性吸附、进度缓动（藏/露全在绘制层，不再挪窗）。 */
function updatePeek(now: number): void {
  if (dragging) {
    lastTs = now; // DragMove 模态循环里宿主正被用户拖着走，我们不发 moveto
    snapped = false;
    return;
  }
  const dt = lastTs === 0 ? 16 : now - lastTs;
  lastTs = now;
  const side = detectPeekSide(windowGeometry());
  if (side !== peekSide) {
    peekSide = side;
    snapped = false;
    if (side === null) {
      peekProgress = Math.min(1, peekProgress + dt / PEEK_TRANSITION_MS); // 离开贴边 → 回全身
      return;
    }
    snapToEdge(side, windowGeometry());
    return;
  }
  if (peekSide === null) return;
  if (!snapped) {
    snapToEdge(peekSide, windowGeometry()); // moveto 异步，到位前每拍补发
    const g = windowGeometry();
    // ≤2px 就算到位：moveto 目标与宿主实际落点差 1px 时，≤1 的判据永远不满
    // 足 ⇒ snapped 反复跳变、moveto 每拍重发、窗持续 1px 微挪 = 整只高频颤动
    // （悬停贴边时实测）。
    const done =
      peekSide === 'left'
        ? g.wx - g.availLeft <= 2
        : peekSide === 'right'
          ? g.availLeft + g.sw - (g.wx + g.ww) <= 2
          : g.availTop + g.sh - (g.wy + g.wh) <= 2;
    if (done) snapped = true;
    return;
  }

  // 目标进度：展开 → 全身；收起 → 只露头。reducedMotion 直接跳到位。
  const goal = peekExpanded ? 1 : 0;
  if (reducedMotion) {
    peekProgress = goal;
  } else {
    const step = (goal - peekProgress) * Math.min(1, dt / PEEK_TRANSITION_MS);
    peekProgress += step;
    if (Math.abs(goal - peekProgress) < 0.01) peekProgress = goal;
  }
}

/** 常态绘制区：底部居中、单元比例适配（气泡留顶部空间）。 */
function normalPetRect(): { x: number; y: number; w: number; h: number } {
  const w = canvas.width;
  const h = canvas.height;
  const scale = Math.min(w / SPRITE_GRID.cellWidth, (h * 0.82) / SPRITE_GRID.cellHeight);
  const pw = SPRITE_GRID.cellWidth * scale;
  const ph = SPRITE_GRID.cellHeight * scale;
  return { x: (w - pw) / 2, y: h - ph, w: pw, h: ph };
}

/** 偷窥全藏位：整只缩小到 PEEK_SCALE、只露出靠边那一截——悬停滑出并放大回常态。
 * 露出量按**内容包围盒**对齐（单元格留白大，按整格对齐露出的会是空白）。 */
function peekPetRect(side: PeekSide): { x: number; y: number; w: number; h: number } {
  const n = normalPetRect();
  const w = n.w * PEEK_SCALE;
  const h = n.h * PEEK_SCALE;
  const peekPx = PEEK_PX * (window.devicePixelRatio || 1);
  const box = contentBoxOf(player.current());
  const top = (box ? box.y0 : SPRITE_GRID.cellHeight * 0.2) / SPRITE_GRID.cellHeight;
  const left = (box ? box.x0 : SPRITE_GRID.cellWidth * 0.25) / SPRITE_GRID.cellWidth;
  const rightGap = (box ? SPRITE_GRID.cellWidth - 1 - box.x1 : SPRITE_GRID.cellWidth * 0.25) / SPRITE_GRID.cellWidth;
  if (side === 'bottom') {
    // 内容顶压在「画布底 − PEEK_PX」：头顶露出一条、身子沉出底缘
    return { x: n.x + (n.w - w) / 2, y: canvas.height - peekPx - top * h, w, h };
  }
  if (side === 'right') {
    return { x: canvas.width - peekPx - left * w, y: n.y + (n.h - h) / 2, w, h };
  }
  return { x: peekPx - (1 - rightGap) * w, y: n.y + (n.h - h) / 2, w, h };
}

/** 当前帧绘制区：常态位（满尺寸）与偷窥位（缩小贴边）按 peekProgress 插值。 */
function currentPetRect(): { x: number; y: number; w: number; h: number } {
  const n = normalPetRect();
  if (peekSide === null || peekProgress >= 1) return n;
  const p = peekPetRect(peekSide);
  const t = 1 - peekProgress; // 1 = 常态位（progress 1），0 = 藏身位
  return {
    x: n.x + (p.x - n.x) * t,
    y: n.y + (p.y - n.y) * t,
    w: n.w + (p.w - n.w) * t,
    h: n.h + (p.h - n.h) * t,
  };
}

let sheet: HTMLImageElement | null = null;
const player = createSpritePlayer('idle');

// ---------------------------------------------------------------------------
// 精灵内容包围盒（按动画行扫 alpha，逐行动画首帧时算一次）：偷窥对齐与
// **窗口命中区**（宿主 SetWindowRgn）都用它——命中区贴合真实像素，
// 空白处点穿到桌面，避免整块透明窗误触。
// ---------------------------------------------------------------------------

const contentBoxes = new Map<PetAnimation, { x0: number; y0: number; x1: number; y1: number }>();

function measureRow(img: HTMLImageElement, anim: PetAnimation): { x0: number; y0: number; x1: number; y1: number } | null {
  const frames = PET_ANIMS[anim].frames;
  const cw = SPRITE_GRID.cellWidth;
  const ch = SPRITE_GRID.cellHeight;
  const probe = document.createElement('canvas');
  probe.width = cw * frames;
  probe.height = ch;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  if (!pctx) return null;
  pctx.drawImage(img, 0, PET_ANIMS[anim].row * ch, probe.width, ch, 0, 0, probe.width, ch);
  const { data } = pctx.getImageData(0, 0, probe.width, ch);
  // 逐帧算单元格内包围盒再取并集（跨帧的绝对最大/最小不能直接对 cw 取模）
  let x0 = cw;
  let y0 = ch;
  let x1 = -1;
  let y1 = -1;
  for (let f = 0; f < frames; f++) {
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (data[(y * probe.width + f * cw + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1 };
}

function contentBoxOf(anim: PetAnimation): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!sheet) return null;
  let box = contentBoxes.get(anim);
  if (!box) {
    const measured = measureRow(sheet, anim);
    if (!measured) return null;
    box = measured;
    contentBoxes.set(anim, box);
  }
  return box;
}

/** 窗口命中区 = 精灵真实像素包围盒 ∪ 气泡 ∪ 菜单（宿主 SetWindowRgn）。
 * 区域外既不显示也不收鼠标 ⇒ 点空白处穿透到桌面，不会「点到窗」。
 * 偷窥过渡期间同时算常态位与藏身位并集——区域每帧缩张会带出成对
 * enter/leave，悬停判定跟着抖。 */
let lastRegionKey = '';
function syncRegion(): void {
  const dpr = window.devicePixelRatio || 1;
  const box = contentBoxOf(player.current());
  const rects = [currentPetRect()];
  // 过渡中与展开态都取「常态位 ∪ 藏身位」并集：只认当前位的话，过渡收敛的
  // 一瞬间两块之间的空隙被踢出命中区——鼠标停在那儿就 enter/leave 循环，
  // 宠物一伸一缩抖个不停（悬停抖动真凶）。全藏且鼠标不在窗上才收缩到那条缝。
  if (peekSide !== null && (peekExpanded || (peekProgress > 0.01 && peekProgress < 0.99)))
    rects.push(normalPetRect(), peekPetRect(peekSide));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const rect of rects) {
    if (box) {
      x0 = Math.min(x0, rect.x + (box.x0 / SPRITE_GRID.cellWidth) * rect.w);
      x1 = Math.max(x1, rect.x + ((box.x1 + 1) / SPRITE_GRID.cellWidth) * rect.w);
      y0 = Math.min(y0, rect.y + (box.y0 / SPRITE_GRID.cellHeight) * rect.h);
      y1 = Math.max(y1, rect.y + ((box.y1 + 1) / SPRITE_GRID.cellHeight) * rect.h);
    } else {
      x0 = Math.min(x0, rect.x);
      y0 = Math.min(y0, rect.y);
      x1 = Math.max(x1, rect.x + rect.w);
      y1 = Math.max(y1, rect.y + rect.h);
    }
  }
  // 视线微移 + 取整余量（CSS px；区域在设备像素坐标系，dpr 别丢）
  const pad = 5 * dpr; // 取整余量（原视线微移 LEAN_MAX 已退役，留 5px 抗边缘裁切）
  x0 -= pad;
  y0 -= pad;
  x1 += pad;
  y1 += pad;
  // 区域量化到 4 设备像素：zzz 浮动这类 1~2px 的逐帧变化不再
  // 触发 SetWindowRgn 重设（每帧重设带一拍重绘，肉眼即抖）。
  x0 = Math.floor(x0 / 4) * 4;
  y0 = Math.floor(y0 / 4) * 4;
  x1 = Math.ceil(x1 / 4) * 4;
  y1 = Math.ceil(y1 / 4) * 4;
  const overlays: Element[] = [...bubblesEl.children];
  if (zzzEl.classList.contains('show')) overlays.push(zzzEl);
  if (menuEl) overlays.push(menuEl);
  for (const el of overlays) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    x0 = Math.min(x0, r.left * dpr);
    y0 = Math.min(y0, r.top * dpr);
    x1 = Math.max(x1, r.right * dpr);
    y1 = Math.max(y1, r.bottom * dpr);
  }
  const rx = Math.max(0, Math.round(x0));
  const ry = Math.max(0, Math.round(y0));
  const rw = Math.round(Math.min(canvas.width, x1) - rx);
  const rh = Math.round(Math.min(canvas.height, y1) - ry);
  if (rw <= 0 || rh <= 0) return;
  const key = `${rx},${ry},${rw},${rh}`;
  if (key === lastRegionKey) return;
  lastRegionKey = key;
  postToHost(`region:${rx},${ry},${rw},${rh}`);
}

/** 休息（idle）时头右上飘 zzz；位置跟着绘制区与视线微移走，停止时冻住。
 * 字号与浮距按宠物档等比缩放（small 为基准 1）。 */
function syncZzz(): void {
  const resting = player.current() === 'idle';
  zzzEl.classList.toggle('show', resting);
  zzzEl.classList.toggle('frozen', paused);
  if (!resting) return;
  const s = SIZE_PX[petSize].w / SIZE_PX.small.w;
  zzzEl.style.setProperty('--zzz-scale', s.toFixed(2));
  const r = currentPetRect();
  const box = contentBoxOf('idle');
  const right = box ? r.x + ((box.x1 + 1) / SPRITE_GRID.cellWidth) * r.w : r.x + r.w;
  const top = box ? r.y + (box.y0 / SPRITE_GRID.cellHeight) * r.h : r.y;
  // 容器（44×40×s）右上角锚在头部右上：偏移量随容器放大同步调大
  zzzEl.style.left = `${Math.round(right - 22 * s)}px`;
  zzzEl.style.top = `${Math.round(top - 20 * s)}px`;
}

function fitCanvas(): void {
  // 宠物窗尺寸由宿主给定（右键可调档）；画布按 devicePixelRatio 出清晰像素
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.imageSmoothingEnabled = false; // 像素风精灵禁平滑
}

function startLoop(): void {
  if (reducedMotion) {
    // 静止首帧：动画契约时长表不走，但偷窥仍要动（贴边检测/展开收回）——
    // 低频节拍替代 rAF，进度直接跳位（updatePeek 里 reducedMotion 分支）
    const tick = (now: number): void => {
      updatePeek(now);
      if (sheet) {
        const r = currentPetRect();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(sheet, 0, drawRowOf('idle') * SPRITE_GRID.cellHeight, SPRITE_GRID.cellWidth, SPRITE_GRID.cellHeight, r.x, r.y, r.w, r.h);
        syncZzz();
        syncRegion();
      }
      window.setTimeout(tick, 250);
    };
    window.setTimeout(tick, 250);
    return;
  }
  const render = (now: number): void => {
    updatePeek(now);
    if (sheet) {
      // 动画时钟：停止时冻结（恢复后从原处接着走，不按真实流逝快进）
      const dt = lastTick === 0 ? 0 : now - lastTick;
      lastTick = now;
      if (!paused) animClock += dt;
      const frame = player.tick(animClock);
      const r = currentPetRect();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        sheet,
        Math.min(frame, SPRITE_GRID.columns - 1) * SPRITE_GRID.cellWidth,
        drawRowOf(player.current()) * SPRITE_GRID.cellHeight,
        SPRITE_GRID.cellWidth,
        SPRITE_GRID.cellHeight,
        r.x,
        r.y,
        r.w,
        r.h,
      );
      syncZzz();
      syncRegion();
    }
    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);
}

// ---------------------------------------------------------------------------
// 瞳孔注视（gaze 行切换）：鼠标在中心右/左 → idle 画眼白右移行 / 原行。
// 整只 lean 的高频颤动教训在此：动图不动画布——切行是离散选择（gaze 行的
// 帧结构/时长与 idle 完全一致，切换无跳帧感），不产生任何逐帧定位变化。
// ---------------------------------------------------------------------------

let mouseX = 0.5; // 窗内归一位置（0..1；0.5 = 居中）

window.addEventListener('mousemove', (e) => {
  mouseX = e.clientX / Math.max(1, window.innerWidth);
});

/** 资产是否带 gaze 行（row 11）：高度不足 = v1/v2 旧资产，静默退回原行。 */
let hasGazeRow = false;

/** 当前绘制行：idle 且鼠标在中心右侧（留 0.1 居中死区）用 gaze 行。 */
function drawRowOf(anim: PetAnimation): number {
  if (hasGazeRow && anim === 'idle' && mouseX > 0.6) return GAZE_ROW;
  return PET_ANIMS[anim].row;
}

// sprite.ts 的表在这里只读行号——直接引常量对象
import { PET_ANIMATIONS as PET_ANIMS } from './sprite';

// ---------------------------------------------------------------------------
// 状态变迁 → 动画 + 气泡 + 系统通知
// ---------------------------------------------------------------------------

let lastAnim: PetAnimation | null = null;

function applyAggregated(next: Aggregated): void {
  if (next.anim === 'review') lastRunningAt = Date.now(); // review 行 = 运行中的结网循环
  // 运行中（结网）无限循环值守；其余动画主循环 ×3 后自然回落 idle。
  // 停止时连切动画一起冻结（画面完全静止），气泡与提醒照常。
  if (!paused) player.play(next.anim, { loopForever: next.anim === 'review' });

  // 待答：跟随状态常驻（问题答完即撤）；失败 6s、完成 10s 一次性提醒
  const stateKeys = new Set(next.stateBubbles.map((b) => b.key));
  for (const key of [...bubbleItems.keys()]) {
    if (!key.startsWith('q:') || stateKeys.has(key)) continue;
    removeBubble(key);
  }
  for (const b of next.stateBubbles) upsertBubble(b.key, b.text, { focusSessionId: b.focusSessionId });

  if (next.anim !== lastAnim && next.bubble) {
    if (next.anim === 'failed') {
      upsertBubble(`f:${next.focusSessionId ?? ''}`, next.bubble, {
        ttlMs: FAILED_TTL_MS,
        focusSessionId: next.focusSessionId,
      });
    } else if (next.anim === 'waving') {
      upsertBubble('done', next.bubble, { ttlMs: DONE_TTL_MS });
    }
    if (next.focusSessionId && settingsNotifications) {
      const title = next.anim === 'failed' ? 'Weave 失败' : 'Weave';
      notifySystem(
        title,
        next.bubble.replace(/^[⏳✗]\s*/, ''),
        `weave-pet-${next.focusSessionId}`,
        dashboardUrlFor(next.focusSessionId),
      );
    }
  }
  lastAnim = next.anim;
}

let settingsNotifications = true;

// ---------------------------------------------------------------------------
// 拖拽记忆 + 右键菜单
// ---------------------------------------------------------------------------

const POS_KEY = 'weave:pet-pos';

function savePos(): void {
  // 窗恒完整在屏内（吸附后贴缘），直接记当前位置即可
  const pos = hostPos;
  try {
    // localStorage 兜底（settings 写失败时下次至少同浏览器记得）
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    // 存不进就算了
  }
  // 权威记档进 settings（daemon 拉窗带 --pos；跨重启跨浏览器一致）。
  // WebView2 里 window.screenX/Y 即屏幕坐标（DIP）。
  void fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pet: { pos } }),
  }).catch(() => {});
}
window.addEventListener('mouseup', () => {
  dragging = false; // 普通浏览器没有 drag-end 回执，这里兜底解除
  document.body.classList.remove('dragging');
  savePos();
});
window.addEventListener('blur', () => {
  document.body.classList.remove('dragging');
  savePos();
});
// 宿主通道：pos:x,y = 窗口位置真值，drag-end:x,y = 拖拽结束回执（模态循环期间
// 页面收不到 mouseup）。收到 drag-end 即解除拖拽标志并记位（updatePeek 恢复
// 接管；若拖到了屏缘，下一拍自动进偷窥态）。
hostWebview()?.addEventListener('message', (e) => {
  const msg = String((e as MessageEvent).data ?? '');
  const xy = msg.slice(msg.indexOf(':') + 1).split(',').map(Number);
  if (msg.startsWith('pos:') || msg.startsWith('drag-end:')) {
    if (Number.isFinite(xy[0]) && Number.isFinite(xy[1])) hostPos = { x: xy[0]!, y: xy[1]! };
  }
  if (msg.startsWith('drag-end')) {
    dragging = false;
    document.body.classList.remove('dragging');
    peekExpanded = true; // 松手瞬间鼠标还在窗上，先展开，移走再收
    savePos();
  }
});
/** 宿主通道对象（普通浏览器里没有 chrome.webview，返回 null）。 */
function hostWebview(): { postMessage(m: string): void; addEventListener(t: string, l: (e: unknown) => void): void } | null {
  return (window as unknown as { chrome?: { webview?: { postMessage(m: string): void; addEventListener(t: string, l: (e: unknown) => void): void } } })
    .chrome?.webview ?? null;
}

// 位置以宿主为准：先问一次（WebView2 的 screenX/Y 在宿主挪窗后不更新）
postToHost('pos-query');

// 拖拽移动：按下即交宿主 DragMove 接管（模态循环，松手才返回）——页面只管
// 发令与事后记位，不自己做 pointermove 追踪（透明窗里命中测试交给宿主最简）。
// 右键不触发（留给菜单）；宿主侧没有 chrome.webview（普通浏览器调试）时静默。
// **落在气泡/菜单上不进拖拽**：单击气泡是一次「零位移拖拽」，宿主模态循环
// 会吞掉这次 click（mouseup 在 NC 拖拽里到不了页面）——open: 时序竞态，
// 单击时灵时不灵、双击才行（实测）。可点元素上按住也不该挪窗，判据就一条：
// target 在 bubbles/menu 里 = 手柄之外。
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || menuEl) return;
  const target = e.target as Element | null;
  if (target?.closest('.bubble')) return; // #bubbles 容器本身 pointer-events:none，命中的必是 .bubble
  dragging = true; // DragMove 模态循环里 updatePeek 暂停挪窗，别跟手打架
  document.body.classList.add('dragging');
  postToHost('drag-start');
});

// 偷窥展开/收回：鼠标进窗展开、移走收回。偷窥态下窗大部分在屏外，露出的
// 窄条本身就是 hover 区——mouseenter/mouseleave 在窗级监听即可。
document.documentElement.addEventListener('mouseenter', () => {
  peekExpanded = true;
});
document.documentElement.addEventListener('mouseleave', () => {
  peekExpanded = false;
});

/** 右键菜单：原生 contextmenu 在透明窗里由页面画（宿主禁了默认菜单）。 */
let menuEl: HTMLDivElement | null = null;

function closeMenu(): void {
  if (menuCloseTimer !== null) {
    window.clearTimeout(menuCloseTimer);
    menuCloseTimer = null;
  }
  menuEl?.remove();
  menuEl = null;
}

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  closeMenu();
  menuEl = document.createElement('div');
  menuEl.style.cssText =
    'position:absolute;z-index:9;background:#171717;color:#fafafa;border:1px solid #404040;' +
    'border-radius:8px;padding:4px;font:12px system-ui;min-width:120px;box-shadow:0 4px 12px rgba(0,0,0,.4)';

  const item = (label: string, fn: () => void): HTMLDivElement => {
    const el = document.createElement('div');
    el.textContent = label;
    el.style.cssText = 'padding:6px 10px;border-radius:5px;cursor:pointer';
    el.onmouseenter = () => (el.style.background = '#333');
    el.onmouseleave = () => (el.style.background = 'transparent');
    el.onclick = () => {
      closeMenu();
      fn();
    };
    return el;
  };

  menuEl.appendChild(item('打开 Dashboard', () => openDashboard(`${location.origin}/`)));

  // 批量显隐全部终端窗：服务端逐项目枚举目标后逐个 SW_HIDE/SHOW（失败隔离）。
  // 菜单行带胶囊计数——隐藏行显「当前可见 N 窗」、显示行显「当前隐藏 N 窗」，
  // 数是菜单打开那一刻异步拉的（GET 每目标一枪 powershell，~百 ms 量级）。
  const toggleTerminals = (visibility: 'hide' | 'show'): void => {
    void fetch(`${API_BASE}/terminals/visibility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility }),
    });
  };
  const visRow = (label: string, pillBg: string, pillColor: string, countKey: 'visible' | 'hidden', vis: 'hide' | 'show'): HTMLDivElement => {
    const pill = document.createElement('span');
    pill.textContent = '…';
    pill.style.cssText = `flex:none;margin-left:10px;padding:0 7px;border-radius:99px;font-size:10px;line-height:16px;background:${pillBg};color:${pillColor}`;
    const row = item(label, () => toggleTerminals(vis));
    row.style.cssText += 'display:flex;align-items:center;white-space:nowrap';
    row.appendChild(pill);
    void fetchJson<{ visible: number; hidden: number }>(`/terminals/visibility`).then((r) => {
      const n = r?.[countKey] ?? 0;
      pill.textContent = String(n);
      if (n === 0) pill.style.opacity = '0.45';
    });
    return row;
  };
  menuEl.appendChild(visRow('隐藏全部终端', 'rgba(63,185,80,.18)', '#7ee2a8', 'visible', 'hide'));
  menuEl.appendChild(visRow('显示全部终端', 'rgba(139,124,246,.2)', '#b6adff', 'hidden', 'show'));

  // 播放开关：图标表明「点下去会怎样」，文字表明「现在是什么」——悬停时文字
  // 也从状态改成动作，一眼看出这一下会停止还是开始。
  const runRow = document.createElement('div');
  runRow.style.cssText = 'padding:6px 10px;border-radius:5px;cursor:pointer;display:flex;align-items:center;gap:6px';
  const runIcon = document.createElement('span');
  runIcon.style.cssText = 'width:12px;height:12px;display:flex;align-items:center;justify-content:center';
  const runLabel = document.createElement('span');
  // 图标用 CSS 画（■/▶ 两个字符在不同字体里大小对不齐）：8×8 方块 / 8×10 三角
  const paintGlyph = (stopped: boolean): void => {
    runIcon.replaceChildren();
    const g = document.createElement('span');
    g.style.cssText = stopped
      ? 'width:8px;height:8px;border-radius:1px;background:#f85149'
      : 'width:0;height:0;border-left:8px solid #3fb950;border-top:5px solid transparent;border-bottom:5px solid transparent';
    runIcon.appendChild(g);
  };
  const syncRun = (hover: boolean): void => {
    paintGlyph(!paused);
    runLabel.textContent = paused ? (hover ? '开始' : '已暂停') : (hover ? '停止' : '运行中');
  };
  syncRun(false);
  runRow.onpointerenter = () => {
    runRow.style.background = '#333';
    syncRun(true);
  };
  runRow.onpointerleave = () => {
    runRow.style.background = 'transparent';
    syncRun(false);
  };
  runRow.onclick = () => {
    closeMenu();
    togglePause();
  };
  runRow.append(runIcon, runLabel);
  menuEl.appendChild(runRow);

  // 尺寸：滑杆拖动即时生效（三档）
  const sizeRow = document.createElement('div');
  sizeRow.style.cssText = 'padding:4px 10px 8px;display:flex;flex-direction:column;gap:4px;cursor:default';
  sizeRow.onclick = (ev) => ev.stopPropagation();
  const sizeLabel = document.createElement('div');
  sizeLabel.textContent = `大小：${SIZE_ZH[petSize]}`;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(SIZE_ORDER.length - 1);
  slider.step = '1';
  slider.value = String(SIZE_ORDER.indexOf(petSize));
  slider.style.cssText = 'width:100%;margin:0;accent-color:#8b7cf6;cursor:pointer';
  slider.oninput = () => {
    const size = SIZE_ORDER[Number(slider.value)]!;
    sizeLabel.textContent = `大小：${SIZE_ZH[size]}`;
    setSize(size);
  };
  sizeRow.append(sizeLabel, slider);
  menuEl.appendChild(sizeRow);

  menuEl.appendChild(item('关闭宠物', () => closePet()));

  document.body.appendChild(menuEl);
  // 不给 left/top 时 absolute 会落到静态位置（canvas 之下），被 body 的
  // overflow:hidden 整块裁掉。放得下就左上角钉在鼠标处，放不下回弹进窗内。
  menuEl.style.left = `${e.clientX}px`;
  menuEl.style.top = `${e.clientY}px`;
  const mr = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(0, Math.min(e.clientX, window.innerWidth - mr.width))}px`;
  menuEl.style.top = `${Math.max(0, Math.min(e.clientY, window.innerHeight - mr.height))}px`;
});

// 点菜单外的任何地方 → 立刻收起；光标离开窗口 → 稍等再收（窗口区域每帧
// 可能被 SetWindowRgn 重设，会带出成对的 enter/leave，立刻收会自己把自己关掉）
let menuCloseTimer: number | null = null;
document.addEventListener('pointerdown', (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
});
document.documentElement.addEventListener('mouseleave', () => {
  if (menuCloseTimer !== null) return;
  menuCloseTimer = window.setTimeout(() => {
    menuCloseTimer = null;
    closeMenu();
  }, 300);
});
document.documentElement.addEventListener('mouseenter', () => {
  if (menuCloseTimer !== null) {
    window.clearTimeout(menuCloseTimer);
    menuCloseTimer = null;
  }
});

// ---------------------------------------------------------------------------
// 尺寸档（右键循环切换：宿主实时 resize + settings 存档跨重启）
// ---------------------------------------------------------------------------

const SIZE_ORDER = ['small', 'medium', 'large'] as const;
type PetSize = (typeof SIZE_ORDER)[number];
/** 尺寸档 → 窗像素（与 server PET_SIZE_PRESETS 镜像——web 不 import server 值）。 */
const SIZE_PX: Record<PetSize, { w: number; h: number }> = {
  small: { w: 160, h: 192 },
  medium: { w: 200, h: 240 },
  large: { w: 280, h: 336 },
};
const SIZE_ZH: Record<PetSize, string> = { small: '小', medium: '中', large: '大' };

let petSize: PetSize = 'small';

function setSize(size: PetSize): void {
  petSize = size;
  const { w, h } = SIZE_PX[size];
  postToHost(`resize:${w}x${h}`);
  void fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pet: { size } }),
  }).catch(() => {});
}

/** 关闭宠物：先落 settings（enabled=false）再发 close——顺序反了会被崩溃重启拉回来。 */
function closePet(): void {
  void fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pet: { enabled: false } }),
  })
    .catch(() => {})
    .finally(() => postToHost('close'));
}

let paused = false;
/** 动画时钟（毫秒）：只在播放时推进，`player.tick` 吃这个值。 */
let animClock = performance.now();
let lastTick = 0;

function togglePause(): void {
  paused = !paused;
}

/** 宿主通道（WebView2 postMessage；普通浏览器里没有 chrome.webview，静默跳过）。 */
function postToHost(msg: string): void {
  hostWebview()?.postMessage(msg);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function loadSheet(petId: string, updatedAt: number): Promise<void> {
  const img = new Image();
  img.src = `/pets/${encodeURIComponent(petId)}/spritesheet?v=${updatedAt}`;
  await img.decode().catch(() => {});
  if (img.naturalWidth > 0) {
    sheet = img;
    // gaze 行在位（资产高 ≥ 12 行）才启用注视切换；旧资产静默退回原行
    hasGazeRow = img.naturalHeight >= GAZE_ROW * SPRITE_GRID.cellHeight + SPRITE_GRID.cellHeight;
    contentBoxOf('idle'); // 预热：偷窥对齐与命中区立刻有真值
  }
}

async function boot(): Promise<void> {
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  // 宠物选择：settings.pet.petId；资产列表里没有就回落第一只（都没有就空转）
  const [bundle, pets] = await Promise.all([
    fetchJson<{ settings?: { pet?: { petId?: string; notifications?: boolean; size?: string } } }>('/settings'),
    fetchJson<{ pets: Array<{ id: string; updatedAt: number }> }>('/pets'),
  ]);
  settingsNotifications = bundle?.settings?.pet?.notifications ?? true;
  const sizeRaw = bundle?.settings?.pet?.size;
  if (sizeRaw === 'small' || sizeRaw === 'medium' || sizeRaw === 'large') petSize = sizeRaw;
  const wanted = bundle?.settings?.pet?.petId ?? 'weave-spider';
  const pet = pets?.pets.find((p) => p.id === wanted) ?? pets?.pets[0];
  if (pet) await loadSheet(pet.id, pet.updatedAt);

  await refreshAll();
  applyAggregated(aggregate(sessions, dispatches, questions));

  let debounceTimer: number | null = null;
  const onEvent = (): void => {
    if (debounceTimer !== null) return;
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void refreshAll().then(() => applyAggregated(aggregate(sessions, dispatches, questions)));
    }, 500);
  };
  connectSse(onEvent);

  // 聚合兜底节拍：无事件时「刚完成→idle」「运行痕迹过期」也要走到；顺带重拉
  // ——问题清除不发帧（bus.ts：问题面只走 GET），最后一次 refreshAll 若在
  // 清除前落空，缓存的 questions 会把「等你回答」挂到下一条 hook 帧为止。
  window.setInterval(() => {
    void refreshAll().then(() => applyAggregated(aggregate(sessions, dispatches, questions)));
  }, 15_000);

  // WebView2 对非激活窗的定时器节流可达分钟级：SSE 帧与 15s 节拍都可能整段
  // 睡过去，短暂挂起的问题整个错过窗口（实测「桌宠不提示问答」）。窗口一被
  // 看到/拿到焦点立刻对账一次——前台时节流不生效，这一拍必准时。
  const reconcile = (): void => {
    void refreshAll().then(() => applyAggregated(aggregate(sessions, dispatches, questions)));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconcile();
  });
  window.addEventListener('focus', reconcile);

  startLoop();
}

void boot();
