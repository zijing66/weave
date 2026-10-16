import { api } from './api';
import { authState, recheckAuth, subscribeAuth } from './auth';

/**
 * 全站唯一的 /events 客户端。
 *
 * 原先有两处各自 `new EventSource`（本文件外的 App.tsx 与技能抽屉），且 App 那条
 * 的依赖数组含 `selected`——每次切项目/文件都断开重连。这里收敛成一条长连接：
 * 谁想听就 `subscribeSse`。连接在首次订阅时建立、活到页面关闭——SPA 生命周期内
 * 不关，免得 React 严格模式的挂载/卸载抖动造成反复重连。
 */

/** 一条 /events 帧。既有域：asset / project / hook；数据域：push / invalidate。 */
export interface SseFrame {
  type: string;
  [field: string]: unknown;
}

type FrameHandler = (frame: SseFrame) => void;

const handlers = new Set<FrameHandler>();
/**
 * key → 重拉函数集合：收到 `invalidate` 帧时**每个**注册者都调（`push` 帧由订阅者自己写状态）。
 * 一个 key 常有多方关心（`settings` 就有设置弹窗、会话面板的能力矩阵、右下角 AI 助手三处），
 * 单槽 Map 会让后注册者挤掉先来的——典型症状是「设置里填完 AI 配置，助手浮层要刷新页面才出现」。
 */
const invalidators = new Map<string, Set<() => void>>();
let source: EventSource | null = null;

function ensureSource(): EventSource | null {
  // 未登录不建连（连上也是 401）：登录成功后由认证态订阅者补连，或新订阅者触发。
  if (authState() !== 'authenticated') return null;
  if (source) return source;
  source = new EventSource(api.eventsUrl());
  source.onmessage = (ev) => {
    let frame: SseFrame;
    try {
      frame = JSON.parse(ev.data) as SseFrame;
    } catch {
      return; // 坏帧丢掉，不断流
    }
    // invalidate 帧：按 key 找注册过的重拉函数（push 帧没这个语义，直接广播）。
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
});

/** 订阅整条流；返回退订函数。 */
export function subscribeSse(handler: FrameHandler): () => void {
  ensureSource();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
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
