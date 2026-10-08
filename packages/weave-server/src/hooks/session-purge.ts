import type { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { SessionRepository } from '../repositories/sessions.js';

export interface SessionPurgeDeps {
  sessions: SessionRepository;
  events: HookEventRepository;
  dispatches?: Pick<HookDispatchRepository, 'deleteBySession'>;
}

/**
 * 删会话的数据清理：会话行 + 该会话的采集事件 + 指令池派发一起清。手动删除
 * （`DELETE /sessions/:id`）与空会话自动清理走同一条路径——两处清理口径不分家。
 */
export function purgeSession(
  deps: SessionPurgeDeps,
  sessionId: string,
): { events: number; dispatches: number } {
  const events = deps.events.deleteBySession(sessionId);
  const dispatches = deps.dispatches?.deleteBySession(sessionId) ?? 0;
  deps.sessions.remove(sessionId);
  return { events, dispatches };
}
