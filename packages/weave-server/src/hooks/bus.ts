import { EventEmitter } from 'node:events';

/**
 * Hook 分发事件总线（WatchService 的 EventEmitter + subscribe 形态）。
 * 供 SSE /events 订阅推给 dashboard——与文件资产变更（watch）语义分离，
 * 各自独立 emitter，handleSse 双订阅。
 */
export type HookBusMessage =
  | { kind: 'rule.matched'; ruleId: string; eventId: number; sessionId: string | null; at: string }
  | {
      kind: 'dispatch.created';
      ruleId: string;
      dispatchId: number;
      status: string;
      mode: string;
      sessionId: string | null;
      at: string;
    }
  | { kind: 'dispatch.started'; ruleId: string; dispatchId: number; sessionId: string | null; at: string }
  | {
      kind: 'dispatch.finished';
      ruleId: string;
      dispatchId: number;
      status: 'succeeded' | 'failed' | 'timeout';
      sessionId: string | null;
      at: string;
    };

export class HookEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // 事件高频但订阅者少（每 SSE 连接一个），默认 10 足够；抬高防极端泄漏告警。
    this.emitter.setMaxListeners(100);
  }

  emit(message: HookBusMessage): void {
    this.emitter.emit('change', message);
  }

  /** 返回退订函数（与 WatchService.subscribe 一致）。 */
  subscribe(listener: (message: HookBusMessage) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }
}
