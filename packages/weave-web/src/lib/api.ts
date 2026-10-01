/**
 * Daemon API client. All routes are prefixed with /api — in dev the Vite proxy
 * strips /api and forwards to the daemon; in production the daemon strips /api
 * itself and statically hosts the SPA for everything else.
 */

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
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
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

export type AssetAgent = 'claude' | 'codex';

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

export interface LibraryRow {
  id: number;
  path: string;
  kind: 'skill' | 'mcp' | 'both';
  addedAt: string;
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

export type PluginRuntime = 'claude' | 'codex';

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
  listHooks: (projectId: number): Promise<HookEventRow[]> =>
    apiFetch<{ events: HookEventRow[] }>(`/projects/${projectId}/hooks`).then(
      (r) => r.events,
    ),

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
  getGlobalStatusline: (): Promise<{ config: StatuslineConfig }> =>
    apiFetch<{ config: StatuslineConfig }>('/statusline/global'),
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
