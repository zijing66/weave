import type { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { SessionSequenceRepository } from '../repositories/session-sequences.js';
import type { SessionWatchRepository } from '../repositories/session-watches.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { MessageDeliverer } from './message-deliverer.js';
import type { QuestionTracker } from './question-tracker.js';

export interface SessionPurgeDeps {
  sessions: SessionRepository;
  events: HookEventRepository;
  dispatches?: Pick<HookDispatchRepository, 'deleteBySession'>;
  /** 消息域（消息域重塑）：内存态 + promptbox 队列行级联清（计数口径同旧 DB）。 */
  deliverer?: Pick<MessageDeliverer, 'forgetSession'>;
  /** 空闲订阅（批 2）：目标或订阅方任一指向该会话的行一并清（不计数）。 */
  watches?: Pick<SessionWatchRepository, 'deleteBySession'>;
  /** 跨会话序列（批 3）：任一步目标指向该会话的行一并清（不计数）。 */
  sequences?: Pick<SessionSequenceRepository, 'deleteMentioning'>;
  /** 阻塞问答：待答内存态一并清（不计数）。 */
  questions?: Pick<QuestionTracker, 'forgetSession'>;
  /** 转录探测：内存里的 transcriptPath 一并清（不计数）。 */
  probe?: { forget(sessionId: string): void };
}

/**
 * 删会话的数据清理：会话行 + 该会话的采集事件 + 指令池派发 + 消息管道在途一并清。
 * 手动删除（`DELETE /sessions/:id`）与空会话自动清理走同一条路径——两处清理口径不分家。
 */
export function purgeSession(
  deps: SessionPurgeDeps,
  sessionId: string,
): { events: number; dispatches: number; messages: number } {
  const events = deps.events.deleteBySession(sessionId);
  const dispatches = deps.dispatches?.deleteBySession(sessionId) ?? 0;
  const messages = deps.deliverer?.forgetSession(sessionId) ?? 0;
  deps.watches?.deleteBySession(sessionId);
  deps.sequences?.deleteMentioning(new Set([sessionId]));
  deps.questions?.forgetSession(sessionId);
  deps.probe?.forget(sessionId);
  deps.sessions.remove(sessionId);
  return { events, dispatches, messages };
}
