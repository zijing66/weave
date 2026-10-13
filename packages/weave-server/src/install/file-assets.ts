import type { Harness } from '@weavecode/core';
import type { FileAssetCategory } from '@weavecode/harness';
import { assetSurfaceFor } from '../surfaces.js';

/**
 * File-backed harness asset kinds — the single source of truth for everything
 * that installs as ONE file (unlike skills, which install as a directory).
 *
 * 批 4a：矩阵本体（FileAssetCategory / FileAssetSpec / FILE_ASSET_SPECS /
 * FILE_ASSET_CATEGORIES / isFileAssetCategory）迁至 `@weavecode/harness` 的
 * `shared/file-specs.ts`，此处 re-export 保持存量 import 与测试零改动；
 * `fileAssetTargetDir` 保留原名原签名，内部委托 AssetSurface（经 registry 查 surface）。
 *
 * The same table drives: library scanning (scanner.ts), install/uninstall
 * (installer.ts), update detection (updates.ts) and the dashboard badges.
 */

export {
  FILE_ASSET_SPECS,
  FILE_ASSET_CATEGORIES,
  isFileAssetCategory,
  type FileAssetCategory,
  type FileAssetSpec,
} from '@weavecode/harness';

/** Resolve the install target directory for a file asset.
 * `agent` + `scope` decide the surface; kinds without a matching surface throw
 * (e.g. rules are project-only, agents have no Codex equivalent). */
export function fileAssetTargetDir(
  category: FileAssetCategory,
  agent: Harness,
  scope: 'project' | 'user',
  projectPath: string,
  homedir: string,
): string {
  return assetSurfaceFor(agent).targetDir(category, scope, projectPath, homedir);
}
