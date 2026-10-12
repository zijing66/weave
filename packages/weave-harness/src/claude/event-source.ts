import { HARNESS_EVENTS, type Harness } from '@weavecode/core';
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
  /** 改名交付回执（随响应实际下发的 sessionTitle；未下发 = null）。 */
  deliveredTitle?: string | null;
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

/** SSE event.ingested 帧的 Claude 协议扩展字段（web 任务面板子 agent 对账消费）。 */
export interface ClaudeFrameFacts {
  agentId?: string;
  spawnAgentId?: string;
  backgroundTasks?: Array<{ id: string; status: string }>;
}

/** frameFacts 所需的归一化 payload 形状（server NormalizedHookPayload 结构兼容）。 */
export interface FramePayloadLike {
  eventType: string;
  toolName: string | null;
  toolResponse: unknown;
  raw: unknown;
}

/**
 * 从归一化 payload 提取 SSE 帧的 Claude 协议字段（协议知识留在 harness 侧，
 * server 路由只透传）：
 * - agentId：子 agent 自身工具事件的 raw.agent_id（归属父会话，活性续期）；
 * - spawnAgentId：Agent 工具异步返回 isAsync+agentId（后台子 agent 出生信号）；
 * - backgroundTasks：Stop/SubagentStop 的 background_tasks 快照（仅 id/status）。
 * 缺失字段不入返回对象——server 直接展开进帧，与旧 `...(x ? {x} : {})` 等价。
 */
export function frameFacts(payload: FramePayloadLike | null): ClaudeFrameFacts {
  const raw = payload?.raw;
  const agentId =
    raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).agent_id === 'string'
      ? ((raw as Record<string, unknown>).agent_id as string)
      : undefined;
  // 后台子 agent 出生信号：Agent 工具的异步返回带子 agent id。
  let spawnAgentId: string | undefined;
  if (payload?.eventType === 'PostToolUse' && payload.toolName === 'Agent') {
    const resp = payload.toolResponse as { isAsync?: unknown; agentId?: unknown } | null;
    if (resp?.isAsync && typeof resp.agentId === 'string') spawnAgentId = resp.agentId;
  }
  // Stop/SubagentStop 帧透出 background_tasks 快照（仅保留 id/status 字符串）。
  let backgroundTasks: Array<{ id: string; status: string }> | undefined;
  if (Array.isArray(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).background_tasks : undefined)) {
    backgroundTasks = ((raw as Record<string, unknown>).background_tasks as Array<Record<string, unknown>>)
      .filter((x) => x && typeof x.id === 'string' && typeof x.status === 'string')
      .map((x) => ({ id: x.id as string, status: x.status as string }));
  }
  const facts: ClaudeFrameFacts = {};
  if (agentId) facts.agentId = agentId;
  if (spawnAgentId) facts.spawnAgentId = spawnAgentId;
  if (backgroundTasks) facts.backgroundTasks = backgroundTasks;
  return facts;
}
