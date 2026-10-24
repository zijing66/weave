/** 更新域：库内资产漂移报告、全局 skill 面与插件工具行。 */

import type { Harness } from '@weavecode/core/harness';
import type { EnableOverride, ToolScope, ToolStateRow } from '@weavecode/core/tool';
import { apiFetch, API_BASE } from './client';
import { HARNESS_ORDER } from '../harness-meta';
import type { AssetAgent, AssetEntry } from './assets';
import type { FileAssetCategory, ProjectFile } from './install';

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
  /** 'codex' updates target ~/.codex/config.toml (always user scope). */
  agent?: AssetAgent;
}

/** 项目自有 weave 源（`.weave/plugins` 的 manifest.templates）的物化副本。 */
export interface PluginTemplateUpdate {
  pluginId: string;
  name: string;
  outdated: boolean;
}

/** init 生成物：`syncClass` = `auto` 可代写、`manual` 会进 git（只报不写）。 */
export interface InitFileUpdate {
  relPath: string;
  outdated: boolean;
  syncClass: 'auto' | 'manual' | null;
}

export interface UpdateReport {
  skills: SkillUpdate[];
  files: FileAssetUpdate[];
  mcp: McpUpdate[];
  pluginTemplates: PluginTemplateUpdate[];
  initFiles: InitFileUpdate[];
  available: number;
  /** 会进 git 的 init 文件有漂移 → 提醒用户去终端跑 `weave init`（不代写）。 */
  needsInit: boolean;
}

/** 项目行推送面的一行摘要（与 UpdateReport 的同名两字同源）。 */
export interface ProjectUpdateSummary {
  available: number;
  needsInit: boolean;
}

/** Where a global skill was resolved from (grouping key in the global view).
 *  Derived from `Harness` so a new harness's personal/plugin groups slot in. */
export type GlobalSkillSource = `${Harness}-personal` | `${Harness}-plugin`;

/** GlobalSkillSource 的 harness 前缀（claude-personal → claude）——按名表前缀匹配，
 *  不写死两 harness；无匹配返回 null（未知来源，调用方不猜）。 */
export function skillSourceRuntime(source: GlobalSkillSource): Harness | null {
  return HARNESS_ORDER.find((h) => source.startsWith(h)) ?? null;
}

/** A resolved skill directory (absolute path, may be a symlink target). */
export interface GlobalSkillEntry {
  name: string;
  dir: string;
  /** 装面形态（服务端 lstat 判定）：链接 = 全局位置无副本、副本 = 回退复制。
   *  仅陈述事实——CC 自有的 plugins/cache 副本非 weave 可控，别拿它提示用户改设置。 */
  form: 'link' | 'copy';
}

/** A labelled group of global skills sharing a source. Plugin groups carry
 * enable state keyed `plugin@marketplace`; personal groups do not. */
export interface GlobalSkillGroup {
  source: GlobalSkillSource;
  label: string;
  skills: GlobalSkillEntry[];
  pluginKey?: string;
  /** 所属市场 = 仓库 namespace（服务端经 harness 面拆键得来）。前端据此做一级
   *  折叠块，**不得自己 split `@`**；个人组无此字段（归「本地」）。 */
  namespace?: string;
  enabled?: boolean;
}

/** 插件工具行：模型协议 ToolStateRow（install/enable 逐档，effective 服务端解析）。 */
export type PluginRow = ToolStateRow;

export type PluginRuntime = Harness;

export type AssetScope = 'project' | 'user';

export const updatesApi = {
  // --- updates / sync / global scope ---
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
    fetch(`${API_BASE}/projects/${projectId}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  syncAll: (projectId: number): Promise<Response> =>
    fetch(`${API_BASE}/projects/${projectId}/sync-all`, { method: 'POST' }),
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
  /** 插件工具行（每键 × 每可装档一行；effective/安装态服务端算好）。 */
  listPluginState: (projectId: number): Promise<PluginRow[]> =>
    apiFetch<{ rows: PluginRow[] }>(`/projects/${projectId}/plugins/state`).then(
      (r) => r.rows,
    ),
  putPluginState: (
    projectId: number,
    runtime: PluginRuntime,
    key: string,
    scope: ToolScope,
    state: EnableOverride,
  ): Promise<{ ok: boolean }> =>
    apiFetch<{ ok: boolean }>(`/projects/${projectId}/plugins/state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime, key, scope, state }),
    }),
  /** 卸载 CC 插件包（harness 级，按注册键；市场副本保留）。 */
  uninstallPluginPack: (
    projectId: number,
    body: { runtime: PluginRuntime; key: string },
  ): Promise<{ ok: boolean }> =>
    apiFetch<{ ok: boolean }>(`/projects/${projectId}/plugins/uninstall`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
