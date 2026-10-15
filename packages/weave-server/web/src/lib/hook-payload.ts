import type { HookEventRow } from './api';
import { HARNESS_UI } from './harness-meta';

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

/** 采集来源 → Badge 配色。由 harness-meta 单点表派生（加 harness 自动跟随）。 */
export const SOURCE_STYLES: Record<string, string> = Object.fromEntries(
  Object.entries(HARNESS_UI).map(([harness, ui]) => [harness, ui.source]),
);

/** ISO → 本地时分（日志/节点用）。 */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

/** ISO → 时刻戳：当天只给时分秒，跨天补月日（对话条目逐条显示）。 */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString();
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/**
 * weave 直投消息的来源标记（mirror `@weavecode/core` 的 WEAVE_INJECTION_MARKER
 * ——web 运行时不能 import core 值，同 `tasks/lifecycle.ts` 的镜像口径，改那边
 * 同步这里）。socket 直投走这条通道，会话转录里因此带着它：web 拿它认「这条是
 * weave 发的，不是终端里敲的」，并把它从正文里摘掉、改用一枚 tag 呈现。
 */
export const WEAVE_MARKER = '[weave] ';

/** 用户 prompt 原文（归一化 payload 的 raw.prompt）；空/缺失返回 null。 */
export function promptOf(event: HookEventRow): string | null {
  return str(rawOf(event).prompt);
}

/** 每轮 Stop 携带的最终 assistant 消息（raw.last_assistant_message）；空/缺失返回 null。 */
export function turnSummaryOf(event: HookEventRow): string | null {
  return str(rawOf(event).last_assistant_message);
}

/** 会话短标签（title 回退 sessionId 前 8 位）。 */
export function sessionLabel(title: string | null, sessionId: string): string {
  return title ?? sessionId.slice(0, 8);
}

/** HookEventRow 的最近事件时间（升序列表取末条）。 */
export function newestEventAt(events: HookEventRow[]): string | undefined {
  return events[events.length - 1]?.createdAt;
}

/** 同一 event 的 payload 解析缓存——rawOf/agentDispatchOf/taskNotificationOf
 *  共用一次 JSON.parse；events refetch 换新对象即自动失效（WeakMap）。 */
const parseCache = new WeakMap<HookEventRow, Record<string, unknown>>();

/** payload 的 JSON.parse 结果（坏 JSON / 非对象 → 空对象，不抛）。 */
function parsedOf(event: HookEventRow): Record<string, unknown> {
  const hit = parseCache.get(event);
  if (hit !== undefined) return hit;
  let out: Record<string, unknown> = {};
  try {
    const p: unknown = JSON.parse(event.payload);
    if (p && typeof p === 'object') out = p as Record<string, unknown>;
  } catch {
    // 坏 JSON → 空对象（各解析函数照常回落）
  }
  parseCache.set(event, out);
  return out;
}

/** payload.raw 原始对象（坏 JSON / 缺失返回空对象）。 */
export function rawOf(event: HookEventRow): Record<string, unknown> {
  const p = parsedOf(event);
  return p.raw && typeof p.raw === 'object' ? (p.raw as Record<string, unknown>) : {};
}

const flat = (v: string): string => v.replace(/\s+/g, ' ').trim();
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * 派发子代理证据：PostToolUse(toolResponse.agentId) —— agentId 是子代理的
 * 身份锚（关联其 SubagentStop / task-notification），resolvedModel 是该
 * 子代理使用的 model。非派发事件返回 null。
 */
export interface AgentDispatch {
  agentId: string;
  toolUseId: string | null;
  model: string | null;
}

export function agentDispatchOf(event: HookEventRow): AgentDispatch | null {
  if (event.eventType !== 'PostToolUse') return null;
  const p = parsedOf(event);
  const resp = p.toolResponse as { agentId?: unknown; resolvedModel?: unknown } | null;
  if (!resp || typeof resp.agentId !== 'string' || !resp.agentId) return null;
  const raw = p.raw as { tool_use_id?: unknown } | undefined;
  return { agentId: resp.agentId, toolUseId: str(raw?.tool_use_id), model: str(resp.resolvedModel) };
}

/**
 * 子代理返回通知：UserPromptSubmit 且 prompt 以 <task-notification> 开头
 * （含 task-id=agentId、tool-use-id=派发调用、status=completed/killed）。
 * 这不是一次用户 prompt——分组不开新组、图上作为派发环的闭环证据。
 */
export interface TaskNotification {
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
  summary: string | null;
}

export function taskNotificationOf(event: HookEventRow): TaskNotification | null {
  const raw = parsedOf(event).raw as { prompt?: unknown } | undefined;
  const prompt = str(raw?.prompt);
  if (!prompt || !prompt.startsWith('<task-notification>')) return null;
  const pick = (tag: string): string | null => {
    const m = prompt.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1]!.trim() || null : null;
  };
  return {
    taskId: pick('task-id'),
    toolUseId: pick('tool-use-id'),
    status: pick('status'),
    summary: pick('summary'),
  };
}

/**
 * 按 hook 类型提取该事件的关键信息（完整展示，不只路径）：prompt 原文 /
 * tool 参数与结果首行 / 通知消息 / 子代理结束消息 / 会话标记。
 * 空串 = 该类型无正文（展示方退化为类型 tag + 时间）。事件链与思维导图共用。
 */
export function summarizeEvent(event: HookEventRow): string {
  const raw = rawOf(event);
  const detail = parseDetail(event.payload);
  switch (event.eventType) {
    case 'UserPromptSubmit': {
      // task-notification（子代理返回）：提取 status/summary，不展示整段 XML
      const notif = taskNotificationOf(event);
      if (notif) {
        return [notif.status, notif.summary].filter(Boolean).join(' · ');
      }
      return flat(str(raw.prompt) ?? '');
    }
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
