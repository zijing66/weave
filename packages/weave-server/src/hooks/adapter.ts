import type { HookEventInput } from '../repositories/hook-events.js';
import type { HookReport, NormalizedHookPayload } from './types.js';

/**
 * Normalizes a raw hook report from a specific agent into the unified
 * {@link HookEventInput} shape for persistence. Implementations live daemon-side
 * so the injected hook script stays a dependency-free forwarder.
 */
export interface HookAdapter {
  readonly source: 'claude' | 'codex';
  normalize(report: HookReport, projectId: number): HookEventInput;
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
export class ClaudeCodeAdapter implements HookAdapter {
  readonly source = 'claude' as const;

  normalize(report: HookReport, projectId: number): HookEventInput {
    const raw = parseRaw(report.payload);
    const eventType = report.eventType || String(raw.hook_event_name ?? 'unknown');
    const sessionId = report.sessionId ?? pick(raw, 'session_id', 'sessionId');

    const normalized: NormalizedHookPayload = {
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
