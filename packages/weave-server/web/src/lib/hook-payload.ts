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

/** payload.raw 原始对象（坏 JSON / 缺失返回空对象）。 */
export function rawOf(event: HookEventRow): Record<string, unknown> {
  try {
    const p = JSON.parse(event.payload) as { raw?: unknown };
    return p.raw && typeof p.raw === 'object' ? (p.raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const flat = (v: string): string => v.replace(/\s+/g, ' ').trim();
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * 按 hook 类型提取该事件的关键信息（完整展示，不只路径）：prompt 原文 /
 * tool 参数与结果首行 / 通知消息 / 子代理结束消息 / 会话标记。
 * 空串 = 该类型无正文（展示方退化为类型 tag + 时间）。事件链与思维导图共用。
 */
export function summarizeEvent(event: HookEventRow): string {
  const raw = rawOf(event);
  const detail = parseDetail(event.payload);
  switch (event.eventType) {
    case 'UserPromptSubmit':
      return flat(str(raw.prompt) ?? '');
    case 'PreToolUse':
    case 'PostToolUse': {
      const input = (detail.toolInput ?? {}) as Record<string, unknown>;
      const arg =
        str(input.file_path) ??
        str(input.path) ??
        str(input.description) ??
        str(input.pattern) ??
        str(input.url) ??
        str(input.command) ??
        '';
      const head = flat([detail.toolName, arg].filter(Boolean).join(' '));
      if (event.eventType === 'PostToolUse') {
        const r = detail.toolResponse as Record<string, unknown> | null;
        const out =
          r && typeof r === 'object'
            ? (str((r as Record<string, unknown>).stdout) ??
              str((r as Record<string, unknown>).type))
            : null;
        if (out) return `${head} → ${flat(out).slice(0, 90)}`;
      }
      return head;
    }
    case 'Notification': {
      const msg = str(raw.message) ?? '';
      const nt = str(raw.notification_type);
      return nt && msg ? `${nt} · ${msg}` : (nt ?? msg);
    }
    case 'SubagentStop':
      return flat(str(raw.last_assistant_message) ?? '');
    case 'SessionStart':
    case 'SessionEnd': {
      const title = str(raw.session_title) ?? '';
      const source = str(raw.source) ?? '';
      return [title, source].filter(Boolean).join(' · ');
    }
    default:
      return '';
  }
}
