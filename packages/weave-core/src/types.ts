import { z } from 'zod';
import { HARNESS_EVENTS, HARNESS_NAMES, INJECTABLE_EVENTS, type Harness } from './harness.js';

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

/**
 * 兼容 re-export（CROSS §2.2）：存量 import 路径不变，
 * 实际表已下沉 `harness.ts` 的 `HARNESS_EVENTS.claude`。
 */
export const CLAUDE_HOOK_EVENTS = HARNESS_EVENTS.claude;
/** 兼容 re-export：`INJECTABLE_EVENTS.claude`。 */
export const INJECTABLE_HOOK_EVENTS = INJECTABLE_EVENTS.claude;

/**
 * harness 值域 schema：**唯一来源 = `harness.ts` 名单表**（加 harness 不动
 * 本文件）。`HarnessName` 用于纯 harness 字段，`HarnessOrAny` 用于可跨
 * harness 的规则字段（'any' 语义见 HookRuleSourceSchema）。
 */
const HarnessName = z.enum(HARNESS_NAMES);
const HarnessOrAny = z.enum([...HARNESS_NAMES, 'any'] as const);

export const HookRuleSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hook-event'),
    harness: HarnessOrAny,
    event: z.string().min(1),
  }),
  /** 二期占位：外部系统 ingress，一期 schema 预留但不实现入口。 */
  z.object({ kind: z.literal('webhook'), routeId: z.string().min(1) }),
  /**
   * 读兼容分支：存量 hook_rules.source 里的 'claude-event'。
   * 读侧经 `normalizeHookRuleSource` 内存转换为 hook-event（不写迁移脚本，
   * 下次 update 落新形）；写侧在 create/validate 入口同样先 normalize。
   */
  z.object({ kind: z.literal('claude-event'), event: z.string().min(1) }),
]);
export type HookRuleSource = z.infer<typeof HookRuleSourceSchema>;

/** 读/写侧统一 normalize：legacy 'claude-event' → 'hook-event'{harness:'claude'}。 */
export function normalizeHookRuleSource(source: HookRuleSource): HookRuleSource {
  if (source.kind === 'claude-event') {
    return { kind: 'hook-event', harness: 'claude', event: source.event };
  }
  return source;
}

/**
 * 规则声明的目标 harness：webhook 无 harness 语义返回 null；
 * legacy 形视作 'claude'。dispatcher 的 match 首行按此过滤。
 */
export function hookSourceHarness(source: HookRuleSource): Harness | 'any' | null {
  if (source.kind === 'claude-event') return 'claude';
  if (source.kind === 'hook-event') return source.harness;
  return null;
}

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
  /** 插件自定义处理器：dispatcher 按 pluginId:handlerType 定位动态加载的
   * handler.mjs 并在同一条防线下执行（去重/超时/白名单/不影响 ingest）。 */
  z.object({
    type: z.literal('plugin'),
    pluginId: z.string().min(1),
    handlerType: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type HandlerConfig = z.infer<typeof HandlerConfigSchema>;

/** 规则来源标记（hook_rules.origin 列）：user=dashboard/CLI，plugin=插件目录，builtin=内置预设。 */
export const HookRuleOriginSchema = z.enum(['user', 'plugin', 'builtin']);
export type HookRuleOrigin = z.infer<typeof HookRuleOriginSchema>;

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
  /**
   * 单次执行上限。默认 5s：hook 是 Claude Code 的同步等待模型，规则预算必须
   * 明显小于宿主的 hook 窗口（否则一个慢处理器就会把会话卡到超时丢输出）。
   */
  timeoutMs: z.number().int().positive().default(5_000),
  /** 是否落 hook_dispatches（log 默认 false）。 */
  record: z.boolean().default(true),
  /** 来源标记；插件/预设规则由加载器 upsert，用户规则经 dashboard/CLI 创建。 */
  origin: HookRuleOriginSchema.default('user'),
  /** origin 为 plugin/builtin 时的插件 id；用户规则为 null。 */
  pluginId: z.string().min(1).nullable().default(null),
});
export type HookRule = z.infer<typeof HookRuleSchema>;

// ---- Weave 插件包规范（docs/PLUGIN-SPEC.md 的 schema 化，AI 按此生成插件目录）----

/** 插件包 manifest 文件名（约定位于插件根目录）。 */
export const WEAVE_PLUGIN_MANIFEST = 'weave-plugin.json';

/**
 * weave 注入消息的来源标记（唯一事实源：server 直投载荷用它当前缀，
 * `weave init` 生成的 CLAUDE.md 块用它向会话解释这个标记的含义）。
 * 直投路径把消息写成语义上的「用户消息」——会话分不出是手打还是控制台注入，
 * 这个标记 + CLAUDE.md 里的说明就是唯一的可见凭据。
 */
export const WEAVE_INJECTION_MARKER = '[weave] ';

/**
 * rules.json 的元素：完整 HookRule 去掉 id/projectId（加载器生成），
 * enabled 可省略（默认 true，但用户在 dashboard 的开关改动会被保留）。
 */
export const PluginRuleEntrySchema = HookRuleSchema.omit({
  id: true,
  projectId: true,
}).extend({ enabled: z.boolean().optional(), priority: z.number().int().optional() });
export type PluginRuleEntry = z.infer<typeof PluginRuleEntrySchema>;

export const WeavePluginManifestSchema = z.object({
  /** 规范版本；加载器只接受当前主版本。 */
  manifestVersion: z.literal(1),
  /** kebab-case 唯一 id（内置预设命名空间保留，用户同名插件 rejected）。 */
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  description: z.string().optional(),
  author: z.string().optional(),
  engines: z.object({ weave: z.string().optional() }).optional(),
  /** 规则文件（相对插件根目录的 posix 路径），元素须过 PluginRuleEntrySchema。 */
  rules: z.array(z.string().min(1)).default([]),
  /** 自定义处理器入口（相对路径；entry 由 loader 动态 import，路径必须留在插件目录内）。 */
  handlers: z
    .array(z.object({ type: z.string().min(1), entry: z.string().min(1) }))
    .default([]),
  /** 声明依赖的采集事件；未知事件名 → 加载 rejected。 */
  requires: z.object({ events: z.array(z.string().min(1)).optional() }).optional(),
  // ---- 扩展点（schema 先行，按批次落地消费方）----
  /** ③ skills/commands/agents 模板路径（相对插件根目录）。 */
  templates: z
    .object({
      skills: z.array(z.string().min(1)).optional(),
      commands: z.array(z.string().min(1)).optional(),
      agents: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /** ④ MCP server 定义（init mcp-gen 合并，键=server 名）。 */
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  /** ⑦ 事件流订阅（entry 导出 onEvent，daemon 转发 HookBus 帧）。 */
  subscribe: z
    .object({ events: z.array(z.string().min(1)), entry: z.string().min(1) })
    .optional(),
  /** ⑥ statusline 组件入口（后期）。 */
  statusline: z.object({ entry: z.string().min(1) }).optional(),
  /** 插件默认配置；用户经 plugin_states.config 覆写，合并后进 handler ctx.config。 */
  config: z.record(z.string(), z.unknown()).optional(),
});
export type WeavePluginManifest = z.infer<typeof WeavePluginManifestSchema>;

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
  /** 本次 init 选择的 harness 面（批 5 记录；旧文件无此字段 → undefined，向后兼容）。 */
  harnesses: z.array(HarnessName).optional(),
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
  /** `--harness` flag 解析结果：undefined = 未提供（走交互/默认三级优先级）。 */
  harnesses: z.array(HarnessName).optional(),
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
