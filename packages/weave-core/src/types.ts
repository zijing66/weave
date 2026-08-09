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
});
export type InitComponents = z.infer<typeof InitComponentsSchema>;

// ---- Hooks config ----

export const HooksConfigSchema = z.object({
  preToolUse: z.boolean(),
  postToolUse: z.boolean(),
  userPromptSubmit: z.boolean(),
  sessionStart: z.boolean(),
  stop: z.boolean(),
  notification: z.boolean(),
  timeout: z.number().default(5000),
  continueOnError: z.boolean().default(true),
});
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

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
  errors: z.array(z.string()),
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
};

export const DEFAULT_COMPONENTS: InitComponents = {
  settings: true,
  skills: true,
  commands: false,
  agents: false,
  helpers: true,
  mcp: true,
  claudeMd: true,
};

export const FULL_COMPONENTS: InitComponents = {
  settings: true,
  skills: true,
  commands: true,
  agents: true,
  helpers: true,
  mcp: true,
  claudeMd: true,
};

export const DEFAULT_HOOKS: HooksConfig = {
  preToolUse: true,
  postToolUse: true,
  userPromptSubmit: false,
  sessionStart: true,
  stop: false,
  notification: false,
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
