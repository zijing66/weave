import { HARNESS_EVENTS, type Harness } from '@weavecode/core';
import type { EventSource } from '../driver.js';
import { capFields } from '../shared/json-cap.js';
import { CLAUDE_PLAN } from './plan.js';

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
 * 与顶层派生字段同源同值的 raw 键（键形是 agent 协议知识，只在此声明）。
 * 两份存的是同一份数据——实测 39.5k 历史事件里 tool_response 重复 138MB、
 * tool_input 18.9MB，占 payload 45%——所以 raw 里命中的键改写成指回外层的
 * JSONPath 引用，键形保留；要原文时用 {@link expandPayloadRefs} 按路径取回。
 */
const REF_FIELDS: ReadonlyArray<readonly [outer: string, keys: readonly string[]]> = [
  ['toolName', ['tool_name', 'toolName']],
  ['toolInput', ['tool_input', 'toolInput']],
  ['toolResponse', ['tool_response', 'toolResponse']],
  ['cwd', ['cwd']],
  ['transcriptPath', ['transcript_path', 'transcriptPath']],
];

/** 引用值形：`<$.toolResponse>`（尖括号标记，不会与真实路径串混淆）。 */
const REF_RE = /^<\$\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)>$/;

/**
 * tool_input / tool_response 的叶子裁剪（各 harness 共用，见 `shared/json-cap.ts`
 * 的实测依据）。
 */
/**
 * 计划正文整份保真：命中计划形状就原样返回 `tool_input` / `tool_response` 一对，
 * 一个叶子都不裁。
 *
 * 2.1.296 起 `ExitPlanMode` 的 `tool_input` 恒空，正文随宿主版本在两处出现：早期
 * 在 `tool_input.plan`，后来挪到 `tool_response.plan`（input 只剩 planFilePath）。
 * 对话面板摆出来给人批阅的正是这一份——按 {@link capFields} 裁到 4KB 就是把计划
 * 砍掉大半、气泡尾巴上挂一个「…」（实测 10.4k 字符的计划只剩 4001）。计划事件
 * 一次一对、每次计划模式只写一两回，体积可忽略。
 */
function planBodyOf(toolName: unknown, input: unknown, response: unknown): { input: unknown; response: unknown } | null {
  if (typeof toolName !== 'string') return null;
  return CLAUDE_PLAN.draftOf(toolName, input, response)?.text ? { input, response } : null;
}

/** raw 的浅拷贝：命中的重复键 → 指向顶层同名字段的引用，其余键原样。 */
function compactRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [outer, keys] of REF_FIELDS) {
    for (const k of keys) {
      if (k in out) out[k] = `<$.${outer}>`;
    }
  }
  return out;
}

/**
 * 还原 {@link compactRaw} 折叠掉的字段（按 JSONPath 从外层取回），其余原样。
 * 只有真的要读原始 tool_response / tool_input 时才需要——两者都被提升到顶层，
 * 现有消费方全部读顶层，故读侧默认不必调用。
 */
export function expandPayloadRefs(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return payload;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const [k, v] of Object.entries(out)) {
    const m = typeof v === 'string' ? REF_RE.exec(v) : null;
    if (m) out[k] = readPath(payload, m[1]!);
  }
  return { ...payload, raw: out };
}

/** 按点分路径取值（缺段/非对象 → null）。 */
function readPath(obj: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = obj;
  for (const seg of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur ?? null;
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
    const toolName = pick(raw, 'tool_name', 'toolName');
    const input = pick(raw, 'tool_input', 'toolInput');
    const response = pick(raw, 'tool_response', 'toolResponse');

    const planPair = planBodyOf(toolName, input, response);
    const normalized = {
      eventType,
      toolName,
      toolInput: planPair?.input ?? capFields(input),
      toolResponse: planPair?.response ?? capFields(response),
      cwd: report.cwd ?? pick(raw, 'cwd'),
      transcriptPath: pick(raw, 'transcript_path', 'transcriptPath'),
      raw: compactRaw(raw),
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
  /** raw.source（SessionStart 的 startup/resume/compact/clear——压缩收尾笔靠它认）。 */
  rawSource?: string;
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
  const rawSource =
    raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).source === 'string'
      ? ((raw as Record<string, unknown>).source as string)
      : undefined;
  if (rawSource) facts.rawSource = rawSource;
  return facts;
}
