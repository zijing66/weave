import { EventEmitter } from 'node:events';

/**
 * Hook 分发事件总线（WatchService 的 EventEmitter + subscribe 形态）。
 * 供 SSE /events 订阅推给 dashboard——与文件资产变更（watch）语义分离，
 * 各自独立 emitter，handleSse 双订阅。
 */
export type HookBusMessage =
  | {
      kind: 'event.ingested';
      eventId: number;
      projectId: number;
      sessionId: string | null;
      eventType: string;
      /** 事件源子 agent（raw.agent_id；SubagentStop 时 = 刚结束的那个子 agent）。 */
      agentId?: string;
      /** 出生信号：PostToolUse(Agent, isAsync) 的 tool_response.agentId（后台子 agent）。 */
      spawnAgentId?: string;
      /** Stop/SubagentStop 携带的后台任务快照（status 全为 running）——存活集权威对账源。 */
      backgroundTasks?: Array<{ id: string; status: string }>;
      at: string;
    }
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
    }
  | {
      kind: 'plugin.reloaded';
      pluginId: string;
      status: 'active' | 'rejected' | 'disabled';
      ruleCount: number;
      /** true = 插件目录被移除/不再发现，规则已级联删除。 */
      removed?: boolean;
      at: string;
    }
  | { kind: 'plugin.toggled'; pluginId: string; enabled: boolean; at: string }
  /** 更名生效确认：reported title 落库（pending 清除）后广播，dashboard 据此
   *  把「改名待生效」徽标切换为已生效的新名字。 */
  | { kind: 'session.renamed'; sessionId: string; title: string; at: string }
  // ---- 消息域（消息域重塑：纯管道）：与 dispatch.* 分域，幂等键 = messageId（管道发号）----
  | { kind: 'message.created'; messageId: string; sessionId: string; mode: string; at: string }
  | { kind: 'message.delivered'; messageId: string; sessionId: string; at: string }
  /** 投递回执：目标会话自己的 UserPromptSubmit 与在途条目匹配上了（真到达）。 */
  | { kind: 'message.acknowledged'; messageId: string; sessionId: string; at: string }
  /** 队列暂停闸置位：未回执超窗（unacked）或投递失败（failed）——该会话后续队列
   *  暂停冲洗，手动重发或回执解除；成因消息带 stalled 标记常驻在途视图。 */
  | {
      kind: 'message.stalled';
      messageId: string;
      sessionId: string;
      reason: 'unacked' | 'failed';
      at: string;
    }
  | {
      kind: 'message.finished';
      messageId: string;
      sessionId: string;
      status: 'succeeded' | 'failed' | 'timeout';
      at: string;
    }
  // ---- 会话订阅域（session-orchestration 批 2 + 提醒类型）：one-shot fire 广播 ----
  // watcher null = dashboard 订阅（web toast + 浏览器通知）；有值 = 会话订阅
  // （通知已走消息域注入，该会话的线程会另收 message.* 帧）。reason = 命中的
  // 触发类型（web 据此措辞通知正文）。
  | {
      kind: 'watch.fired';
      watchId: number;
      targetSessionId: string;
      watcherSessionId: string | null;
      reason: 'idle' | 'turnEnd' | 'messageFailed';
      at: string;
    }
  // ---- 阻塞问答域：会话新挂起一个待答（无 → 有）广播 ----
  // 只作提醒（web toast + 浏览器通知，不自动弹作答框——作答入口恒为手动点会话行
  // 提问图标）；问题面本身不走帧，仍由 GET /messaging/questions 拉。
  | {
      kind: 'question.pending';
      sessionId: string;
      harness: string;
      count: number;
      at: string;
    }
  // ---- 序列域（session-orchestration 批 3）：步触发/终态广播（编排画布实时） ----
  | { kind: 'sequence.step'; sequenceId: number; cursor: number; at: string }
  | {
      kind: 'sequence.finished';
      sequenceId: number;
      status: 'done' | 'failed' | 'cancelled';
      error: string | null;
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
