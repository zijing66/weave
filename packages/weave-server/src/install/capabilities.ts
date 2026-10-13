import { homedir } from 'node:os';
import { HARNESS_KEYS, type Harness } from '@weavecode/core';
import { FILE_ASSET_SPECS, FILE_ASSET_CATEGORIES, type FileAssetCategory } from './file-assets.js';
import { assetSurfaces } from '../surfaces.js';

/** 安装范围（与 InstallBody.scope 同形；`user` = 个人全局配置面）。 */
export type InstallScope = 'project' | 'user';

/** 可安装资产类别（skill / mcp + 5 类单文件资产）。 */
export type InstallCategory = 'skill' | 'mcp' | FileAssetCategory;

/** 单个 harness 面的可用范围；无该面 = 该 harness 不支持此类别。 */
export interface CategorySurface {
  harness: Harness;
  scopes: InstallScope[];
}

export interface CategoryCapability {
  surfaces: CategorySurface[];
}

/** `GET /capabilities` 响应体（web 镜像于 api.ts，唯一事实源在这里）。 */
export interface InstallCapabilities {
  categories: Record<InstallCategory, CategoryCapability>;
}

/**
 * 安装属性矩阵（批 M5）——点击安装禁用与拖拽 canDrop 共用的服务端事实源。
 *
 * 文件资产由 FILE_ASSET_SPECS 的 `dirs` 落点表按 harness 名单遍历派生：
 * 有 `project` ⇒ 支持项目面、有 `user` ⇒ 支持 user 面（Codex 项目面仅 skills，
 * 故 codex 单文件资产恒只有 user）。skill 面由资产面派生（P5：stub 实验
 * 证明手写字面量会漏第三 harness 的面）；mcp 为固定规则（mcp × codex 强制
 * user，表示法随 MCP 面批收口）。
 */
export function installCapabilities(): InstallCapabilities {
  const categories = {} as InstallCapabilities['categories'];
  for (const cat of FILE_ASSET_CATEGORIES) {
    const dirs = FILE_ASSET_SPECS[cat].dirs;
    const surfaces: CategorySurface[] = [];
    for (const harness of HARNESS_KEYS) {
      const d = dirs[harness];
      if (!d) continue;
      const scopes: InstallCapabilities['categories'][FileAssetCategory]['surfaces'][number]['scopes'] = [];
      if (d.project) scopes.push('project');
      if (d.user) scopes.push('user');
      if (scopes.length > 0) surfaces.push({ harness, scopes });
    }
    categories[cat] = { surfaces };
  }
  categories.skill = {
    surfaces: assetSurfaces().map((s) => {
      const scopes: InstallScope[] = [];
      if (s.projectSkillsDir()) scopes.push('project');
      if (s.globalSkillsRoots(homedir()).length > 0) scopes.push('user');
      return { harness: s.harness, scopes };
    }),
  };
  categories.mcp = {
    surfaces: [
      { harness: 'claude', scopes: ['project', 'user'] },
      { harness: 'codex', scopes: ['user'] },
    ],
  };
  return { categories };
}
