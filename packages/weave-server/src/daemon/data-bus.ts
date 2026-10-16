import { EventEmitter } from 'node:events';

/**
 * 数据变更帧总线（WatchService/HookEventBus 的 EventEmitter + subscribe 形态）。
 *
 * SSE /events 的**第三**订阅源，与资产变更（watch）、hook 分发（hookBus）并列。
 * 承载两类帧，靠 payload 有无区分：
 * - 带 payload = 后端已经算好，前端直接写状态（小/便宜的域，如终端角标）
 * - 不带 payload = 只给 key，前端收到后调既有 fetcher 重拉（重/嵌套的域）
 *
 * `key` 即数据域。订阅者计数用来回答「有没有人在看」：没有事件源的隐藏刷新器
 * （终端数量、会话存活）只在有人看时才值得去 spawn 探测。
 */

/** 前端可订阅的数据域。 */
export type DataKey =
  | 'projects'
  | 'settings'
  | 'statusline'
  | 'sessions'
  | 'terminalTopology'
  | 'sessionLiveness'
  | 'sessionInterrupt'
  | 'inflightCounts'
  | 'assets'
  | 'toolkit'
  | 'market'
  | 'libraries'
  | 'updates'
  | 'capture';

/** 一帧数据变更通知。 */
export interface DataFrame {
  key: DataKey;
  /** 后端算好的载荷；缺省 = 前端收到后按 key 重拉。 */
  payload?: unknown;
  /** 失效域限定的项目路径（assets/toolkit 等按项目划分的域）。 */
  projectPath?: string;
}

export class DataBus {
  private readonly emitter = new EventEmitter();
  private subscribers = 0;

  constructor() {
    // 订阅者少（每 SSE 连接一个），抬高防极端泄漏告警（与 hookBus 同口径）。
    this.emitter.setMaxListeners(100);
  }

  emit(frame: DataFrame): void {
    this.emitter.emit('change', frame);
  }

  /** 至少一个打开的 SSE 连接 —— 无事件源的探测以此为准。 */
  hasSubscribers(): boolean {
    return this.subscribers > 0;
  }

  /** 返回退订函数（与 WatchService.subscribe 一致）。 */
  subscribe(listener: (frame: DataFrame) => void): () => void {
    this.subscribers += 1;
    this.emitter.on('change', listener);
    return () => {
      this.subscribers -= 1;
      this.emitter.off('change', listener);
    };
  }
}
