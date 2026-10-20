import { HARNESS_EVENTS, type Harness } from '@weavecode/core';
import type { EventSource } from '../driver.js';
import { capFields } from '../shared/json-cap.js';

/**
 * Codex 事件接入——**拉取式**：codex 没有按项目可用的 hook / notify 面，它把会话
 * durable 地写在 `$CODEX_HOME/sessions/**.jsonl`（每行一条 JSON），由
 * `codex/rollout.ts` 尾读。本文件只答「一行怎么变成 weave 的一条事件」。
 *
 * 产出用**规范事件名**（SessionStart / UserPromptSubmit / Stop / PostToolUse…），
 * 不用 codex 的线名：回合判据、`turnOpen` 的 SQL、`hasRun`、事件链配色全仓都按
 * 规范名取数，线名差异收在 adapter 里一处。
 */

/** 一条 rollout 行（`type` + `payload`；`ordinal` 是同 thread 的序号，跨 resume 文件连续）。 */
export interface CodexLine {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

/** 日志源产出的一条上报：行本体 + 边读边算出的旁路事实（本轮的最终 assistant 消息）。 */
export interface CodexReport {
  eventType: string;
  sessionId?: string;
  cwd?: string;
  payload: { line: CodexLine; lastAgentMessage?: string | null };
}

/** 归一化后的入库行（结构对齐 server `repositories/hook-events.ts` 的 HookEventInput）。 */
export interface CodexHookEventInput {
  projectId: number;
  source: Harness;
  eventType: string;
  sessionId?: string;
  payload: string;
}

/** `session_meta` 里的会话身份与工作目录（日志源判白名单与归一化共用这一份解析）。 */
export function metaOfLine(line: CodexLine): { sessionId: string; cwd: string | null } | null {
  if (line.type !== 'session_meta') return null;
  const p = line.payload ?? {};
  if (typeof p.session_id !== 'string' || !p.session_id) return null;
  return { sessionId: p.session_id, cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : null };
}

/**
 * 用户输入的正文。**跨版本两种落点**：≤0.150 是 `event_msg:user_message.message`，
 * 0.163 换成 `event_msg:item_completed.item.type='UserMessage'` 的 content（同文件
 * 不会两者都有，实测 53 个文件按版本排他）。`response_item:message(role=user)` 是
 * 转录镜像、不是事件流，不采（采了会与上面重复一条）。
 */
export function promptOfLine(line: CodexLine): string | null {
  const p = line.payload ?? {};
  if (p.type === 'user_message') {
    return typeof p.message === 'string' && p.message ? p.message : null;
  }
  if (p.type !== 'item_completed') return null;
  const item = p.item as { type?: unknown; content?: unknown } | undefined;
  if (item?.type !== 'UserMessage' || !Array.isArray(item.content)) return null;
  const text = item.content
    .map((c) => {
      const part = c as { type?: unknown; text?: unknown };
      return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
    })
    .filter(Boolean)
    .join('\n');
  return text || null;
}

/**
 * 一个 rollout 文件的行 →事件转换器（**顺带维护本轮缓存**：codex 的 `agent_message`
 * 不带 turn_id，只得按行序分轮——任务开始 / 用户输入清空，`task_complete` 取走）。
 *
 * 白名单是卷控的第一道闸：本机 8.5 万行里 `response_item` 4.3 万、`agent_message`
 * 4.1 万，进 dashboard 的只有下面这五类。`world_state` / `turn_context` /
 * `token_count` / `thread_settings_applied` / `task_started` 一律不落库。
 */
export class CodexTurnBuffer {
  private last: string | null = null;

  report(line: CodexLine): CodexReport | null {
    const p = line.payload ?? {};
    const wire = typeof p.type === 'string' ? p.type : null;
    if (wire === 'agent_message') {
      if (typeof p.message === 'string' && p.message) this.last = p.message;
      return null;
    }
    if (promptOfLine(line) !== null) {
      this.last = null;
      return { eventType: 'UserPromptSubmit', payload: { line } };
    }
    if (line.type === 'session_meta') return { eventType: 'SessionStart', payload: { line } };
    if (wire === 'task_started') {
      this.last = null;
      return null;
    }
    if (wire === 'task_complete') {
      // 实测 2071 个回合里 2058 个把 last_agent_message 写成 null，不补就气泡全空
      const lastAgentMessage = this.last;
      this.last = null;
      return { eventType: 'Stop', payload: { line, lastAgentMessage } };
    }
    if (wire === 'turn_aborted') return { eventType: 'TurnAborted', payload: { line } };
    if (wire === 'exec_command_end' || wire === 'patch_apply_end') {
      return { eventType: 'PostToolUse', payload: { line } };
    }
    return null;
  }
}

/** 命令数组 → 一行。 */
function commandText(command: unknown): string | null {
  if (!Array.isArray(command)) return typeof command === 'string' ? command : null;
  return command.filter((c) => typeof c === 'string').join(' ');
}

/** 工具事件归一：codex 只有这两种执行出口，`changes` 只留路径（内容动辄整份文件）。 */
function toolOf(line: CodexLine): {
  toolName: string | null;
  toolInput: unknown;
  toolResponse: unknown;
} {
  const p = line.payload ?? {};
  if (p.type === 'exec_command_end') {
    return {
      toolName: 'exec_command',
      toolInput: { command: commandText(p.command), cwd: p.cwd ?? null },
      toolResponse: { exit_code: p.exit_code ?? null, status: p.status ?? null },
    };
  }
  if (p.type === 'patch_apply_end') {
    const changes = p.changes && typeof p.changes === 'object' ? p.changes : {};
    return {
      toolName: 'apply_patch',
      toolInput: { paths: Object.keys(changes) },
      toolResponse: { success: p.success ?? null },
    };
  }
  return { toolName: null, toolInput: null, toolResponse: null };
}

/** 回合收尾正文：宿主给的优先，缺了用本轮缓存的最后一条 assistant 消息。 */
function stopTextOf(payload: Record<string, unknown>, fallback?: string | null): string | null {
  if (typeof payload.last_agent_message === 'string' && payload.last_agent_message) {
    return payload.last_agent_message;
  }
  return fallback ?? null;
}

/** 回合因 API 错误收尾时的错误文本（`task_complete.error.message` 或裸字符串）。 */
function errorOf(payload: Record<string, unknown>): string | null {
  const err = payload.error;
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return null;
}

export class CodexEventSource implements EventSource {
  readonly source = 'codex' as const;
  readonly events = HARNESS_EVENTS.codex;

  normalize(report: unknown, projectId: number): CodexHookEventInput {
    const r = (report ?? {}) as CodexReport;
    const line = r.payload?.line ?? {};
    const p = line.payload ?? {};
    const eventType = r.eventType || 'unknown';
    const raw: Record<string, unknown> = {};
    if (eventType === 'UserPromptSubmit') {
      raw.prompt = promptOfLine(line) ?? '';
    } else if (eventType === 'Stop') {
      raw.last_assistant_message = stopTextOf(p, r.payload?.lastAgentMessage);
      const error = errorOf(p);
      if (error) raw.error = error;
    } else if (eventType === 'TurnAborted') {
      raw.reason = p.reason ?? null;
      raw.duration_ms = p.duration_ms ?? null;
    } else if (eventType === 'SessionStart') {
      raw.source = 'startup';
    }
    if (line.ordinal !== undefined) raw.seq = line.ordinal;
    const { toolName, toolInput, toolResponse } = toolOf(line);
    const normalized = {
      eventType,
      toolName,
      toolInput: capFields(toolInput),
      toolResponse: capFields(toolResponse),
      cwd: r.cwd ?? null,
      raw: capFields({ ...raw, turn_id: p.turn_id ?? null, call_id: p.call_id ?? null }),
    };
    return {
      projectId,
      source: 'codex',
      eventType,
      sessionId: r.sessionId,
      payload: JSON.stringify(normalized),
    };
  }
}

/** 事件接入实例（driver events 槽消费；normalize 无状态，单例安全）。 */
export const CODEX_EVENT_SOURCE = new CodexEventSource();
