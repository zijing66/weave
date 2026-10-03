import { HARNESS_EVENTS, type Harness } from '@weave/core';
import type { EventSource } from '../driver.js';

/**
 * 批 4b 迁入：Claude 事件接入——原 server `hooks/adapter.ts` 的 ClaudeCodeAdapter
 * 实现逐字节平移（行为等价；字段名保持 `source`，结构兼容 server 的 HookAdapter，
 * 不引入双字段）。
 */

/** 上报体（结构对齐 server `hooks/types.ts` 的 HookReport；本包仅依赖 core，按结构自持）。 */
export interface ClaudeHookReport {
  source: Harness;
  eventType: string;
  sessionId?: string | null;
  cwd?: string;
  /** Agent hook stdin 捕获的原始 JSON。 */
  payload: string;
}

/** 归一化后的入库行（结构对齐 server `repositories/hook-events.ts` 的 HookEventInput）。 */
export interface ClaudeHookEventInput {
  projectId: number;
  source: Harness;
  eventType: string;
  sessionId?: string;
  payload: string;
}

/** Parse the raw payload JSON, tolerating malformed/non-object input. */
function parseRaw(payload: string): Record<string, unknown> {
  try {
    const v = JSON.parse(payload);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Return the first non-null value found under any of the given keys. */
function pick<T = unknown>(raw: Record<string, unknown>, ...keys: string[]): T | null {
  for (const k of keys) {
    if (raw[k] != null) return raw[k] as T;
  }
  return null;
}

/**
 * Normalizes Claude Code hook events. Claude Code sends snake_case fields via
 * stdin (session_id, hook_event_name, tool_name, tool_input, tool_response,
 * transcript_path, cwd); camelCase variants are tolerated for safety.
 */
export class ClaudeEventSource implements EventSource {
  readonly source = 'claude' as const;
  /** 采集面事件表（批 1 下沉 core 的 HARNESS_EVENTS.claude；旧 HookAdapter 无此字段）。 */
  readonly events = HARNESS_EVENTS.claude;

  normalize(report: ClaudeHookReport, projectId: number): ClaudeHookEventInput {
    const raw = parseRaw(report.payload);
    const eventType = report.eventType || String(raw.hook_event_name ?? 'unknown');
    const sessionId = report.sessionId ?? pick(raw, 'session_id', 'sessionId');

    const normalized = {
      eventType,
      toolName: pick(raw, 'tool_name', 'toolName'),
      toolInput: pick(raw, 'tool_input', 'toolInput'),
      toolResponse: pick(raw, 'tool_response', 'toolResponse'),
      cwd: report.cwd ?? pick(raw, 'cwd'),
      transcriptPath: pick(raw, 'transcript_path', 'transcriptPath'),
      raw,
    };

    return {
      projectId,
      source: 'claude',
      eventType,
      sessionId: sessionId ?? undefined,
      payload: JSON.stringify(normalized),
    };
  }
}

/** 事件接入实例（driver events 槽消费；normalize 无状态，单例安全）。 */
export const CLAUDE_EVENT_SOURCE = new ClaudeEventSource();
