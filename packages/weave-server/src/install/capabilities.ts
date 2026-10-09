import type { Harness } from '@weavecode/core';
import { FILE_ASSET_SPECS, FILE_ASSET_CATEGORIES, type FileAssetCategory } from './file-assets.js';

/** 安装范围（与 InstallBody.scope 同形）。 */
export type InstallScope = 'project' | 'global';

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
 * 文件资产由 FILE_ASSET_SPECS 派生：`userDir` 存在 ⇔ claude 支持全局；
 * `codexUserDir` 存在 ⇔ codex 有用户面（Codex 项目面仅 skills，故 codex 恒
 * 只有 global）。skill/mcp 为固定规则（mcp × codex 强制全局）。
 */
export function installCapabilities(): InstallCapabilities {
  const categories = {} as InstallCapabilities['categories'];
  for (const cat of FILE_ASSET_CATEGORIES) {
    const spec = FILE_ASSET_SPECS[cat];
    const surfaces: CategorySurface[] = [
      { harness: 'claude', scopes: spec.userDir ? ['project', 'global'] : ['project'] },
    ];
    if (spec.codexUserDir) surfaces.push({ harness: 'codex', scopes: ['global'] });
    categories[cat] = { surfaces };
  }
  categories.skill = {
    surfaces: [
      { harness: 'claude', scopes: ['project', 'global'] },
      { harness: 'codex', scopes: ['project', 'global'] },
    ],
  };
  categories.mcp = {
    surfaces: [
      { harness: 'claude', scopes: ['project', 'global'] },
      { harness: 'codex', scopes: ['global'] },
    ],
  };
  return { categories };
}
