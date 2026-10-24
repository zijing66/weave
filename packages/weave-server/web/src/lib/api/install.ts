/** 安装域：单文件资产类别、安装请求体、能力矩阵与 MCP 配置表示。 */

import type { Harness } from '@weavecode/core/harness';
import type { EnableOverride, ToolStateRow } from '@weavecode/core/tool';
import { apiFetch, API_BASE } from './client';
import type { AssetAgent } from './assets';

/** Single-file harness assets (command/agent/workflow/rule/output-style). */
export type FileAssetCategory = 'command' | 'agent' | 'workflow' | 'rule' | 'output-style';

export const FILE_ASSET_CATEGORIES: FileAssetCategory[] = [
  'command',
  'agent',
  'workflow',
  'rule',
  'output-style',
];

export interface InstallBody {
  category: 'skill' | 'mcp' | 'plugin' | FileAssetCategory;
  name: string;
  sourceDir?: string;
  /** Template file (library-relative or absolute) for file assets. */
  sourceFile?: string;
  mcpConfig?: McpServerConfig;
  scope?: 'project' | 'user';
  agent?: AssetAgent;
  /** plugin 类别：无 manifest 包合成最小 plugin.json 用（版本/描述）。 */
  version?: string;
  description?: string;
}

export type AssetScope = 'project' | 'user';

/** Mirror of server `install/capabilities.ts`（安装属性矩阵唯一事实源在服务端）。 */
export type InstallCategory = 'skill' | 'mcp' | FileAssetCategory;

export interface CategoryCapability {
  surfaces: Array<{
    harness: AssetAgent;
    scopes: AssetScope[];
    /** 各 scope 的安装落点显示形（服务端经资产面派生；范围落点提示按此渲染）。 */
    dest?: Partial<Record<AssetScope, string>>;
  }>;
}

/** 某 harness 的 statusline 面；缺席 = 没有 statusline 概念。 */
export interface StatuslineCapability {
  harness: AssetAgent;
  /** `injectable` = 宿主 TUI 能跑 weave 生成的脚本。 */
  tui: 'injectable' | 'none';
  segments: string[];
}

export interface InstallCapabilities {
  categories: Record<InstallCategory, CategoryCapability>;
  statusline: StatuslineCapability[];
  /** 有配置文件接管面的 harness（服务端由 config 槽派生）。 */
  config: Harness[];
}

/** mirror of harness `McpServerConfig`：stdio（command）| Streamable HTTP（url）。 */
export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface McpHttpConfig {
  url: string;
  type?: string;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
}
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/** MCP 工具行：模型协议 ToolStateRow，服务端 readMcpRows 装配；本路由的行恒带 detail（服务器配置）。 */
export type McpRow = ToolStateRow<McpServerConfig> & { detail: McpServerConfig };

export interface ProjectFile {
  path: string;
  content: string;
  size: number;
}

export const installApi = {
  /** 安装属性矩阵（服务端 install/capabilities.ts 派生；拖拽/点击禁用共用）。 */
  capabilities: (): Promise<InstallCapabilities> =>
    apiFetch<InstallCapabilities>('/capabilities'),

  // --- install / uninstall ---
  install: (projectId: number, body: InstallBody): Promise<Response> =>
    fetch(`${API_BASE}/projects/${projectId}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** 安装 daemon 托管的内置 MCP（只写 user 档；令牌由服务端填，不回显）。 */
  installBuiltinMcp: (
    projectId: number,
    name: string,
    agent?: AssetAgent,
  ): Promise<{ ok: boolean }> =>
    apiFetch(`/projects/${projectId}/mcp/builtin`, {
      method: 'POST',
      body: JSON.stringify({ name, agent }),
    }),
  uninstall: (projectId: number, body: InstallBody): Promise<Response> =>
    fetch(`${API_BASE}/projects/${projectId}/uninstall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // --- file reader / mcp ---
  readFile: (projectId: number, relPath: string): Promise<ProjectFile> =>
    apiFetch<ProjectFile>(
      `/projects/${projectId}/file?path=${encodeURIComponent(relPath)}`,
    ),
  /** Read a machine-level harness file (same allowed roots as readFile). */
  readGlobalFile: (relPath: string): Promise<ProjectFile> =>
    apiFetch<ProjectFile>(`/global-file?path=${encodeURIComponent(relPath)}`),
  /** 每行一个 (harness, scope) 面，enable/effective/installScopes 由服务端算好。 */
  listMcp: (projectId: number): Promise<McpRow[]> =>
    apiFetch<{ rows: McpRow[] }>(`/projects/${projectId}/mcp`).then((r) => r.rows),
  putMcpEnable: (projectId: number, name: string, state: EnableOverride): Promise<{ ok: boolean }> =>
    apiFetch<{ ok: boolean }>(`/projects/${projectId}/mcp/enable`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, state }),
    }),
};
