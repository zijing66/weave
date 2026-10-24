/** hooks 域：事件行、规则、插件、指令池派发与工具包（toolkit）。 */

import type { Harness } from '@weavecode/core/harness';
import { apiFetch } from './client';
import type { UploadFile } from './uploads';

export interface HookEventRow {
  id: number;
  projectId: number;
  source: string;
  eventType: string;
  sessionId: string | null;
  payload: string;
  createdAt: string;
  /** 消息随附文件（挂在开轮事件上；图片出缩略图）。取档走 `API_BASE + /images/<id>`。 */
  images?: UploadFile[];
}

/**
 * Mirror of the hook rule model in packages/weave-core/src/types.ts — 保持同步
 * （web 不能 import 含 node:fs 的 workspace 包，服务端 zod 校验兜底）。
 */
export type HookRuleSource =
  | { kind: 'hook-event'; harness: Harness | 'any'; event: string }
  | { kind: 'webhook'; routeId: string }
  /** 读兼容分支：存量规则的 legacy 形，读侧经 normalizeHookRuleSource 归一。 */
  | { kind: 'claude-event'; event: string };

/** mirror of `normalizeHookRuleSource` in packages/weave-core/src/types.ts。 */
export function normalizeHookRuleSource(source: HookRuleSource): HookRuleSource {
  if (source.kind === 'claude-event') {
    return { kind: 'hook-event', harness: 'claude', event: source.event };
  }
  return source;
}

/** mirror of `hookSourceHarness` in packages/weave-core/src/types.ts。 */
export function hookSourceHarness(source: HookRuleSource): Harness | 'any' | null {
  if (source.kind === 'claude-event') return 'claude';
  if (source.kind === 'hook-event') return source.harness;
  return null;
}

/** mirror of `HookRuleFilter` in packages/weave-core/src/types.ts。 */
export interface HookRuleFilter {
  /** 匹配 toolInput 的工具名（PostToolUse/PreToolUse 事件）。 */
  toolNames?: string[];
  /** 匹配 toolInput.file_path 的 glob（posix 分隔符）。 */
  pathGlobs?: string[];
  /** 只在 file_path/cwd 命中「其他已注册项目根」时触发。 */
  crossProjectOnly?: boolean;
}

/** mirror of `HandlerConfig` in packages/weave-core/src/types.ts。 */
export type HandlerConfig =
  | { type: 'log' }
  | { type: 'webhook'; url: string; secret?: string; headers?: Record<string, string> }
  | { type: 'inject'; template: string }
  | { type: 'manual'; template: string }
  | { type: 'plugin'; pluginId: string; handlerType: string; config?: Record<string, unknown> }
  | {
      type: 'classify';
      prompt: string;
      prefilter?: string[];
      cooldownMs?: number;
      routes: Array<{ label: string; url: string; secret?: string; headers?: Record<string, string> }>;
    };

/** mirror of `HookRule` in packages/weave-core/src/types.ts。 */
export interface HookRule {
  id: string;
  name: string;
  enabled: boolean;
  /** 数值越大越先匹配。 */
  priority: number;
  /** null = 全局规则（对所有注册项目生效）。 */
  projectId: number | null;
  source: HookRuleSource;
  filter: HookRuleFilter;
  handler: HandlerConfig;
  timeoutMs: number;
  /** 是否落 hook_dispatches（log 默认 false）。 */
  record: boolean;
  /** 来源标记（插件规则显示徽标用；旧服务端缺省视为 user）。 */
  origin?: 'user' | 'plugin' | 'builtin';
  pluginId?: string | null;
}

/** mirror of `LoadedPluginInfo` in packages/weave-server/src/hooks/plugin-loader.ts。 */
export interface HookPlugin {
  id: string;
  name: string;
  version: string;
  dir: string;
  scope: 'builtin' | 'user' | 'project';
  projectId: number | null;
  status: 'active' | 'rejected' | 'disabled';
  error?: string;
  ruleCount: number;
}

/** mirror of `ToolkitPackInfo` in packages/weave-server/src/hooks/toolkit.ts（批 10）。 */
export interface ToolkitPack {
  id: string;
  name: string;
  version: string;
  description?: string;
  scope: string;
  dir: string;
  provenance: 'builtin' | 'market';
  sourceRoot: string;
  /** 所属仓库 namespace（服务端 `marketIdOf(pack.dir)`）：内置 = `weave`、外部
   *  市场 = 该市场 id；不在任何市场下（裸插件/手加目录）缺省 → 前端归「本地」。 */
  namespace?: string;
  /** weave.json manifest 的安装目标 harness（服务端 normalizeTargets 归一）。 */
  targets: Harness[];
  kind: 'skill' | 'hook' | 'mod' | 'rule' | 'surface';
  components: string[];
  ccPack: boolean;
  weavePack: boolean;
  skills: string[];
  enabled: boolean;
  /** 是否已安装（CC/mod = harness 全局安装态；表面包 = 本项目落盘；weave 恒 true）。 */
  installed: boolean;
  /** CC 注册键 `name@<市场>`（仅 CC 落地包有）：@后为所属市场 = 插件的 namespace。 */
  key?: string;
  /** 该键已登记的安装 scope（user = 全局装、project = 项目内装）；未装为空。 */
  scopes?: string[];
  weave?: { status: 'active' | 'rejected' | 'disabled'; ruleCount: number; error?: string };
}

/** mirror of server `ToolkitListResult` / `ToolkitToggleResult`。 */
export interface ToolkitListResult {
  packs: ToolkitPack[];
  legacyCopies: string[];
}

export interface ToolkitToggleResult {
  pack: ToolkitPack;
  warnings: string[];
}

/** 创建/更新规则的请求体（服务端 zod CreateRuleBody / UpdateRuleBody）。 */
export interface HookRuleInput {
  name: string;
  enabled?: boolean;
  priority?: number;
  projectId: number | null;
  source: HookRuleSource;
  filter?: HookRuleFilter;
  handler: HandlerConfig;
  timeoutMs?: number;
  record?: boolean;
}

/** mirror of `HookDispatchStatus` in packages/weave-core/src/types.ts。 */
export type HookDispatchStatus =
  | 'pending'
  | 'injected'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout';

/** mirror of `HookDispatchMode` in packages/weave-core/src/types.ts。 */
export type HookDispatchMode = 'auto' | 'manual';

/** mirror of `HookDispatchRow` in packages/weave-server/src/repositories/hook-dispatches.ts。 */
export interface HookDispatch {
  id: number;
  ruleId: string;
  eventId: number | null;
  sessionId: string | null;
  /** 待运行指令文本（指令池中的「物」）。 */
  prompt: string;
  status: HookDispatchStatus;
  mode: HookDispatchMode;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** mirror of `HARNESS_EVENTS.claude`（core；别名 CLAUDE_HOOK_EVENTS）— 同序。
 *  hooks 规则编辑器的事件选项——按 harness 事件表展开随 hooks 域批做。 */
export const CLAUDE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'SubagentStop',
  'Notification',
  'PreCompact',
  'SessionEnd',
  'PreModelSwitch',
  'PostModelSwitch',
] as const;

/** mirror of `INJECTABLE_HOOK_EVENTS` — inject 处理器只允许这些事件（服务端 400）。 */
export const INJECTABLE_HOOK_EVENTS = [
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'SubagentStop',
] as const;

export const hooksApi = {
  /** 按会话查事件（时间升序，任务视图事件链用）。projectId 仅作鉴权锚点。
   *  `beforeId` 游标翻页：只取比游更早的事件（组头「加载更早」向前翻）。
   *  `types` 非空只取这些事件类型（对话视图只翻开/闭轮事件）。 */
  listSessionHooks: (
    projectId: number,
    sessionId: string,
    limit = 300,
    beforeId?: number,
    types?: readonly string[],
  ): Promise<HookEventRow[]> =>
    apiFetch<{ events: HookEventRow[] }>(
      `/projects/${projectId}/hooks?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}${
        beforeId === undefined ? '' : `&beforeId=${beforeId}`
      }${types?.length ? `&types=${encodeURIComponent(types.join(','))}` : ''}`,
    ).then((r) => r.events),

  /** 不带 projectId 返回全部规则；带 projectId 返回全局 + 该项目的规则。 */
  listHooksRules: (projectId?: number): Promise<HookRule[]> =>
    apiFetch<{ rules: HookRule[] }>(
      `/hooks/rules${projectId === undefined ? '' : `?projectId=${projectId}`}`,
    ).then((r) => r.rules),
  createHookRule: (body: HookRuleInput): Promise<HookRule> =>
    apiFetch<{ rule: HookRule }>('/hooks/rules', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.rule),
  /** 局部更新；未知 id 抛 404 错误。 */
  updateHookRule: (id: string, patch: Partial<HookRuleInput>): Promise<HookRule> =>
    apiFetch<{ rule: HookRule }>(`/hooks/rules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }).then((r) => r.rule),
  deleteHookRule: (id: string): Promise<void> =>
    apiFetch<{ ok: boolean }>(`/hooks/rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).then(() => undefined),
  /** SPI 扫描的插件列表（内置预设/全局/项目三根）。带 projectId = 该项目 effective 态。 */
  listHookPlugins: (projectId?: number): Promise<HookPlugin[]> =>
    apiFetch<{ plugins: HookPlugin[] }>(
      `/hooks/plugins${projectId === undefined ? '' : `?projectId=${projectId}`}`,
    ).then((r) => r.plugins),
  /** 插件级开关（级联启停其全部规则）；带 projectId = 项目覆盖（不写全局默认）。 */
  toggleHookPlugin: (id: string, enabled: boolean, projectId?: number): Promise<void> =>
    apiFetch<{ ok: boolean }>(`/hooks/plugins/${encodeURIComponent(id)}/toggle`, {
      method: 'POST',
      body: JSON.stringify(projectId === undefined ? { enabled } : { enabled, projectId }),
    }).then(() => undefined),
  /** 安装插件（本地目录 | git URL）→ daemon 复制进全局插件根并立即重扫。 */
  installHookPlugin: (src: string): Promise<{ installed: Array<{ id: string }>; warnings: string[] }> =>
    apiFetch<{ installed: Array<{ id: string }>; warnings: string[] }>('/hooks/plugins', {
      method: 'POST',
      body: JSON.stringify({ src }),
    }),
  /** 卸载插件（删目录，规则随重扫级联移除）。 */
  uninstallHookPlugin: (id: string): Promise<void> =>
    apiFetch<{ ok: boolean }>(`/hooks/plugins/${encodeURIComponent(id)}/uninstall`, {
      method: 'POST',
    }).then(() => undefined),
  /** 手动重新扫描插件根：重登记根 → 重扫 → watcher 重挂（运行期新建的根由此纳管）。 */
  rescanHookPlugins: (): Promise<number> =>
    apiFetch<{ ok: boolean; plugins: number }>('/hooks/plugins/rescan', {
      method: 'POST',
    }).then((r) => r.plugins),
  // ---- 批 10 工具包（toolkit）----
  listToolkit: (projectId: number): Promise<ToolkitListResult> =>
    apiFetch<ToolkitListResult>(`/projects/${projectId}/toolkit`),
  toggleToolkit: (
    projectId: number,
    id: string,
    enabled: boolean,
    source?: string,
  ): Promise<ToolkitToggleResult> =>
    apiFetch<ToolkitToggleResult>(
      `/projects/${projectId}/toolkit/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}${
        source ? `?source=${encodeURIComponent(source)}` : ''
      }`,
      { method: 'POST' },
    ),
  cleanupToolkitLegacyCopies: (projectId: number): Promise<{ removed: string[] }> =>
    apiFetch<{ removed: string[] }>(`/projects/${projectId}/toolkit/legacy-copies/cleanup`, {
      method: 'POST',
    }),
  /** 卸载工具包（与 harness 对齐：CC 插件/mod 走 claude plugin uninstall，表面包清扫文件）。 */
  uninstallToolkit: (
    projectId: number,
    id: string,
    source?: string,
  ): Promise<ToolkitToggleResult> =>
    apiFetch<ToolkitToggleResult>(
      `/projects/${projectId}/toolkit/${encodeURIComponent(id)}/uninstall${
        source ? `?source=${encodeURIComponent(source)}` : ''
      }`,
      { method: 'POST' },
    ),
  listHookDispatches: (q?: {
    ruleId?: string;
    status?: HookDispatchStatus;
    sessionId?: string;
    limit?: number;
  }): Promise<HookDispatch[]> => {
    const params = new URLSearchParams();
    if (q?.ruleId) params.set('ruleId', q.ruleId);
    if (q?.status) params.set('status', q.status);
    if (q?.sessionId) params.set('sessionId', q.sessionId);
    if (q?.limit !== undefined) params.set('limit', String(q.limit));
    const qs = params.toString();
    return apiFetch<{ dispatches: HookDispatch[] }>(
      `/hooks/dispatches${qs ? `?${qs}` : ''}`,
    ).then((r) => r.dispatches);
  },
  /** 把指令池中的一条派发执行到指定会话（另一并行任务实现的路由）。 */
  runHookDispatch: (
    dispatchId: number,
    sessionId: string,
  ): Promise<{ ok: boolean; dispatchId: number }> =>
    apiFetch<{ ok: boolean; dispatchId: number }>(
      `/hooks/dispatches/${dispatchId}/run`,
      { method: 'POST', body: JSON.stringify({ sessionId }) },
    ),
};
