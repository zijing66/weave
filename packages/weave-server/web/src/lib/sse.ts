import { api } from './api';

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
/** key → 重拉函数：收到 `invalidate` 帧时被调用（`push` 帧由订阅者自己写状态）。 */
const invalidators = new Map<string, () => void>();
let source: EventSource | null = null;

function ensureSource(): EventSource {
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
    if (frame.type === 'invalidate') invalidators.get(String(frame.key))?.();
    for (const handler of handlers) handler(frame);
  };
  // EventSource 自带重连：出错不做事，交给浏览器退避重试。
  source.onerror = () => {};
  return source;
}

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
 * 的胶水。返回退订；同一 key 后注册者生效（组件重挂载时自然替换）。
 */
export function registerInvalidator(key: string, run: () => void): () => void {
  ensureSource();
  invalidators.set(key, run);
  return () => {
    if (invalidators.get(key) === run) invalidators.delete(key);
  };
}
