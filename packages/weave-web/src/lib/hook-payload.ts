import type { HookEventRow } from './api';

/** Hook 事件 payload 的可选字段（服务端 NormalizedHookPayload 容忍缺失）。 */
export interface EventDetail {
  toolName: string | null;
  toolInput: unknown;
  toolResponse: unknown;
  cwd: string | null;
  transcriptPath: string | null;
}

/** 解析 payload JSON；坏 JSON 返回全 null（不抛）。 */
export function parseDetail(payload: string): EventDetail {
  try {
    const parsed = JSON.parse(payload) as Partial<EventDetail>;
    return {
      toolName: typeof parsed.toolName === 'string' ? parsed.toolName : null,
      toolInput: parsed.toolInput ?? null,
      toolResponse: parsed.toolResponse ?? null,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
      transcriptPath:
        typeof parsed.transcriptPath === 'string' ? parsed.transcriptPath : null,
    };
  } catch {
    return { toolName: null, toolInput: null, toolResponse: null, cwd: null, transcriptPath: null };
  }
}

/** 事件类型 → Badge 配色（任务视图事件链节点/日志共用）。 */
export const EVENT_TYPE_STYLES: Record<string, string> = {
  PreToolUse: 'bg-blue-900/40 text-blue-300',
  PostToolUse: 'bg-emerald-900/40 text-emerald-300',
  UserPromptSubmit: 'bg-cyan-900/40 text-cyan-300',
  SessionStart: 'bg-purple-900/40 text-purple-300',
  SessionEnd: 'bg-pink-900/40 text-pink-300',
  Notification: 'bg-amber-900/40 text-amber-300',
  Stop: 'bg-orange-900/40 text-orange-300',
  SubagentStop: 'bg-orange-900/40 text-orange-300',
};

/** 采集来源 → Badge 配色。 */
export const SOURCE_STYLES: Record<string, string> = {
  claude: 'bg-orange-900/40 text-orange-300',
  codex: 'bg-cyan-900/40 text-cyan-300',
};

/** ISO → 本地时分（日志/节点用）。 */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

/** 会话短标签（title 回退 sessionId 前 8 位）。 */
export function sessionLabel(title: string | null, sessionId: string): string {
  return title ?? sessionId.slice(0, 8);
}

/** HookEventRow 的最近事件时间（升序列表取末条）。 */
export function newestEventAt(events: HookEventRow[]): string | undefined {
  return events[events.length - 1]?.createdAt;
}
