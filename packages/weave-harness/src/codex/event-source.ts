import { HARNESS_EVENTS, type Harness } from '@weavecode/core';
import type { EventSource } from '../driver.js';
import { capFields } from '../shared/json-cap.js';
import { CLAUDE_EVENT_SOURCE } from '../claude/event-source.js';

/**
 * Codex 事件接入。**主源 = codex hooks**（`codex/capture.ts` 装 `<CODEX_HOME>/
 * hooks.json`），**兜底 = 尾读 rollout JSONL**（`codex/rollout.ts`，hooks 未被
 * 信任时 dashboard 不至于全瞎、存量会话仍可见）。
 *
 * 两种上报走同一个 `normalize`，按 `payload` 的类型分流：hook 上报的 payload 是
 * 原始 stdin 字符串，rollout 上报的是 `{line, lastAgentMessage}`。产出恒为
 * **规范事件名**——`turnOpen` 的 SQL、分组、配色全仓按规范名取数。
 */

/**
 * codex 线名 → weave 规范名。只翻不同名的那几个：`Interrupt` 是 codex 的中断
 * 事件（`hooks/schema/generated/interrupt.command.input.schema.json`），与
 * `HARNESS_LIFECYCLE.codex.close` 里的 `TurnAborted` 是同一件事。
 */
const WIRE_TO_CANONICAL: Readonly<Record<string, string>> = {
  Interrupt: 'TurnAborted',
};

/** 规范名 → codex 线名（`hooks.json` 声明用；上表的逆，别处不再手抄一份线名表）。 */
export const CANONICAL_TO_WIRE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(WIRE_TO_CANONICAL).map(([wire, canonical]) => [canonical, wire]),
);

/** 一条 rollout 行（`type` + `payload`；`ordinal` 是同 thread 的序号，跨 resume 文件连续）。 */
export interface CodexLine {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

/** rollout 日志源产出的一条上报：行本体 + 边读边算出的旁路事实（本轮最终 assistant 消息）。 */
export interface CodexReport {
  eventType: string;
  sessionId?: string;
  cwd?: string;
  payload: { line: CodexLine; lastAgentMessage?: string | null };
}

/** hook 上报体（结构对齐 server `hooks/types.ts` 的 HookReport；本包仅依赖 core，按结构自持）。 */
export interface CodexHookReport {
  source: Harness;
  eventType: string;
  sessionId?: string | null;
  cwd?: string;
  /** codex hook stdin 的原始 JSON。 */
  payload: string;
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
 * 消息项正文的取法——**大小写两套**：`AgentMessage` 的 content 段是 PascalCase
 * `"Text"`，`UserMessage` 的是小写 `"text"`（实测 41127 条 item 全量核对）。
 * 两处都容忍，免得下一版又换了 casing 就整条静默丢。
 */
function textOfParts(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const text = content
    .map((c) => {
      const part = c as { type?: unknown; text?: unknown };
      const kind = typeof part?.type === 'string' ? part.type.toLowerCase() : '';
      return kind === 'text' && typeof part.text === 'string' ? part.text : '';
    })
    .filter(Boolean)
    .join('\n');
  return text || null;
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
  if (item?.type !== 'UserMessage') return null;
  return textOfParts(item.content);
}

/** `item_completed` 里的 TurnItem（0.163 起事件流走它，老线名 `exec_command_end` 只留给旧文件）。 */
function itemOfLine(line: CodexLine): { type: string; item: Record<string, unknown> } | null {
  const p = line.payload ?? {};
  if (p.type !== 'item_completed') return null;
  const item = p.item;
  if (!item || typeof item !== 'object') return null;
  const type = (item as { type?: unknown }).type;
  return typeof type === 'string' ? { type, item: item as Record<string, unknown> } : null;
}

/**
 * 一个 rollout 文件的行 →事件转换器（**顺带维护本轮缓存**：codex 的 agent 消息
 * 不带 turn_id，只得按行序分轮——任务开始 / 用户输入清空，`task_complete` 取走）。
 *
 * 白名单是卷控的第一道闸：本机 8.5 万行里 `response_item` 4.3 万、`AgentMessage`
 * 4.1 万，进 dashboard 的只有下面这几类。`world_state` / `turn_context` /
 * `token_count` / `thread_settings_applied` 一律不落库。
 */
export class CodexTurnBuffer {
  private last: string | null = null;

  report(line: CodexLine): CodexReport | null {
    const p = line.payload ?? {};
    const wire = typeof p.type === 'string' ? p.type : null;
    const item = itemOfLine(line);
    if (wire === 'agent_message') {
      if (typeof p.message === 'string' && p.message) this.last = p.message;
      return null;
    }
    if (item?.type === 'AgentMessage') {
      const text = textOfParts(item.item.content);
      if (text) this.last = text;
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
    if (item?.type === 'CommandExecution' || item?.type === 'FileChange' || item?.type === 'McpToolCall') {
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

/**
 * 工具事件归一（rollout 兜底路径）：老线名的两种执行出口 + 0.163 的 TurnItem。
 * `changes` 只留路径（内容动辄整份文件）。
 */
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
  const item = itemOfLine(line);
  if (item?.type === 'CommandExecution') {
    return {
      toolName: 'exec_command',
      toolInput: { command: commandText(item.item.command), cwd: item.item.cwd ?? null },
      toolResponse: { exit_code: item.item.exit_code ?? null, status: item.item.status ?? null },
    };
  }
  if (item?.type === 'FileChange') {
    const changes = item.item.changes && typeof item.item.changes === 'object' ? item.item.changes : {};
    return {
      toolName: 'apply_patch',
      toolInput: { paths: Object.keys(changes) },
      toolResponse: { status: item.item.status ?? null },
    };
  }
  if (item?.type === 'McpToolCall') {
    return {
      toolName: typeof item.item.name === 'string' ? item.item.name : 'mcp_tool_call',
      toolInput: item.item.arguments ?? null,
      toolResponse: item.item.result ?? item.item.status ?? null,
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
    const r = (report ?? {}) as { payload?: unknown };
    if (typeof r.payload === 'string') return hookInput(r as CodexHookReport, projectId);
    return rolloutInput(r as CodexReport, projectId);
  }
}

/**
 * hook 上报的归一。codex 0.163 的 hook 载荷与 claude **逐字同形**（字段名、大小写、
 * 嵌套都在 `hooks/schema/generated/*.command.input.schema.json` 里），故直接复用
 * claude 那一份归一器、只把事件名翻成规范词并把 `source` 改回 codex——两套同形的
 * 代码各抄一遍，改一处必漏另一处。
 */
function hookInput(report: CodexHookReport, projectId: number): CodexHookEventInput {
  const wire = report.eventType || 'unknown';
  // 用户自己装进 hooks.json 的其它事件也照收：认不出线名就原样透传
  const canonical = WIRE_TO_CANONICAL[wire] ?? wire;
  const out = CLAUDE_EVENT_SOURCE.normalize({ ...report, eventType: canonical }, projectId);
  return { ...(out as CodexHookEventInput), source: 'codex' };
}

/** rollout 兜底路径的归一（老线名与 0.163 TurnItem 都走这里）。 */
function rolloutInput(r: CodexReport, projectId: number): CodexHookEventInput {
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
    // 'rollout' 而非 'startup'：这不是宿主的启动照会（hook 的 SessionStart 才是，
    // 带 model / permission_mode），是「rollout 文件出现了」——TUI 开了、线程还没建
    // （SessionStart 懒触发）。server 的模型闩（startedModelOf）只认宿主启动源，
    // 别把 claude 全局默认模型错标到 codex 会话上。
    raw.source = 'rollout';
  }
  if (line.ordinal !== undefined) raw.seq = line.ordinal;
  const { toolName, toolInput, toolResponse } = toolOf(line);
  const normalized = {
    eventType,
    toolName,
    toolInput: capFields(toolInput),
    toolResponse: capFields(toolResponse),
    cwd: r.cwd ?? null,
    // raw 只装标量 + 两个对话正文载体（prompt / last_assistant_message），与 claude
    // 路径一致不裁：4KB 封顶会把挂在回复末尾的渲染块引用行截掉。
    raw: { ...raw, turn_id: p.turn_id ?? null, call_id: p.call_id ?? null },
  };
  return {
    projectId,
    source: 'codex',
    eventType,
    sessionId: r.sessionId,
    payload: JSON.stringify(normalized),
  };
}

/** 事件接入实例（driver events 槽消费；normalize 无状态，单例安全）。 */
export const CODEX_EVENT_SOURCE = new CodexEventSource();
