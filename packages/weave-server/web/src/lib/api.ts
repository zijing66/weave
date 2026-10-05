/**
 * Daemon API client. All routes are prefixed with /api — in dev the Vite proxy
 * strips /api and forwards to the daemon; in production the daemon strips /api
 * itself and statically hosts the SPA for everything else.
 */

import type { Harness } from '@weave/core/harness';

/**
 * The daemon token.
 *
 * Read from `?token=` first, falling back to the value baked in at build time.
 * The query param matters because the build-time value is a fixed default while
 * `weave daemon start` mints a random token per machine — `weave dashboard`
 * opens the console with the running daemon's own token, so the two always
 * agree. (`/events` uses the same param because EventSource cannot set headers.)
 */
function resolveToken(): string {
  if (typeof window !== 'undefined') {
    const fromUrl = new URLSearchParams(window.location.search).get('token');
    if (fromUrl) return fromUrl;
  }
  return import.meta.env.V_DAEMON_TOKEN;
}

const TOKEN = resolveToken();
const BASE = '/api';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

/** 错误信息取 daemon 的 {error|message} 字段；非 JSON / 无字段回落状态码+原文。 */
async function errorText(res: Response): Promise<string> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // 非 JSON 错误体（代理/网络层）→ 保留状态码前缀
  }
  return body ? `${res.status} ${body}` : String(res.status);
}

export interface ProjectRow {
  id: number;
  path: string;
  name: string;
  token: string;
  source: string;
  registeredAt: string;
  lastSeenAt: string | null;
  meta: string | null;
}

/** Structured result of one harness health check (core 返回，文案由 web 词典渲染). */
export interface HarnessCheck {
  id: string;
  params: Record<string, string | boolean>;
  ok: boolean;
}

export type AssetAgent = Harness;

export interface AssetEntry {
  absPath: string;
  relPath: string;
  category: string;
  mtimeMs: number;
  /** Which coding agent's harness surface this asset belongs to. */
  agent?: AssetAgent;
  /** True when the file itself is a symbolic link (its target is watched). */
  isSymlink?: boolean;
}

export interface AssetChangeEvent {
  projectPath: string;
  projectName: string;
  category: string;
  relPath: string;
  absPath: string;
  kind: 'add' | 'change' | 'unlink';
  agent?: AssetAgent;
  /** True when the file itself is a symbolic link (its target is watched). */
  isSymlink?: boolean;
}

export interface HookEventRow {
  id: number;
  projectId: number;
  source: string;
  eventType: string;
  sessionId: string | null;
  payload: string;
  createdAt: string;
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
  | { type: 'plugin'; pluginId: string; handlerType: string; config?: Record<string, unknown> };

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
  scope: 'builtin' | 'global' | 'project';
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
  provenance: 'builtin' | 'external-dir';
  sourceRoot: string;
  targets: string[];
  kind: 'skill' | 'hook' | 'mod' | 'rule' | 'surface';
  components: string[];
  ccPack: boolean;
  weavePack: boolean;
  skills: string[];
  enabled: boolean;
  weave?: { status: 'active' | 'rejected' | 'disabled'; ruleCount: number; error?: string };
}

/** mirror of server `ToolkitListResult` / `ToolkitToggleResult`。 */
export interface ToolkitListResult {
  packs: ToolkitPack[];
  dirs: string[];
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

/** mirror of `SessionRow` in packages/weave-server/src/repositories/sessions.ts。 */
export interface SessionRow {
  sessionId: string;
  projectId: number | null;
  /** 已生效的自定义标题。 */
  title: string | null;
  /** dashboard 改名待生效：下次 SessionStart/UserPromptSubmit 时经 hook 下发。 */
  pendingTitle: string | null;
  lastSeenAt: string;
  createdAt: string;
  /** 该会话 hook 事件数（GET /sessions 的 listWithCounts 填充）。 */
  eventCount?: number;
  /** 会话归属 harness（最新事件 source；listWithCounts 填充，其余查询 undefined）。 */
  harness?: 'claude' | 'codex' | null;
  /** 回合开合服务端基线：最后 UPS 晚于最后 Stop/SessionEnd（listWithCounts 填充）。 */
  turnOpen?: boolean;
}

/** mirror of `CLAUDE_HOOK_EVENTS` in packages/weave-core/src/types.ts — 同序。 */
export const CLAUDE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'SubagentStop',
  'Notification',
] as const;

/** mirror of `INJECTABLE_HOOK_EVENTS` — inject 处理器只允许这些事件（服务端 400）。 */
export const INJECTABLE_HOOK_EVENTS = [
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'SubagentStop',
] as const;


export interface LibraryRow {
  id: number;
  path: string;
  kind: 'skill' | 'mcp' | 'both';
  addedAt: string;
}

/** 资源市场清单行（GET /market）：libraries 行 + resolve 后有效路径 + 清单元数据。 */
export interface MarketItem {
  id: number;
  kind: LibraryRow['kind'];
  addedAt: string;
  /** resolve 后的有效绝对路径。 */
  path: string;
  /** 相对 dataDir 的 posix 形（外部源为 null）。 */
  relPath: string | null;
  /** 市场目录名（managed 资源）。 */
  resourceId: string | null;
  /** 是否收纳在 `<dataDir>/market/` 内。 */
  managed: boolean;
  /** 无清单 → legacy 外部/未收纳源（显示「迁入市场」）。 */
  legacy: boolean;
  source: 'git' | 'dir' | 'legacy';
  origin: string | null;
  importedAt: string | null;
  commit: string | null;
}

/** Browse starting point for the directory picker (home, drives, …). */
export interface BrowseRoot {
  path: string;
  kind:
    | 'home'
    | 'desktop'
    | 'downloads'
    | 'documents'
    | 'library-parent'
    | 'drive'
    | 'root';
}

/** One subdirectory of the currently browsed folder. */
export interface BrowseChild {
  name: string;
  path: string;
}

export interface SkillAsset {
  name: string;
  dirPath: string;
  relPath: string;
  /** Parent directory (typically a `skills/` folder) relative to the library root. */
  group: string;
}

export interface McpTemplate {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  sourcePath: string;
  relPath: string;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** MCP servers per surface: project (.mcp.json), global (~/.claude.json),
 * codex user-level (~/.codex/config.toml). */
export interface McpServerMap {
  project: Record<string, McpServerConfig>;
  global: Record<string, McpServerConfig>;
  codex: Record<string, McpServerConfig>;
}

/** Single-file harness assets (command/agent/workflow/rule/output-style). */
export type FileAssetCategory = 'command' | 'agent' | 'workflow' | 'rule' | 'output-style';

export const FILE_ASSET_CATEGORIES: FileAssetCategory[] = [
  'command',
  'agent',
  'workflow',
  'rule',
  'output-style',
];

/** A file template found inside a registered library. */
export interface FileAssetTemplate {
  name: string;
  /** Absolute path of the template file inside the library. */
  filePath: string;
  relPath: string;
  group: string;
  category: FileAssetCategory;
}

export interface InstallBody {
  category: 'skill' | 'mcp' | FileAssetCategory;
  name: string;
  sourceDir?: string;
  /** Template file (library-relative or absolute) for file assets. */
  sourceFile?: string;
  mcpConfig?: McpServerConfig;
  scope?: 'project' | 'global';
  agent?: AssetAgent;
}

export type AssetScope = 'project' | 'global';

export interface SkillUpdate {
  name: string;
  scope: AssetScope;
  outdated: boolean;
  custom: boolean;
  sourceDir?: string;
  libraryId?: number;
  agent?: AssetAgent;
}

export interface FileAssetUpdate {
  name: string;
  category: FileAssetCategory;
  scope: AssetScope;
  outdated: boolean;
  custom: boolean;
  sourceFile?: string;
  libraryId?: number;
}

export interface McpUpdate {
  name: string;
  scope: AssetScope;
  outdated: boolean;
  custom: boolean;
  libraryId?: number;
  /** 'codex' updates target ~/.codex/config.toml (always global scope). */
  agent?: AssetAgent;
}

export interface UpdateReport {
  skills: SkillUpdate[];
  files: FileAssetUpdate[];
  mcp: McpUpdate[];
  available: number;
}

/** Where a global skill was resolved from (grouping key in the global view). */
export type GlobalSkillSource =
  | 'claude-personal'
  | 'claude-plugin'
  | 'codex-personal'
  | 'codex-plugin';

/** A resolved skill directory (absolute path, may be a symlink target). */
export interface GlobalSkillEntry {
  name: string;
  dir: string;
}

/** A labelled group of global skills sharing a source. Plugin groups carry
 * enable state keyed `plugin@marketplace`; personal groups do not. */
export interface GlobalSkillGroup {
  source: GlobalSkillSource;
  label: string;
  skills: GlobalSkillEntry[];
  pluginKey?: string;
  enabled?: boolean;
}

/** Plugin enable map per runtime (Claude reads settings.json, Codex config.toml). */
export interface PluginEnabledMap {
  claude: Record<string, boolean>;
  codex: Record<string, boolean>;
}

export type PluginRuntime = Harness;

export type McpEnableState = 'enabled' | 'disabled' | 'default';

export interface McpEnableMap {
  overrides: Record<string, McpEnableState>;
  enableAll: boolean;
}

export interface ProjectConfig {
  autoSync: boolean;
  lastSyncAt: string | null;
}

/** Which terminal "open in terminal" launches; presets are platform-scoped. */
export type TerminalPreset =
  | 'auto'
  | 'wt'
  | 'powershell'
  | 'cmd'
  | 'terminal'
  | 'iterm'
  | 'gnome'
  | 'konsole'
  | 'wezterm'
  | 'ghostty'
  | 'custom';

export interface TerminalSettings {
  preset: TerminalPreset;
  /** Template for `custom`; `{path}` is replaced with the quoted directory. */
  customCommand: string;
}

/** mirror of packages/weave-server/src/daemon/settings.ts — 保持同步
 * （web 不能 import 含 node:fs 的 workspace 包，服务端 mergeDefaults
 * 白名单会把非法值规范化，漂移可自愈）。 */
export type Locale = 'zh-CN' | 'en';

export interface DaemonSettings {
  terminal: TerminalSettings;
  locale: Locale;
  /** mirror of packages/weave-server/src/daemon/settings.ts — 保持同步。 */
  hooks: { enabled: boolean };
}

export interface TerminalPresetMeta {
  id: TerminalPreset;
  label: string;
}

export interface DaemonSettingsBundle {
  settings: DaemonSettings;
  presets: TerminalPresetMeta[];
  platform: string;
}

export interface ProjectFile {
  path: string;
  content: string;
  size: number;
}

export type StatuslineNamedColor =
  | 'gray'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan';

/**
 * Mirror of `StatuslineColor` in packages/weave-server/src/statusline/config.ts.
 * The web app does not depend on @weave/server, so this file is a hand-copied
 * duplicate — keep the two in lockstep (a mismatch breaks `tsc && vite build`).
 * A colour is a named ANSI colour, `ansi256:0-255`, or `#rgb`/`#rrggbb`.
 */
export type StatuslineColor = StatuslineNamedColor | `ansi256:${number}` | `#${string}`;

/** The seven classic ANSI names, in palette order. */
export const NAMED_COLORS: readonly StatuslineNamedColor[] = [
  'gray',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
];

export type SegmentKey =
  | 'project'
  | 'git'
  | 'changes'
  | 'model'
  | 'thinking'
  | 'context'
  | 'tokens'
  | 'cost'
  | 'rate'
  | 'time'
  | 'version'
  | 'output_style'
  | 'session'
  | 'exceeds200k'
  | 'fast_mode'
  | 'vim'
  | 'pr'
  | 'worktree'
  | 'agent';

export interface StatuslineSegment {
  enabled: boolean;
  color: StatuslineColor;
  bold: boolean;
  /** Optional emoji/symbol prefix (e.g. `🤖`, `🌿`, `📁`). Empty when unused. */
  icon: string;
  /** Solid background block colour; `null` for foreground only. */
  backgroundColor: StatuslineColor | null;
  /** Join this segment into the next block (no gap, inherited background). */
  merge: boolean;
  /** Context-bar display mode; ignored by other segments. */
  style?: 'percent' | 'bar' | 'both';
  /** Static prefix, rendered as `<label><labelSeparator><value>`. */
  label?: string;
  /** `{token}` value template; replaces the built-in formatting when set. */
  format?: string;
  /** `tokens` only: session-cumulative or context-window count. */
  metric?: 'session' | 'context';
  /** Which rate-limit window `rate` reports; ignored by other segments. */
  window?: 'five_hour' | 'seven_day' | 'spend';
}

/** Progress-bar appearance; global rather than per-segment. */
export interface StatuslineBar {
  cells: number;
  fill: string;
  empty: string;
}

export type StatuslineAlign = 'left' | 'center' | 'right';
export type StatuslineSource = 'global' | 'custom';

/**
 * Mirror of `WEAVE_VERSION` in packages/weave-server/src/version.ts — the web
 * app stamps the same version into the logo preview as the generator does.
 * Keep in lockstep with that file and the workspace package manifests.
 */
export const WEAVE_VERSION = '0.1.0';

export interface StatuslineConfig {
  separator: string;
  align: StatuslineAlign;
  /** Row-0 logo text, rendered as `<logoText> v<version>`. Not optional. */
  logoText: string;
  logoColor: StatuslineColor;
  /** Nerd-Font glyph set; `undefined` = classic triangle defaults, '' disables a cap. */
  powerline: { enabled: boolean; separator?: string; startCap?: string; endCap?: string };
  /** Ordered rows; each row is the left-to-right segment order of that line. */
  lines: SegmentKey[][];
  /** Seconds between Claude Code re-runs of the script (min 1). */
  refreshInterval: number;
  /** Follow the global template, or keep a project-local config. */
  source: StatuslineSource;
  /** Progress-bar appearance, shared by every segment that draws a bar. */
  bar: StatuslineBar;
  /** Rendered between rows; an empty string (the default) draws nothing. */
  divider: string;
  /** Rendered between a segment's `label` and its value. */
  labelSeparator: string;
  segments: Record<SegmentKey, StatuslineSegment>;
}

/** Mirror of `SEGMENT_TOKENS` in the server's statusline/config.ts. */
export const SEGMENT_TOKENS: Record<SegmentKey, readonly string[]> = {
  project: ['name', 'path'],
  git: ['branch', 'repo'],
  changes: ['added', 'deleted', 'files'],
  model: ['model'],
  thinking: ['level'],
  context: ['bar', 'used', 'total', 'percent', 'remaining'],
  tokens: ['total', 'percent'],
  cost: ['cost', 'duration', 'api_duration', 'lines_added', 'lines_removed'],
  rate: ['percent', 'limit', 'resets'],
  time: ['time'],
  version: ['version'],
  output_style: ['style'],
  session: ['name'],
  exceeds200k: ['over'],
  fast_mode: ['mode'],
  vim: ['mode'],
  pr: ['number', 'state', 'url'],
  worktree: ['name', 'branch'],
  agent: ['name'],
};

/** Mirror of `SEGMENT_DEFAULT_FORMAT` in the server's statusline/config.ts. */
export const SEGMENT_DEFAULT_FORMAT: Record<SegmentKey, string> = {
  project: '{name}',
  git: '{branch}',
  changes: '{files}',
  model: '{model}',
  thinking: '{level}',
  context: '{percent}% {bar}',
  tokens: '{total}',
  cost: '{cost}',
  rate: '{limit} {percent}%',
  time: '{time}',
  version: '{version}',
  output_style: '{style}',
  session: '{name}',
  exceeds200k: '{over}',
  fast_mode: '{mode}',
  vim: '{mode}',
  pr: '#{number}',
  worktree: '{name}',
  agent: '{name}',
};

/** Mirror of `CONTEXT_STYLE_FORMAT`: legacy `context.style` → template. */
export const CONTEXT_STYLE_FORMAT: Record<'percent' | 'bar' | 'both', string> = {
  percent: '{percent}%',
  bar: '{bar}',
  both: '{percent}% {bar}',
};

export const api = {
  listProjects: (): Promise<ProjectRow[]> =>
    apiFetch<{ projects: ProjectRow[] }>('/projects').then((r) => r.projects),
  listAssets: (projectPath: string): Promise<AssetEntry[]> =>
    apiFetch<{ projectPath: string; assets: AssetEntry[] }>(
      `/assets?path=${encodeURIComponent(projectPath)}`,
    ).then((r) => r.assets),
  /** Machine-level harness files (~/.claude, ~/.codex) for the global tree. */
  listGlobalFileAssets: (): Promise<AssetEntry[]> =>
    apiFetch<{ assets: AssetEntry[] }>('/global-file-assets').then((r) => r.assets),
  /** 按会话查事件（时间升序，任务视图事件链用）。projectId 仅作鉴权锚点。
   *  `beforeId` 游标翻页：只取比游更早的事件（组头「加载更早」向前翻）。 */
  listSessionHooks: (
    projectId: number,
    sessionId: string,
    limit = 300,
    beforeId?: number,
  ): Promise<HookEventRow[]> =>
    apiFetch<{ events: HookEventRow[] }>(
      `/projects/${projectId}/hooks?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}${
        beforeId === undefined ? '' : `&beforeId=${beforeId}`
      }`,
    ).then((r) => r.events),

  // --- hooks rules / dispatches / sessions ---
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
  listToolkitDirs: (): Promise<{ dirs: string[]; indexes: string[] }> =>
    apiFetch<{ dirs: string[]; indexes: string[] }>('/toolkit/dirs'),
  addToolkitDir: (path: string): Promise<{ dirs: string[] }> =>
    apiFetch<{ dirs: string[] }>('/toolkit/dirs', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  removeToolkitDir: (path: string): Promise<{ dirs: string[]; disabled: string[] }> =>
    apiFetch<{ dirs: string[]; disabled: string[] }>('/toolkit/dirs/remove', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
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
  /** 不带 projectId 返回全部会话（最近活跃在前，最多 200 条）。 */
  listSessions: (projectId?: number): Promise<SessionRow[]> =>
    apiFetch<{ sessions: SessionRow[] }>(
      `/sessions${projectId === undefined ? '' : `?projectId=${projectId}`}`,
    ).then((r) => r.sessions),
  /** dashboard 改名：写 pendingTitle，下次 hook 下发时生效。 */
  renameSession: (sessionId: string, title: string): Promise<SessionRow> =>
    apiFetch<{ session: SessionRow }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'PATCH', body: JSON.stringify({ title }) },
    ).then((r) => r.session),

  // --- libraries (asset sources) ---
  listLibraries: (): Promise<LibraryRow[]> =>
    apiFetch<{ libraries: LibraryRow[] }>('/libraries').then((r) => r.libraries),
  addLibrary: (path: string, kind: LibraryRow['kind']): Promise<LibraryRow> =>
    apiFetch<LibraryRow>('/libraries', {
      method: 'POST',
      body: JSON.stringify({ path, kind }),
    }),
  removeLibrary: (id: number): Promise<void> =>
    apiFetch<{ ok: boolean }>(`/libraries/${id}`, { method: 'DELETE' }).then(
      () => undefined,
    ),

  // --- 资源市场（批 9） ---
  listMarket: (): Promise<MarketItem[]> =>
    apiFetch<{ items: MarketItem[] }>('/market').then((r) => r.items),
  /** 本地目录引入（复制进 `<dataDir>/market/`）。 */
  importMarketDir: (path: string): Promise<MarketItem> =>
    apiFetch<{ item: MarketItem }>('/market', {
      method: 'POST',
      body: JSON.stringify({ kind: 'dir', path }),
    }).then((r) => r.item),
  /** git URL 导入（clone 进市场）。 */
  importMarketGit: (url: string): Promise<MarketItem> =>
    apiFetch<{ item: MarketItem }>('/market', {
      method: 'POST',
      body: JSON.stringify({ kind: 'git', url }),
    }).then((r) => r.item),
  /** 删除市场资源（只删市场目录与行，装面副本不级联）。 */
  removeMarket: (id: number): Promise<void> =>
    apiFetch<{ ok: boolean }>(`/market/${id}`, { method: 'DELETE' }).then(() => undefined),
  /** legacy 外部源显式迁入市场（复制 + 改写为相对路径）。 */
  migrateLibrary: (id: number): Promise<MarketItem> =>
    apiFetch<{ item: MarketItem }>(`/libraries/${id}/market-import`, {
      method: 'POST',
    }).then((r) => r.item),
  /** Cross-platform browse roots for the directory picker modal. */
  listFsRoots: (): Promise<BrowseRoot[]> =>
    apiFetch<{ roots: BrowseRoot[] }>('/fs/roots').then((r) => r.roots),
  /** Subdirectories of a folder (lazy-loaded one level per call). */
  listFsChildren: (dirPath: string): Promise<BrowseChild[]> =>
    apiFetch<{ children: BrowseChild[] }>(
      `/fs/children?path=${encodeURIComponent(dirPath)}`,
    ).then((r) => r.children),

  // --- install / uninstall ---
  install: (projectId: number, body: InstallBody): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),
  uninstall: (projectId: number, body: InstallBody): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/uninstall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),

  // --- file reader / mcp / statusline ---
  readFile: (projectId: number, relPath: string): Promise<ProjectFile> =>
    apiFetch<ProjectFile>(
      `/projects/${projectId}/file?path=${encodeURIComponent(relPath)}`,
    ),
  /** Read a machine-level harness file (same allowed roots as readFile). */
  readGlobalFile: (relPath: string): Promise<ProjectFile> =>
    apiFetch<ProjectFile>(`/global-file?path=${encodeURIComponent(relPath)}`),
  /** Returns project-scope (.mcp.json), global-scope (~/.claude.json) and
   * Codex user-level (~/.codex/config.toml) MCP servers. */
  listMcp: (projectId: number): Promise<McpServerMap> =>
    apiFetch<McpServerMap>(`/projects/${projectId}/mcp`),
  getStatusline: (
    projectId: number,
  ): Promise<{ config: StatuslineConfig; script: string; globalConfig: StatuslineConfig }> =>
    apiFetch<{ config: StatuslineConfig; script: string; globalConfig: StatuslineConfig }>(
      `/projects/${projectId}/statusline`,
    ),
  putStatusline: (projectId: number, config: StatuslineConfig): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/statusline`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(config),
    }),
  /** Shipped factory defaults for the statusline panel's 恢复出厂. */
  getFactoryStatusline: (): Promise<StatuslineConfig> =>
    apiFetch<{ config: StatuslineConfig }>('/statusline/default').then((r) => r.config),
  putGlobalStatusline: (config: StatuslineConfig): Promise<Response> =>
    fetch(`${BASE}/statusline/global`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(config),
    }),

  // --- updates / sync / global scope / mcp enable ---
  listUpdates: (projectId: number): Promise<UpdateReport> =>
    apiFetch<UpdateReport>(`/projects/${projectId}/updates`),
  updateAsset: (
    projectId: number,
    body: {
      category: 'skill' | 'mcp' | FileAssetCategory;
      name: string;
      scope: AssetScope;
      agent?: AssetAgent;
    },
  ): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),
  syncAll: (projectId: number): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/sync-all`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }),
  listGlobalSkills: (projectId: number): Promise<GlobalSkillGroup[]> =>
    apiFetch<{ groups: GlobalSkillGroup[] }>(`/projects/${projectId}/skills/global`).then(
      (r) => r.groups,
    ),
  /** List files inside a global skill directory (symlinks followed). The skill
   * is identified by source + name (+ pluginKey for plugins) so the server
   * resolves the dir — the client never supplies an arbitrary path. */
  listGlobalSkillFiles: (
    projectId: number,
    q: { source: GlobalSkillSource; name: string; pluginKey?: string },
  ): Promise<AssetEntry[]> => {
    const params = new URLSearchParams({ source: q.source, name: q.name });
    if (q.pluginKey) params.set('pluginKey', q.pluginKey);
    return apiFetch<{ files: AssetEntry[] }>(
      `/projects/${projectId}/skills/global/files?${params}`,
    ).then((r) => r.files);
  },
  /** Read a file inside a global skill directory (path relative to the skill). */
  readGlobalSkillFile: (
    projectId: number,
    q: { source: GlobalSkillSource; name: string; pluginKey?: string; path: string },
  ): Promise<ProjectFile> => {
    const params = new URLSearchParams({ source: q.source, name: q.name, path: q.path });
    if (q.pluginKey) params.set('pluginKey', q.pluginKey);
    return apiFetch<ProjectFile>(`/projects/${projectId}/skills/global/file?${params}`);
  },
  getPluginEnabled: (projectId: number): Promise<PluginEnabledMap> =>
    apiFetch<PluginEnabledMap>(`/projects/${projectId}/plugins/enabled`),
  putPluginEnabled: (
    projectId: number,
    body: { runtime: PluginRuntime; key: string; enabled: boolean },
  ): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/plugins/enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),
  getMcpEnable: (projectId: number): Promise<McpEnableMap> =>
    apiFetch<McpEnableMap>(`/projects/${projectId}/mcp/enable`),
  putMcpEnable: (
    projectId: number,
    name: string,
    state: McpEnableState,
  ): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/mcp/enable`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name, state }),
    }),
  getProjectConfig: (projectId: number): Promise<ProjectConfig> =>
    apiFetch<ProjectConfig>(`/projects/${projectId}/config`),
  /** Structured harness health checks (read-only; 批 8). */
  getHarnessChecks: (projectId: number): Promise<{ checks: HarnessCheck[] }> =>
    apiFetch<{ checks: HarnessCheck[] }>(`/projects/${projectId}/harness-checks`),
  /** Open a project directory in the OS file manager or a terminal. */
  openProject: (
    projectId: number,
    target: 'explorer' | 'terminal',
  ): Promise<{ ok: boolean; target: string; path: string }> =>
    apiFetch<{ ok: boolean; target: string; path: string }>(
      `/projects/${projectId}/open`,
      {
        method: 'POST',
        body: JSON.stringify({ target }),
      },
    ),
  /** Daemon-level settings (terminal preset) plus this platform's options. */
  getDaemonSettings: (): Promise<DaemonSettingsBundle> =>
    apiFetch<DaemonSettingsBundle>('/settings'),
  putDaemonSettings: (settings: DaemonSettings): Promise<DaemonSettings> =>
    apiFetch<DaemonSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  putProjectConfig: (projectId: number, config: ProjectConfig): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(config),
    }),
  listLibraryAssets: (
    id: number,
  ): Promise<{
    library: LibraryRow;
    skills: SkillAsset[];
    files: FileAssetTemplate[];
    mcp: McpTemplate[];
  }> =>
    apiFetch<{
      library: LibraryRow;
      skills: SkillAsset[];
      files: FileAssetTemplate[];
      mcp: McpTemplate[];
    }>(`/libraries/${id}/assets`),

  /** EventSource cannot set headers; pass the token as a query param instead. */
  eventsUrl: (): string => `${BASE}/events?token=${encodeURIComponent(TOKEN)}`,
};
