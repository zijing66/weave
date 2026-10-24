/** 资源市场域：库（libraries）、市场清单、目录浏览与 fs 选择器数据面。 */

import { apiFetch } from './client';
import type { AssetAgent } from './assets';
import type { FileAssetCategory } from './install';

export interface LibraryRow {
  id: number;
  path: string;
  kind: 'skill' | 'mcp' | 'both';
  addedAt: string;
}

/** mirror of server `market/updates.ts` 的检查结果（POST /market/check-updates）。 */
export type MarketUpdateStatus = 'uptodate' | 'update-available' | 'origin-missing' | 'unknown';
export interface MarketUpdateCheck {
  id: number;
  status: MarketUpdateStatus;
  checkedAt: string;
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
  /** 内置仓（weave 自己随包发布的那一份）：不是导入来的，不可迁入/删除/查更新。 */
  builtin: boolean;
  /** 仓库 namespace = 资源管理里那一级的块名（内置仓 = `weave`）；不在市场内的
   *  legacy 外部源没有仓库可归。web 只渲染，不自己从路径推。 */
  namespace?: string;
  /** 无清单 → legacy 外部/未收纳源（显示「迁入市场」）。 */
  legacy: boolean;
  source: 'git' | 'dir' | 'legacy' | 'builtin';
  origin: string | null;
  importedAt: string | null;
  commit: string | null;
  /** 该目录包含的资产类型计数（与资源管理文件树同词表；0 计数 key 不出现）。 */
  tags: Record<string, number> | null;
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

export const marketApi = {
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
  /** 删除市场资源（只删市场目录与行，装面副本不级联；warning = 宿主市场注销
   *  失败的次要结果，副本仍已删除）。 */
  removeMarket: (id: number): Promise<{ warning?: string }> =>
    apiFetch<{ ok: boolean; warning?: string }>(`/market/${id}`, { method: 'DELETE' }),
  /** 批量检查市场缓存更新（M4）：比对 origin，只读不落库；缺省全量。 */
  checkMarketUpdates: (ids?: number[]): Promise<MarketUpdateCheck[]> =>
    apiFetch<{ results: MarketUpdateCheck[] }>('/market/check-updates', {
      method: 'POST',
      body: JSON.stringify(ids?.length ? { ids } : {}),
    }).then((r) => r.results),
  /** 刷新市场缓存（一键更新第一步）：dir 重拷 / git 重 clone。 */
  refreshMarketCache: (ids?: number[]): Promise<Array<{ id: number; status: string }>> =>
    apiFetch<{ results: Array<{ id: number; status: string }> }>('/market/refresh', {
      method: 'POST',
      body: JSON.stringify(ids?.length ? { ids } : {}),
    }).then((r) => r.results),
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
  listLibraryAssets: (
    id: number,
  ): Promise<{
    library: LibraryRow;
    skills: SkillAsset[];
    files: FileAssetTemplate[];
    mcp: McpTemplate[];
    plugins: MarketPluginAsset[];
  }> =>
    apiFetch<{
      library: LibraryRow;
      skills: SkillAsset[];
      files: FileAssetTemplate[];
      mcp: McpTemplate[];
      plugins: MarketPluginAsset[];
    }>(`/libraries/${id}/assets`),
};

/** A file template found inside a registered library. */
export interface FileAssetTemplate {
  name: string;
  /** Absolute path of the template file inside the library. */
  filePath: string;
  relPath: string;
  group: string;
  category: FileAssetCategory;
}

/** Mirror of server `install/scanner.ts` MarketPluginAsset（插件包发现于库内）。 */
export interface MarketPluginAsset {
  name: string;
  version: string;
  description?: string;
  /** CC 注册键 `name@<市场>`（仅 CC 落地包有）：@后为所属市场 = 插件的 namespace。 */
  key?: string;
  /** Absolute path to the pack directory (install / enable source). */
  dirPath: string;
  /** Pack dir relative to the library root (posix; 包内 skill 双身份前缀匹配键). */
  relPath: string;
  ccPack: boolean;
  weavePack: boolean;
  kind: 'skill' | 'hook' | 'mod' | 'rule' | 'surface';
  components: ('skill' | 'command' | 'agent' | 'hook' | 'mod' | 'rule')[];
  targets: AssetAgent[];
  /** Pack-internal skills carrying a SKILL.md. */
  skills: string[];
}
