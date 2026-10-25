import { api } from './api';
import { authState, recheckAuth, subscribeAuth } from './auth';

/**
 * 全站唯一的 /events 客户端 + 发布订阅总线。
 *
 * 原先有两处各自 `new EventSource`（本文件外的 App.tsx 与技能抽屉），且 App 那条
 * 的依赖数组含 `selected`——每次切项目/文件都断线重连。这里收敛成一条长连接：
 * 连接在首次订阅时建立、活到页面关闭——SPA 生命周期内不关，免得 React 严格模式
 * 的挂载/卸载抖动造成反复重连。分发按帧域拆面：按类型（`subscribeFrame`）、push
 * 按 key（`subscribePush`）、hook 按 kind（`subscribeHook`）、invalidate 按 key
 * （`registerInvalidator`）——组件不再各自过滤整条裸流，也不再经 window 事件
 * 二次转发。
 *
 * 断流补发：服务端给每帧编号（`id:`），这里记住最后收到的那个，重建连接时带
 * `?since=` 回去补齐断流期间漏掉的帧。补不齐时服务端先发 `resync`——那说明漏了
 * 一些再也拿不回来的东西，整页重来是最省事的正确解。
 */

/** 一条 /events 帧。既有域：asset / project / hook；数据域：push / invalidate；
 *  流控：ping（心跳）/ resync（漏帧补不齐，整页重来）。 */
export interface SseFrame {
  type: string;
  [field: string]: unknown;
}

/** hook 域帧（mirror server hookBus 的 HookBusMessage，字段按 kind 可选）。 */
export interface HookFrame {
  kind?: string;
  sessionId?: string | null;
  eventType?: string;
  /** 事件源子 agent id（raw.agent_id；SubagentStop 时 = 刚结束的子 agent）。 */
  agentId?: string;
  /** 后台子 agent 出生信号（PostToolUse Agent isAsync 的 tool_response.agentId）。 */
  spawnAgentId?: string;
  /** Stop/SubagentStop 携带的后台任务快照——存活集权威对账源。 */
  backgroundTasks?: Array<{ id: string; status: string }>;
  /** raw.source（SessionStart 的 startup/resume/compact/clear——压缩收尾笔靠它认）。 */
  rawSource?: string;
  ruleId?: string;
  eventId?: number;
  dispatchId?: number;
  status?: string;
  /** watch.fired 帧（空闲订阅 one-shot 落定）：目标/订阅方 id——dashboard 订阅
   *  （watcherSessionId null）由此弹 toast，任务面板据此重拉订阅列表。 */
  watchId?: number;
  targetSessionId?: string;
  watcherSessionId?: string | null;
  /** question.pending 帧（新挂起待答）：只作提醒，问题面另由会话状态总线拉。 */
  count?: number;
  /** watch.fired 帧的命中类型（idle / turnEnd / messageFailed——提醒正文按它措辞）。 */
  reason?: string;
  // ---- 编排域帧（orchestration.run / orchestration.delivery）：两条都带全量
  // 轻量态（投递数 + 每会话待回计数），画布就地更新、不重拉。 ----
  orchestrationId?: number;
  runId?: number;
  /** 边 id（起点投递为空串）：画布按它点亮那一条边。 */
  edgeId?: string;
  from?: string;
  to?: string;
  ok?: boolean;
  error?: string;
  deliveries?: number;
  pendingCounts?: Record<string, number>;
  trigger?: 'manual' | 'webhook' | 'cron';
  /** 两条编排帧都带的时刻（终态落定时刻也用它）。 */
  at?: string;
}

type FrameHandler = (frame: SseFrame) => void;

/** 裸流订阅（测试与真要整条流的地方才用；组件应走按域拆面的订阅口）。 */
const handlers = new Set<FrameHandler>();
/** 帧类型 → 订阅者（`subscribeFrame`）。 */
const byType = new Map<string, Set<FrameHandler>>();
/** push key → 订阅者（`subscribePush`，payload 后端已算好）。 */
const pushSubs = new Map<string, Set<(payload: unknown) => void>>();
/** hook 帧全量订阅者（`subscribeHook` 不带 kinds）。 */
const hookAll = new Set<(frame: HookFrame) => void>();
/** kind（精确或 `前缀.`）→ 订阅者（`subscribeHook` 带 kinds）。 */
const hookByKind = new Map<string, Set<(frame: HookFrame) => void>>();
/**
 * key → 重拉函数集合：收到 `invalidate` 帧时**每个**注册者都调（`push` 帧由订阅者自己写状态）。
 * 一个 key 常有多方关心（`settings` 就有设置弹窗、会话面板的能力矩阵、右下角 AI 助手三处），
 * 单槽 Map 会让后注册者挤掉先来的——典型症状是「设置里填完 AI 配置，助手浮层要刷新页面才出现」。
 */
const invalidators = new Map<string, Set<() => void>>();
let source: EventSource | null = null;
/** 最后收到的帧 id（服务端 `id:` 行）：重建连接时带回去换回漏掉的那些帧。
 *  我们重建的是**新** EventSource 对象，浏览器不会替它带上 `Last-Event-ID`。 */
let lastEventId: string | null = null;
/** 上次收到帧（含心跳）的时刻：判死只看「对方还说没说话」。 */
let lastFrameAt = Date.now();
/** 判死阈值 = 服务端心跳周期（`SSE_HEARTBEAT_MS`）的两拍半；巡检本身不拉数据。
 *  中间层静默掐断空闲流时 EventSource **既不报错也不重连**（实测：daemon 重启后
 *  面板停在旧帧上，直到刷新页面才对），所以只能靠心跳缺席自己发现。 */
const STREAM_SILENT_MS = 65_000;
const WATCHDOG_MS = 15_000;
let watchdog: ReturnType<typeof setInterval> | null = null;

/** `reload()` 的防抖闸：补不齐的病根在别处，反复刷新只会把页面刷成幻灯片。 */
const RESYNC_AT_KEY = 'weave:sse-resync';
const RESYNC_LOOP_MS = 10_000;

function reloadForResync(): void {
  const last = Number(sessionStorage.getItem(RESYNC_AT_KEY) ?? 0);
  if (Date.now() - last < RESYNC_LOOP_MS) return;
  sessionStorage.setItem(RESYNC_AT_KEY, String(Date.now()));
  location.reload();
}

function ensureSource(): EventSource | null {
  // 未登录不建连（连上也是 401）：登录成功后由认证态订阅者补连，或新订阅者触发。
  if (authState() !== 'authenticated') return null;
  if (source) return source;
  source = new EventSource(api.eventsUrl(lastEventId));
  lastFrameAt = Date.now();
  source.onopen = () => {
    lastFrameAt = Date.now();
  };
  source.onmessage = (ev) => {
    lastFrameAt = Date.now();
    // 心跳不带 id：它不是数据帧，挪 offset 只会让补发窗口无谓地变窄。
    if (ev.lastEventId) lastEventId = ev.lastEventId;
    let frame: SseFrame;
    try {
      frame = JSON.parse(ev.data) as SseFrame;
    } catch {
      return; // 坏帧丢掉，不断流
    }
    // 补不齐：这条流已经不可信了，整页重来（不往下分发——重载后什么都不缺）。
    if (frame.type === 'resync') {
      reloadForResync();
      return;
    }
    // 按帧域分发到各订阅面（同一面的订阅者互不挤占；裸流订阅者最后整帧广播）。
    for (const handler of byType.get(frame.type) ?? []) handler(frame);
    if (frame.type === 'push') {
      for (const run of pushSubs.get(String(frame.key)) ?? []) run(frame.payload);
    }
    if (frame.type === 'hook' && typeof frame.kind === 'string') {
      const hook = frame as HookFrame;
      for (const run of hookAll) run(hook);
      for (const [kind, set] of hookByKind) {
        if (kind === frame.kind || (kind.endsWith('.') && frame.kind.startsWith(kind))) {
          for (const run of set) run(hook);
        }
      }
    }
    if (frame.type === 'invalidate') {
      for (const run of invalidators.get(String(frame.key)) ?? []) run();
    }
    for (const handler of handlers) handler(frame);
  };
  // EventSource 自带重连，但错误也可能是被 401 顶掉：复核认证态，未登录即整条
  // 流关掉（停止无意义重试），登录后自动补连（见下方认证态订阅）。
  source.onerror = () => {
    recheckAuth();
  };
  // 断流监护：安静过阈值就重建（关掉旧对象浏览器才会停止对它的静默重试）。
  // 页面整个生命周期只有这一个定时器，且只判活、不取数。
  if (watchdog === null) {
    watchdog = setInterval(() => {
      if (!source || Date.now() - lastFrameAt < STREAM_SILENT_MS) return;
      closeSource();
      ensureSource();
    }, WATCHDOG_MS);
  }
  return source;
}

/** 断开并置空（认证态切到未登录时调用；下次登录后 ensureSource 重建）。 */
function closeSource(): void {
  source?.close();
  source = null;
}

// 认证态驱动连接：登录 → 补连（既有订阅者已在表里，不会漏帧）；登出/被拒 → 断开。
subscribeAuth(() => {
  if (authState() === 'authenticated') {
    ensureSource();
    return;
  }
  closeSource();
  lastEventId = null; // 换了身份就别拿旧 offset 去要补发
});

/** 订阅整条裸流；返回退订函数（组件优先走下面按域拆面的订阅口）。 */
export function subscribeSse(handler: FrameHandler): () => void {
  ensureSource();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** 按帧类型订阅（`'asset'` / `'project'` / …），handler 只收该类型的帧。
 *  `T` 是消费方对该域帧的视图（如 AssetChangeEvent）——信封的 `type` 已被分发
 *  掉，类型匹配由订阅点保证，这里不做运行时校验。 */
export function subscribeFrame<T = SseFrame>(
  type: string,
  handler: (frame: T) => void,
): () => void {
  ensureSource();
  const set = byType.get(type) ?? new Set<FrameHandler>();
  byType.set(type, set);
  set.add(handler as FrameHandler);
  return () => {
    set.delete(handler as FrameHandler);
    if (set.size === 0) byType.delete(type);
  };
}

/** push 帧按 key 订阅：payload 后端已算好，直接写状态（绝对值快照）。 */
export function subscribePush<T = unknown>(key: string, handler: (payload: T) => void): () => void {
  ensureSource();
  const set = pushSubs.get(key) ?? new Set<(payload: unknown) => void>();
  pushSubs.set(key, set);
  set.add(handler as (payload: unknown) => void);
  return () => {
    set.delete(handler as (payload: unknown) => void);
    if (set.size === 0) pushSubs.delete(key);
  };
}

/**
 * hook 域订阅：缺省收全部 hook 帧；传 `kinds` 只收匹配项——条目是精确 kind
 * （`'watch.fired'`）或前缀（`'message.'` = `message.*` 全家）。
 */
export function subscribeHook(
  handler: (frame: HookFrame) => void,
  kinds?: readonly string[],
): () => void {
  ensureSource();
  if (!kinds) {
    hookAll.add(handler);
    return () => {
      hookAll.delete(handler);
    };
  }
  for (const kind of kinds) {
    const set = hookByKind.get(kind) ?? new Set<(frame: HookFrame) => void>();
    hookByKind.set(kind, set);
    set.add(handler);
  }
  return () => {
    for (const kind of kinds) {
      const set = hookByKind.get(kind);
      if (!set) continue;
      set.delete(handler);
      if (set.size === 0) hookByKind.delete(kind);
    }
  };
}

/**
 * 注册某个数据域的「重拉」函数：服务端写操作成功后推 `{type:'invalidate', key}`
 * 帧，这里就把它接到组件既有的 fetcher 上——组件不必再写「成功后手动 refresh」
 * 的胶水。同一 key 的每个注册者都会被调到（互不挤占），返回退订只摘自己那一个。
 */
export function registerInvalidator(key: string, run: () => void): () => void {
  ensureSource();
  const set = invalidators.get(key) ?? new Set<() => void>();
  invalidators.set(key, set);
  set.add(run);
  return () => {
    set.delete(run);
    if (set.size === 0) invalidators.delete(key);
  };
}
