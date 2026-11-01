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
  // 运行中：任一会话 turnOpen / running dispatch / 近期活动
  for (const s of sessions) {
    const busy =
      runningDispatch.has(s.sessionId) ||
      s.turnOpen === true ||
      (s.pidAlive !== false &&
        s.lastEventType !== 'SessionEnd' &&
        s.interruptedAt == null &&
        now - Date.parse(s.lastSeenAt) < 30_000);
    if (busy) {
      return { anim: 'running', bubble: null, focusSessionId: null };
    }
  }
  // 刚完成：3 分钟内有过运行、现在没了 → review 短暂
  if (wasRunningRecently(now)) {
    return { anim: 'review', bubble: '✓ 全部完成', focusSessionId: null };
  }
  return { anim: 'idle', bubble: null, focusSessionId: null };
}

/** 「刚完成」判据的运行痕迹：上一拍聚合成 running 的时刻。 */
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

function fitCanvas(): void {
  // 宠物窗尺寸由宿主给定（200×240）；画布按 devicePixelRatio 出清晰像素
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.imageSmoothingEnabled = false; // 像素风精灵禁平滑
}

/** 宠物在画布里的绘制区：底部居中、单元比例适配（气泡留顶部空间）。 */
function petRect(): { x: number; y: number; w: number; h: number } {
  const w = canvas.width;
  const h = canvas.height;
  const scale = Math.min(w / SPRITE_GRID.cellWidth, (h * 0.82) / SPRITE_GRID.cellHeight);
  const pw = SPRITE_GRID.cellWidth * scale;
  const ph = SPRITE_GRID.cellHeight * scale;
  return { x: (w - pw) / 2, y: h - ph, w: pw, h: ph };
}

let sheet: HTMLImageElement | null = null;
const player = createSpritePlayer('idle');

function startLoop(): void {
  if (reducedMotion) {
    // 静止首帧：不启 rAF（契约时长表不走了）
    if (sheet) {
      const r = petRect();
      ctx.drawImage(sheet, 0, PET_ANIM_ROW_ZERO, SPRITE_GRID.cellWidth, SPRITE_GRID.cellHeight, r.x, r.y, r.w, r.h);
    }
    return;
  }
  const render = (now: number): void => {
    if (sheet) {
      const frame = player.tick(now);
      const spec = PET_ANIMS[player.current()];
      const r = petRect();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        sheet,
        Math.min(frame, SPRITE_GRID.columns - 1) * SPRITE_GRID.cellWidth,
        spec.row * SPRITE_GRID.cellHeight,
        SPRITE_GRID.cellWidth,
        SPRITE_GRID.cellHeight,
        r.x,
        r.y,
        r.w,
        r.h,
      );
    }
    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);
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
  if (next.anim === 'running') lastRunningAt = Date.now();
  player.play(next.anim);
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
  try {
    // WebView2 里 window.screenX/Y 即屏幕坐标（DIP）；宿主 DragMove 结束后读
    localStorage.setItem(POS_KEY, JSON.stringify({ x: window.screenX, y: window.screenY }));
  } catch {
    // 存不进就算了（下次开在默认位）
  }
}
window.addEventListener('mouseup', savePos);
window.addEventListener('blur', savePos);

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
    ['关闭宠物', () => postToHost('close')],
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

let paused = false;

function togglePause(): void {
  paused = !paused;
}

/** 宿主通道（WebView2 postMessage；普通浏览器里没有 chrome.webview，静默跳过）。 */
function postToHost(msg: string): void {
  const wv = (window as unknown as { chrome?: { webview?: { postMessage(m: string): void } } })
    .chrome?.webview;
  wv?.postMessage(msg);
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
    fetchJson<{ settings?: { pet?: { petId?: string; notifications?: boolean } } }>('/settings'),
    fetchJson<{ pets: Array<{ id: string; updatedAt: number }> }>('/pets'),
  ]);
  settingsNotifications = bundle?.settings?.pet?.notifications ?? true;
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
