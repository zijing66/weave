/**
 * Daemon API client. All routes are prefixed with /api — in dev the Vite proxy
 * strips /api and forwards to the daemon; in production the daemon strips /api
 * itself and statically hosts the SPA for everything else.
 */

const TOKEN = import.meta.env.V_DAEMON_TOKEN;
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
}

export interface AssetChangeEvent {
  projectPath: string;
  projectName: string;
  category: string;
  relPath: string;
  absPath: string;
  kind: 'add' | 'change' | 'unlink';
  agent?: AssetAgent;
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
  | 'custom';

export interface TerminalSettings {
  preset: TerminalPreset;
  /** Template for `custom`; `{path}` is replaced with the quoted directory. */
  customCommand: string;
}

export interface DaemonSettings {
  terminal: TerminalSettings;
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

export type StatuslineColor =
  | 'gray'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan';

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
  | 'time';

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
}

export type StatuslineAlign = 'left' | 'center' | 'right';
export type StatuslineSource = 'global' | 'custom';

export interface StatuslineConfig {
  separator: string;
  align: StatuslineAlign;
  showLogo: boolean;
  logoText: string;
  logoColor: StatuslineColor;
  powerline: { enabled: boolean };
  /** Ordered rows; each row is the left-to-right segment order of that line. */
  lines: SegmentKey[][];
  /** Seconds between Claude Code re-runs of the script (min 1). */
  refreshInterval: number;
  /** Follow the global template, or keep a project-local config. */
  source: StatuslineSource;
  segments: Record<SegmentKey, StatuslineSegment>;
}

export const api = {
  listProjects: (): Promise<ProjectRow[]> =>
    apiFetch<{ projects: ProjectRow[] }>('/projects').then((r) => r.projects),
  listAssets: (projectPath: string): Promise<AssetEntry[]> =>
    apiFetch<{ projectPath: string; assets: AssetEntry[] }>(
      `/assets?path=${encodeURIComponent(projectPath)}`,
    ).then((r) => r.assets),
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
  /** Returns project-scope (.mcp.json) and global-scope (~/.claude.json) servers. */
  listMcp: (
    projectId: number,
  ): Promise<{ project: Record<string, McpServerConfig>; global: Record<string, McpServerConfig> }> =>
    apiFetch<{ project: Record<string, McpServerConfig>; global: Record<string, McpServerConfig> }>(
      `/projects/${projectId}/mcp`,
    ),
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
