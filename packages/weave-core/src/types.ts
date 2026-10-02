import { z } from 'zod';

// ---- Presets ----

export const PresetSchema = z.enum(['minimal', 'default', 'full']);
export type Preset = z.infer<typeof PresetSchema>;

// ---- Components toggle ----

export const InitComponentsSchema = z.object({
  settings: z.boolean(),
  skills: z.boolean(),
  commands: z.boolean(),
  agents: z.boolean(),
  helpers: z.boolean(),
  mcp: z.boolean(),
  claudeMd: z.boolean(),
  /** Codex instruction file (AGENTS.md) — the cross-agent counterpart of claudeMd. */
  agentsMd: z.boolean(),
});
export type InitComponents = z.infer<typeof InitComponentsSchema>;

// ---- Hooks config ----

export const HooksConfigSchema = z.object({
  preToolUse: z.boolean(),
  postToolUse: z.boolean(),
  userPromptSubmit: z.boolean(),
  sessionStart: z.boolean(),
  stop: z.boolean(),
  subagentStop: z.boolean(),
  notification: z.boolean(),
  timeout: z.number().default(5000),
  continueOnError: z.boolean().default(true),
});
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

// ---- Hook rule model (D3 事件系统) ----

/** Claude Code 事件采集面（settings-gen 全集注册；是否响应由 daemon 规则开关决定）。 */
export const CLAUDE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'SubagentStop',
  'Notification',
] as const;

/**
 * 支持同步 `hookSpecificOutput.additionalContext` 注入的事件白名单——
 * inject 处理器只能挂在这里（官方 hooks 文档逐事件核实）。
 */
export const INJECTABLE_HOOK_EVENTS = [
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'SubagentStop',
] as const;

export const HookRuleSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claude-event'), event: z.string().min(1) }),
  /** 二期占位：外部系统 ingress，一期 schema 预留但不实现入口。 */
  z.object({ kind: z.literal('webhook'), routeId: z.string().min(1) }),
]);
export type HookRuleSource = z.infer<typeof HookRuleSourceSchema>;

export const HookRuleFilterSchema = z.object({
  /** 匹配 toolInput 的工具名（PostToolUse/PreToolUse 事件）。 */
  toolNames: z.array(z.string().min(1)).optional(),
  /** 匹配 toolInput.file_path 的 glob（posix 分隔符），如 md 文件或 docs 目录前缀。 */
  pathGlobs: z.array(z.string().min(1)).optional(),
  /** 只在 file_path/cwd 命中「其他已注册项目根」时触发（多项目交互识别）。 */
  crossProjectOnly: z.boolean().optional(),
});
export type HookRuleFilter = z.infer<typeof HookRuleFilterSchema>;

export const HandlerConfigSchema = z.discriminatedUnion('type', [
  /** 只记账 + SSE 通知，不入指令池（高频事件防写放大）。 */
  z.object({ type: z.literal('log') }),
  /** 出站 POST 转发到外部系统；body 为事件摘要，secret 用于 HMAC 签名头。 */
  z.object({
    type: z.literal('webhook'),
    url: z.string().url(),
    secret: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  /** 渲染指令入池（status=injected）并同步注入当前会话（additionalContext）。 */
  z.object({ type: z.literal('inject'), template: z.string().min(1) }),
  /** 只入池（status=pending），等 dashboard 复制 / 拖到会话执行。 */
  z.object({ type: z.literal('manual'), template: z.string().min(1) }),
]);
export type HandlerConfig = z.infer<typeof HandlerConfigSchema>;

export const HookRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  /** 数值越大越先匹配。 */
  priority: z.number().int(),
  /** null = 全局规则（对所有注册项目生效）。 */
  projectId: z.number().int().nullable(),
  source: HookRuleSourceSchema,
  filter: HookRuleFilterSchema.default({}),
  handler: HandlerConfigSchema,
  timeoutMs: z.number().int().positive().default(10_000),
  /** 是否落 hook_dispatches（log 默认 false）。 */
  record: z.boolean().default(true),
});
export type HookRule = z.infer<typeof HookRuleSchema>;

export const HookDispatchStatusSchema = z.enum([
  'pending',
  'injected',
  'running',
  'succeeded',
  'failed',
  'timeout',
]);
export type HookDispatchStatus = z.infer<typeof HookDispatchStatusSchema>;

export const HookDispatchModeSchema = z.enum(['auto', 'manual']);
export type HookDispatchMode = z.infer<typeof HookDispatchModeSchema>;

// ---- Skills categories ----

export const SkillsConfigSchema = z.object({
  core: z.boolean(),
});
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

// ---- Commands categories ----

export const CommandsConfigSchema = z.object({
  core: z.boolean(),
});
export type CommandsConfig = z.infer<typeof CommandsConfigSchema>;

// ---- Agents categories ----

export const AgentsConfigSchema = z.object({
  core: z.boolean(),
});
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

// ---- MCP config ----

export const MCPConfigSchema = z.object({
  weave: z.boolean(),
  autoStart: z.boolean().default(false),
});
export type MCPConfig = z.infer<typeof MCPConfigSchema>;

// ---- Runtime config ----

export const RuntimeConfigSchema = z.object({
  initVersion: z.string(),
  initTimestamp: z.string(),
  preset: PresetSchema,
  components: InitComponentsSchema,
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

// ---- Platform info ----

export const PlatformInfoSchema = z.object({
  os: z.enum(['windows', 'darwin', 'linux']),
  arch: z.enum(['x64', 'arm64']),
  nodeVersion: z.string(),
  shell: z.enum(['powershell', 'cmd', 'bash', 'zsh', 'sh']),
  homeDir: z.string(),
  configDir: z.string(),
});
export type PlatformInfo = z.infer<typeof PlatformInfoSchema>;

// ---- Init options (input) ----

export const InitOptionsSchema = z.object({
  targetDir: z.string().default(process.cwd()),
  force: z.boolean().default(false),
  interactive: z.boolean().default(true),
  preset: PresetSchema.default('default'),
  components: InitComponentsSchema.partial().default({}),
  hooks: HooksConfigSchema.partial().default({}),
  skills: SkillsConfigSchema.partial().default({}),
  commands: CommandsConfigSchema.partial().default({}),
  agents: AgentsConfigSchema.partial().default({}),
  mcp: MCPConfigSchema.partial().default({}),
});
export type InitOptions = z.infer<typeof InitOptionsSchema>;

// ---- Init result ----

export const InitResultSchema = z.object({
  success: z.boolean(),
  platform: PlatformInfoSchema,
  created: z.object({
    directories: z.array(z.string()),
    files: z.array(z.string()),
  }),
  skipped: z.array(z.string()),
  /** Existing user files that were merged into (append-only, user content preserved) */
  merged: z.array(z.string()),
  /** Weave-owned files overwritten in place (.weave/, marked helpers) */
  updated: z.array(z.string()),
  errors: z.array(z.string()),
  /** weave 按标记清扫移除的遗留生成物（如旧版 helper 脚本）。 */
  removed: z.array(z.string()),
  summary: z.object({
    skillsCount: z.number(),
    commandsCount: z.number(),
    agentsCount: z.number(),
    hooksEnabled: z.number(),
  }),
});
export type InitResult = z.infer<typeof InitResultSchema>;

// ---- Preset constants ----

export const MINIMAL_COMPONENTS: InitComponents = {
  settings: true,
  skills: true,
  commands: false,
  agents: false,
  helpers: false,
  mcp: false,
  claudeMd: true,
  agentsMd: true,
};

export const DEFAULT_COMPONENTS: InitComponents = {
  settings: true,
  skills: true,
  commands: false,
  agents: false,
  helpers: true,
  mcp: true,
  claudeMd: true,
  agentsMd: true,
};

export const FULL_COMPONENTS: InitComponents = {
  settings: true,
  skills: true,
  commands: true,
  agents: true,
  helpers: true,
  mcp: true,
  claudeMd: true,
  agentsMd: true,
};

export const DEFAULT_HOOKS: HooksConfig = {
  // 采集面全开（hook-handler 恒 exit 0，只上报不动作）；是否响应由 daemon
  // 规则开关决定，两者分离使开关语义单一。weave init --hooks 可裁剪。
  preToolUse: true,
  postToolUse: true,
  userPromptSubmit: true,
  sessionStart: true,
  stop: true,
  subagentStop: true,
  notification: true,
  timeout: 5000,
  continueOnError: true,
};

export const DEFAULT_SKILLS: SkillsConfig = { core: true };
export const DEFAULT_COMMANDS: CommandsConfig = { core: true };
export const DEFAULT_AGENTS: AgentsConfig = { core: true };
export const DEFAULT_MCP: MCPConfig = { weave: false, autoStart: false };

/** Merge preset with user overrides to produce final InitComponents */
export function resolveComponents(
  preset: Preset,
  overrides?: Partial<InitComponents>,
): InitComponents {
  const base = preset === 'minimal'
    ? MINIMAL_COMPONENTS
    : preset === 'full'
      ? FULL_COMPONENTS
      : DEFAULT_COMPONENTS;
  return overrides ? { ...base, ...overrides } : { ...base };
}
