import path from 'node:path';
import { homedir } from 'node:os';
import { HARNESS_KEYS, type Harness } from '@weavecode/core';
import { FILE_ASSET_SPECS, FILE_ASSET_CATEGORIES, type FileAssetCategory } from './file-assets.js';
import { assetSurfaces, configSurfaces, statuslineSurfaces } from '../surfaces.js';

/** 安装范围（与 InstallBody.scope 同形；`user` = 个人全局配置面）。 */
export type InstallScope = 'project' | 'user';

/** 可安装资产类别（skill / mcp + 5 类单文件资产）。 */
export type InstallCategory = 'skill' | 'mcp' | FileAssetCategory;

/** 单个 harness 面的可用范围；无该面 = 该 harness 不支持此类别。 */
export interface CategorySurface {
  harness: Harness;
  scopes: InstallScope[];
  /** 各 scope 的安装落点（显示形：项目内相对路径 posix 原样、用户级以 `~`
   *  缩写）——web 的范围落点提示按此渲染，不自拼 harness 路径（§6-4）。 */
  dest?: Partial<Record<InstallScope, string>>;
}

export interface CategoryCapability {
  surfaces: CategorySurface[];
}

/**
 * 某 harness 的 statusline 面：`tui` 答「TUI 里能不能注入」（今天只有 claude
 * 能），`segments` 是它能渲染的块。缺席 = 该 harness 没有 statusline 概念。
 */
export interface StatuslineCapability {
  harness: Harness;
  tui: 'injectable' | 'none';
  segments: string[];
}

/** `GET /capabilities` 响应体（web 镜像于 api.ts，唯一事实源在这里）。 */
export interface InstallCapabilities {
  categories: Record<InstallCategory, CategoryCapability>;
  statusline: StatuslineCapability[];
  /** 有配置文件接管面的 harness（按注册顺序）——web 不按 harness 名判有没有配置面板。 */
  config: Harness[];
}

/**
 * 安装属性矩阵（批 M5）——点击安装禁用与拖拽 canDrop 共用的服务端事实源。
 *
 * 文件资产由 FILE_ASSET_SPECS 的 `dirs` 落点表按 harness 名单遍历派生：
 * 有 `project` ⇒ 支持项目面、有 `user` ⇒ 支持 user 面（Codex 项目面仅 skills，
 * 故 codex 单文件资产恒只有 user）。skill 与 mcp 面皆由资产面派生
 * （P5：stub 实验证明手写字面量会漏第三 harness 的面）；mcp 范围 =
 * AssetSurface.mcpScopes、落点 = mcpDest——范围落点提示随行下发（§6-4），
 * web 不自拼 harness 路径。
 */
/** 用户级落点的显示形：`~` + 相对 home 的 posix 路径。 */
function userDest(abs: string, home: string): string {
  return path.join('~', path.relative(home, abs)).split(path.sep).join('/');
}

export function installCapabilities(): InstallCapabilities {
  const home = homedir();
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
    surfaces: assetSurfaces()
      .map((s) => {
        const scopes: InstallScope[] = [];
        const dest: Partial<Record<InstallScope, string>> = {};
        const projectRoot = s.projectSkillsRoots()[0];
        if (projectRoot) {
          scopes.push('project');
          dest.project = projectRoot;
        }
        const userRoot = s.globalSkillsRoots(home)[0];
        if (userRoot) {
          scopes.push('user');
          dest.user = userDest(userRoot, home);
        }
        return { harness: s.harness, scopes, dest };
      }),
  };
  categories.mcp = {
    surfaces: assetSurfaces()
      .map((s) => {
        const dest: Partial<Record<InstallScope, string>> = {};
        const project = s.mcpDest('project', home);
        const user = s.mcpDest('user', home);
        if (project) dest.project = project;
        if (user) dest.user = userDest(user, home);
        return { harness: s.harness, scopes: s.mcpScopes(), dest };
      })
      .filter((surface) => surface.scopes.length > 0),
  };
  const statusline: StatuslineCapability[] = statuslineSurfaces().map(({ harness, surface }) => ({
    harness,
    tui: surface.tui,
    segments: [...surface.segments],
  }));
  return { categories, statusline, config: configSurfaces().map((c) => c.harness) };
}
