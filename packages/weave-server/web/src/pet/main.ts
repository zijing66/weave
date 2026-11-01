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

import { createSpritePlayer, SPRITE_GRID, type PetAnimation } from './sprite';

const API_BASE = '/api';

// ---------------------------------------------------------------------------
// 数据面：与任务面板同源的三个列表 + 聚合状态机
// ---------------------------------------------------------------------------

interface SessionRow {
  sessionId: string;
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

interface Aggregated {
  /** 聚合态 → 动画名。 */
  anim: PetAnimation;
  /** 气泡文案（null = 不显示）。 */
  bubble: string | null;
  /** 触发气泡的会话（通知 tag 与点击跳转用）。 */
  focusSessionId: string | null;
}

/** 会话短标签（与 hook-payload.ts sessionLabel 同法）。 */
function labelOf(s: SessionRow | undefined, sessionId: string): string {
  return s?.title ?? sessionId.slice(0, 8);
}

/**
 * 全局聚合：待答 > 失败 > 运行中 > 刚完成 > 空闲。
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

  // 待答（最高优先）
  if (questions.length > 0) {
    const q = questions[0]!;
    return {
      anim: 'waiting',
      bubble: `⏳ ${labelOf(byId.get(q.sessionId), q.sessionId)} 等你回答`,
      focusSessionId: q.sessionId,
    };
  }
  // 失败（最新一次失败的派发，30 分钟内才算新闻）
  const failed = [...failedLatest.entries()]
    .filter(([, at]) => now - Date.parse(at) < 30 * 60_000)
    .sort((a, b) => (a[1] < b[1] ? 1 : -1))[0];
  if (failed) {
    return {
      anim: 'failed',
      bubble: `✗ ${labelOf(byId.get(failed[0]), failed[0])} 任务失败`,
      focusSessionId: failed[0],
    };
  }
  // 运行中：任一会话 turnOpen / running dispatch / 近期活动 → 结网循环（织网=干活）
  for (const s of sessions) {
    const busy =
      runningDispatch.has(s.sessionId) ||
      s.turnOpen === true ||
      (s.pidAlive !== false &&
        s.lastEventType !== 'SessionEnd' &&
        s.interruptedAt == null &&
        now - Date.parse(s.lastSeenAt) < 30_000);
    if (busy) {
      return { anim: 'review', bubble: null, focusSessionId: null };
    }
  }
  // 刚完成：3 分钟内有过运行、现在没了 → 挥腿庆祝一小段（review 已让给运行中的结网循环）
  if (wasRunningRecently(now)) {
    return { anim: 'waving', bubble: '✓ 全部完成', focusSessionId: null };
  }
  return { anim: 'idle', bubble: null, focusSessionId: null };
}

/** 「刚完成」判据的运行痕迹：上一拍聚合成运行中（结网循环）的时刻。 */
let lastRunningAt = 0;
const JUST_FINISHED_MS = 3 * 60_000;

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

const bubbleEl = document.getElementById('bubble')!;
let bubbleTimer: number | null = null;

function showBubble(text: string): void {
  bubbleEl.textContent = text;
  bubbleEl.classList.add('show');
  if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => bubbleEl.classList.remove('show'), 6_000);
}

function notifySystem(title: string, body: string, tag: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag });
  } catch {
    // 构造失败不影响动画
  }
}

/** 点击气泡 → 聚焦对应会话（dashboard 主页带 focus 参数）。 */
bubbleEl.addEventListener('click', () => {
  const sid = currentFocusSessionId;
  if (!sid) return;
  window.open(`/?focus=${encodeURIComponent(sid)}`, 'weave-dashboard');
});
let currentFocusSessionId: string | null = null;

// ---------------------------------------------------------------------------
// 渲染循环
// ---------------------------------------------------------------------------

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// 贴边偷窥：窗贴屏幕边缘时滑出去只露一小条（头），鼠标移入滑回探出全身，
// 移走自动收回。目标位由页面算好发给宿主 moveto 执行（页面知道自己在哪块屏）；
// 拖拽期间不打架——DragMove 模态循环里发 moveto 会跟手抖。
// ---------------------------------------------------------------------------

/** 偷窥态露出的宽度（CSS px）：够一眼认出「那儿蹲着个东西」且可 hover。 */
const PEEK_PX = 36;
/** 贴边判定：窗缘距所在屏工作区缘 ≤ 此值算贴边。 */
const SNAP_TOLERANCE = 24;
/** 展开/收回过渡时长（毫秒）。 */
const PEEK_TRANSITION_MS = 220;

type PeekSide = 'left' | 'right' | 'bottom';

let peekSide: PeekSide | null = null; // 当前贴边侧（null = 自由位，不管窗）
let peekExpanded = false; // 鼠标在窗上 → 展开；移走/从未进来 → 收回头（初值 false：daemon 拉窗落贴边位就直接藏）
let dragging = false; // DragMove 模态循环进行中：暂停一切自动挪窗
let peekProgress = 1; // 1 = 常态位，0 = 全藏（只露 PEEK_PX）
let lastPostedPos: { x: number; y: number } | null = null;
let lastTs = 0;

/** 当前窗相对所在屏工作区的几何（CSS px；WebView2 里 screenX/Y 即屏幕坐标）。 */
function windowGeometry(): {
  wx: number; wy: number; ww: number; wh: number;
  availLeft: number; availTop: number; sw: number; sh: number;
} {
  const scr = window.screen;
  // 多屏：screenX 可能是负数（左侧副屏），availLeft/availTop 补工作区原点
  const availLeft = (scr as Screen & { availLeft?: number }).availLeft ?? 0;
  const availTop = (scr as Screen & { availTop?: number }).availTop ?? 0;
  return {
    wx: window.screenX,
    wy: window.screenY,
    ww: window.innerWidth,
    wh: window.innerHeight,
    availLeft,
    availTop,
    sw: scr.availWidth,
    sh: scr.availHeight,
  };
}

type Geo = ReturnType<typeof windowGeometry>;

/** 贴边侧：窗缘距工作区缘 ≤ 容差即贴边。已在偷窥态时放宽——滑出后窗缘距
 * 屏缘恰为 PEEK_PX，别把自家藏身位误判成「已离开贴边」导致卡在屏外。 */
function detectPeekSide(g: Geo): PeekSide | null {
  const tol = peekSide === null ? SNAP_TOLERANCE : SNAP_TOLERANCE + PEEK_PX + 8;
  if (g.wx - g.availLeft <= tol) return 'left';
  if (g.availLeft + g.sw - (g.wx + g.ww) <= tol) return 'right';
  if (g.availTop + g.sh - (g.wy + g.wh) <= tol) return 'bottom';
  return null;
}

/** 某贴边侧的两个锚点位：全藏（只露 PEEK_PX）与常态（贴边但完整可见）。 */
function peekAnchors(
  side: PeekSide,
  g: Geo,
): { hidden: { x: number; y: number }; rest: { x: number; y: number } } {
  if (side === 'left')
    return {
      hidden: { x: g.availLeft - (g.ww - PEEK_PX), y: g.wy },
      rest: { x: g.availLeft, y: g.wy },
    };
  if (side === 'right')
    return {
      hidden: { x: g.availLeft + g.sw - PEEK_PX, y: g.wy },
      rest: { x: g.availLeft + g.sw - g.ww, y: g.wy },
    };
  return {
    hidden: { x: g.wx, y: g.availTop + g.sh - PEEK_PX },
    rest: { x: g.wx, y: g.availTop + g.sh - g.wh },
  };
}

/** 每帧推进：贴边检测、进度缓动、过渡期逐帧 moveto（宿主哑执行）。 */
function updatePeek(now: number): void {
  if (dragging) {
    lastTs = now; // DragMove 模态循环里宿主正被用户拖着走，我们不发 moveto
    return;
  }
  const dt = lastTs === 0 ? 16 : now - lastTs;
  lastTs = now;
  const g = windowGeometry();
  const side = dragging ? peekSide : detectPeekSide(g);
  if (side !== peekSide) {
    peekSide = side;
    if (side === null) {
      lastPostedPos = null; // 回到自由位：不再管窗位
      return;
    }
    // 进入贴边不强制展开——peekExpanded 只由 mouseenter/mouseleave/drag-end 驱动，
    // 否则 daemon 拉窗落贴边位后没人碰鼠标就永远展开、偷窥形同虚设
    lastPostedPos = null;
    lastTs = now;
    return;
  }
  if (peekSide === null) return;

  // 目标进度：展开（或拖拽中）→ 常态位；收起 → 全藏。reducedMotion 直接跳到位。
  const goal = peekExpanded ? 1 : 0;
  if (reducedMotion) {
    if (peekProgress !== goal) {
      peekProgress = goal;
      lastPostedPos = null;
    }
  } else {
    // 线性逼近：每帧走剩余距离的一定比例，dt 归一
    const step = (goal - peekProgress) * Math.min(1, dt / PEEK_TRANSITION_MS);
    peekProgress += step;
    if (Math.abs(goal - peekProgress) < 0.01) peekProgress = goal;
  }

  // 进度 → 窗位：hidden/rest 两锚点间插值，变了才发（宿主哑执行，别刷屏）
  const anchors = peekAnchors(peekSide, g);
  const nx = Math.round(anchors.hidden.x + (anchors.rest.x - anchors.hidden.x) * peekProgress);
  const ny = Math.round(anchors.hidden.y + (anchors.rest.y - anchors.hidden.y) * peekProgress);
  if (!lastPostedPos || lastPostedPos.x !== nx || lastPostedPos.y !== ny) {
    lastPostedPos = { x: nx, y: ny };
    postToHost(`moveto:${nx},${ny}`);
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

/** 偷窥全藏位的绘制区：窗滑出去后画布只剩靠屏一条可见，身子必须画进那条里——
 * 贴下缘露头顶、贴左右缘露半身，头/身中心对准窄条中线（系数按眼校准）。 */
function peekPetRect(side: PeekSide): { x: number; y: number; w: number; h: number } {
  const w = canvas.width;
  const h = canvas.height;
  const scale = Math.min(w / SPRITE_GRID.cellWidth, (h * 0.82) / SPRITE_GRID.cellHeight);
  const pw = SPRITE_GRID.cellWidth * scale;
  const ph = SPRITE_GRID.cellHeight * scale;
  const peekPx = PEEK_PX * (window.devicePixelRatio || 1);
  if (side === 'bottom') return { x: (w - pw) / 2, y: peekPx * 0.5 - ph * 0.12, w: pw, h: ph };
  if (side === 'right') return { x: peekPx * 0.5 - pw / 2, y: h - ph, w: pw, h: ph };
  return { x: w - peekPx * 0.5 - pw / 2, y: h - ph, w: pw, h: ph };
}

/** 当前帧绘制区：常态位与偷窥位按 peekProgress 插值（progress=1 恒等于常态）。 */
function currentPetRect(): { x: number; y: number; w: number; h: number } {
  const n = normalPetRect();
  if (peekSide === null || peekProgress >= 1) return n;
  const p = peekPetRect(peekSide);
  return {
    x: n.x + (p.x - n.x) * peekProgress,
    y: n.y + (p.y - n.y) * peekProgress,
    w: n.w,
    h: n.h,
  };
}

let sheet: HTMLImageElement | null = null;
const player = createSpritePlayer('idle');

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
        ctx.drawImage(sheet, 0, PET_ANIM_ROW_ZERO, SPRITE_GRID.cellWidth, SPRITE_GRID.cellHeight, r.x, r.y, r.w, r.h);
      }
      window.setTimeout(tick, 250);
    };
    window.setTimeout(tick, 250);
    return;
  }
  const render = (now: number): void => {
    updatePeek(now);
    if (sheet) {
      const frame = player.tick(now);
      const spec = PET_ANIMS[player.current()];
      const r = currentPetRect();
      // 视线跟随：整只朝鼠标方向轻移（视差），Q 版「盯着你看」的效果——
      // 精灵是预渲染的，瞳孔动不了，整体微移是同款观感的最廉价实现
      const lean = leanOffset();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        sheet,
        Math.min(frame, SPRITE_GRID.columns - 1) * SPRITE_GRID.cellWidth,
        spec.row * SPRITE_GRID.cellHeight,
        SPRITE_GRID.cellWidth,
        SPRITE_GRID.cellHeight,
        r.x + lean.x,
        r.y + lean.y,
        r.w,
        r.h,
      );
    }
    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);
}

// ---------------------------------------------------------------------------
// 视线跟随（lean）：鼠标在窗内的位置 → 宠物朝那边轻移几像素
// ---------------------------------------------------------------------------

/** 最大偏移（设备像素）：够看出「在看」又不破坏站姿。 */
const LEAN_MAX = 3;

let mouseX = 0.5; // 窗内归一位置（0..1；0.5 = 居中）
let mouseY = 0.5;
let leanX = 0; // 平滑后的当前偏移
let leanY = 0;

window.addEventListener('mousemove', (e) => {
  mouseX = e.clientX / Math.max(1, window.innerWidth);
  mouseY = e.clientY / Math.max(1, window.innerHeight);
});

/** 目标偏移 = 鼠标偏离中心的归一向量 × LEAN_MAX；逐帧向目标收敛。 */
function leanOffset(): { x: number; y: number } {
  const tx = (mouseX - 0.5) * 2 * LEAN_MAX;
  const ty = (mouseY - 0.5) * 2 * LEAN_MAX;
  leanX += (tx - leanX) * 0.12;
  leanY += (ty - leanY) * 0.12;
  return { x: Math.round(leanX * (window.devicePixelRatio || 1)), y: Math.round(leanY * (window.devicePixelRatio || 1)) };
}

// sprite.ts 的表在这里只读行号——直接引常量对象
import { PET_ANIMATIONS as PET_ANIMS } from './sprite';
const PET_ANIM_ROW_ZERO = PET_ANIMS.idle.row * SPRITE_GRID.cellHeight;

// ---------------------------------------------------------------------------
// 状态变迁 → 动画 + 气泡 + 系统通知
// ---------------------------------------------------------------------------

let lastAnim: PetAnimation | null = null;

function applyAggregated(next: Aggregated): void {
  currentFocusSessionId = next.focusSessionId;
  if (next.anim === 'review') lastRunningAt = Date.now(); // review 行 = 运行中的结网循环
  // 运行中（结网）无限循环值守；其余动画主循环 ×3 后自然回落 idle
  player.play(next.anim, { loopForever: next.anim === 'review' });
  if (next.bubble && next.anim !== lastAnim) {
    showBubble(next.bubble);
    if (next.focusSessionId && settingsNotifications) {
      const title = next.anim === 'waiting' ? 'Weave 待答' : next.anim === 'failed' ? 'Weave 失败' : 'Weave';
      notifySystem(title, next.bubble.replace(/^[⏳✗]\s*/, ''), `weave-pet-${next.focusSessionId}`);
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
  // 偷窥态下窗大半在屏外——记档存「贴边常态位」（rest 锚点），绝不把藏起来的位存成记忆位
  const g = windowGeometry();
  const pos =
    peekSide !== null && peekProgress < 1
      ? peekAnchors(peekSide, g).rest
      : { x: g.wx, y: g.wy };
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
  savePos();
});
window.addEventListener('blur', savePos);
// 宿主 DragMove 模态循环结束的回执（期间 mouseup 收不到）——收到即记位，
// 并解除拖拽标志（updatePeek 恢复接管；若拖到了屏缘，下一拍自动进偷窥态）。
(hostWebview()?.addEventListener('message', () => {
  dragging = false;
  peekExpanded = true; // 松手瞬间鼠标还在窗上，先展开，移走再收
  savePos();
}));
/** 宿主通道对象（普通浏览器里没有 chrome.webview，返回 null）。 */
function hostWebview(): { postMessage(m: string): void; addEventListener(t: string, l: () => void): void } | null {
  return (window as unknown as { chrome?: { webview?: { postMessage(m: string): void; addEventListener(t: string, l: () => void): void } } })
    .chrome?.webview ?? null;
}

// 拖拽移动：按下即交宿主 DragMove 接管（模态循环，松手才返回）——页面只管
// 发令与事后记位，不自己做 pointermove 追踪（透明窗里命中测试交给宿主最简）。
// 右键不触发（留给菜单）；宿主侧没有 chrome.webview（普通浏览器调试）时静默。
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || menuEl) return;
  dragging = true; // DragMove 模态循环里 updatePeek 暂停挪窗，别跟手打架
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
  const items: Array<[string, () => void]> = [
    ['打开 Dashboard', () => window.open('/', 'weave-dashboard')],
    ['暂停/继续动画', () => togglePause()],
    [`大小：${SIZE_ZH[SIZE_ORDER[nextSizeIdx()]!]}`, () => cycleSize()],
    ['关闭宠物', () => closePet()],
  ];
  for (const [label, fn] of items) {
    const item = document.createElement('div');
    item.textContent = label;
    item.style.cssText = 'padding:6px 10px;border-radius:5px;cursor:pointer';
    item.onmouseenter = () => (item.style.background = '#333');
    item.onmouseleave = () => (item.style.background = 'transparent');
    item.onclick = () => {
      closeMenu();
      fn();
    };
    menuEl.appendChild(item);
  }
  document.body.appendChild(menuEl);
});
document.addEventListener('click', closeMenu);

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

function nextSizeIdx(): number {
  return (SIZE_ORDER.indexOf(petSize) + 1) % SIZE_ORDER.length;
}

function cycleSize(): void {
  petSize = SIZE_ORDER[nextSizeIdx()]!;
  const { w, h } = SIZE_PX[petSize];
  postToHost(`resize:${w}x${h}`);
  void fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pet: { size: petSize } }),
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
  if (img.naturalWidth > 0) sheet = img;
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
    if (paused || debounceTimer !== null) return;
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void refreshAll().then(() => applyAggregated(aggregate(sessions, dispatches, questions)));
    }, 500);
  };
  connectSse(onEvent);

  // 聚合兜底节拍：无事件时「刚完成→idle」「运行痕迹过期」也要走到
  window.setInterval(() => {
    if (paused) return;
    applyAggregated(aggregate(sessions, dispatches, questions));
  }, 15_000);

  startLoop();
}

void boot();
