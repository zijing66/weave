/** harness 配置文件域（资源管理 · 配置视图）：词表、视图状态与写入口。 */

import type { Harness } from '@weavecode/core/harness';
import { apiFetch } from './client';

export type ConfigFileId = 'user' | 'project' | 'projectLocal' | 'global';

/** 词表一条（键形/说明/枚举全归 harness 的 config 槽，web 只渲染）。 */
export interface ConfigKeySpec {
  key: string;
  group: string;
  type: string;
  options?: string[];
  default?: string;
  description: string;
  scope: 'any' | 'managed' | 'user' | 'project' | 'local' | 'global';
  deprecated?: boolean;
  nested?: boolean;
  /** 值的容器形状：map = 键名由用户起（模型名、插件 ID），array = 有序列表。 */
  shape?: 'map' | 'array';
  /** 值（map）/ 元素（array）是对象时的字段。 */
  fields?: ConfigFieldSpec[];
  /** 值（map）/ 元素（array）是标量时的类型与枚举；有 `fields` 时以字段为准。 */
  valueType?: string;
  valueOptions?: string[];
}

/** 对象值的一个字段（控件文法与顶层键同一套）。 */
export interface ConfigFieldSpec {
  name: string;
  type: string;
  options?: string[];
  description?: string;
}

export interface ConfigEnvVarSpec {
  name: string;
  description: string;
  kind: 'string' | 'boolean' | 'number' | 'list' | 'enum' | 'path';
  options?: string[];
}

export interface ConfigCatalogResponse {
  /** false = 该 harness 还没有 config 槽，面板渲染占位。 */
  supported: boolean;
  harness: Harness;
  file: ConfigFileId;
  /** 活文件的表示格式（raw 视图的编辑语言；supported:false 时缺省）。 */
  rawFormat?: 'json' | 'toml';
  files: { id: ConfigFileId; profiles: boolean }[];
  groups: string[];
  keys: ConfigKeySpec[];
  envVars: ConfigEnvVarSpec[];
}

export interface ConfigProfileMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** 一份配置的完整状态：活文件最新内容 + 快照 + 漂移 + 备份。 */
export interface ConfigView {
  harness: Harness;
  file: ConfigFileId;
  path: string;
  exists: boolean;
  values: Record<string, unknown>;
  managedKeys: string[];
  /** 数组里的 weave 托管条目（weave init 加的规则）——只有这几行只读。 */
  managedEntries: Array<{ path: string; entry: string }>;
  profiles: ConfigProfileMeta[];
  activeId: string | null;
  /** 活文件当前内容（与 `activeText` 比即漂移）。 */
  liveText: string;
  activeText: string | null;
  drifted: boolean;
  backups: string[];
}

/** 表单的一次改动：点号路径 → 落值 / 删键。 */
export interface ConfigUpdate {
  path: string;
  value?: unknown;
  remove?: boolean;
}

export interface ConfigModelOption {
  id: string;
  name?: string;
  createdAt?: string;
}

export interface ConfigModelsResponse {
  models: ConfigModelOption[];
  baseUrl: string;
  credential: 'apiKey' | 'authToken' | 'none';
}

/** 待保存预览：updates 应用在活配置上的前后两份原文（格式归 harness，web 只摆）。 */
export interface ConfigPreviewResponse {
  before: string;
  after: string;
}

export const configApi = {
  // --- harness 配置文件（/harness-config/*） ---
  getConfigCatalog: (harness: Harness, file: ConfigFileId): Promise<ConfigCatalogResponse> =>
    apiFetch<ConfigCatalogResponse>(`/harness-config/catalog?harness=${harness}&file=${file}`),
  getHarnessConfig: (
    harness: Harness,
    file: ConfigFileId,
    projectId: number | null,
  ): Promise<ConfigView> => {
    const params = new URLSearchParams({ harness, file });
    if (projectId != null) params.set('projectId', String(projectId));
    return apiFetch<ConfigView>(`/harness-config?${params}`);
  },
  putConfigValues: (body: {
    harness: Harness;
    file: ConfigFileId;
    projectId: number | null;
    updates: ConfigUpdate[];
  }): Promise<ConfigView> =>
    apiFetch<ConfigView>('/harness-config/values', { method: 'PUT', body: JSON.stringify(body) }),
  putConfigRaw: (body: {
    harness: Harness;
    file: ConfigFileId;
    projectId: number | null;
    text: string;
  }): Promise<ConfigView> =>
    apiFetch<ConfigView>('/harness-config/raw', { method: 'PUT', body: JSON.stringify(body) }),
  /** profile 生命周期：list/create/save/duplicate/rename/remove/activate/acceptDrift/restoreBackup。 */
  postConfigProfile: <T = ConfigView>(body: Record<string, unknown>): Promise<T> =>
    apiFetch<T>('/harness-config/profile', { method: 'POST', body: JSON.stringify(body) }),
  postConfigModels: (body: {
    harness: Harness;
    file: ConfigFileId;
    projectId: number | null;
    baseUrl?: string;
    apiKey?: string;
    authToken?: string;
  }): Promise<ConfigModelsResponse> =>
    apiFetch<ConfigModelsResponse>('/harness-config/models', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  postConfigPreview: (body: {
    harness: Harness;
    file: ConfigFileId;
    projectId: number | null;
    updates: ConfigUpdate[];
  }): Promise<ConfigPreviewResponse> =>
    apiFetch<ConfigPreviewResponse>('/harness-config/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
