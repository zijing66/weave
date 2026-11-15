import { cp, rm, readFile, access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Harness } from '@weavecode/core';
import type { McpServerConfig } from '@weavecode/harness';
import {
  FILE_ASSET_SPECS,
  fileAssetTargetDir,
  type FileAssetCategory,
} from './file-assets.js';
import { assetSurfaceFor } from '../surfaces.js';
import { forgetInstalled, recordInstalled } from './install-ledger.js';
import { installForm, removeInstalled } from '../market/install-link.js';

/**
 * Asset install/uninstall — pure filesystem operations, no sqlite writes.
 *
 * The watch service observes `.claude/`, `.codex/`, `.mcp.json` and the two
 * instruction files, so after install/uninstall returns, chokidar fires
 * add/unlink → the cache + SSE stream update the dashboard automatically. The
 * API layer therefore does not push asset changes itself.
 */

export class InstallConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallConflictError';
  }
}

export class AssetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetNotFoundError';
  }
}

/** MCP 配置的通用形（定义随 `AssetSurface` 的方法签名住在 harness 包）。 */
export type { McpServerConfig };

/** Which coding agent an install targets — Claude Code or Codex surfaces. */
export type InstallAgent = Harness;

/** Reject names that could escape the target directory (path traversal). */
function assertSafeName(name: string): void {
  if (
    !name ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    name.includes(path.sep)
  ) {
    throw new Error(`Invalid asset name: "${name}"`);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 项目内该 harness 的 skills 根（[0] = 安装落点，其后为只读的共用/遗留根）。
 *  批 4a：路径知识在 AssetSurface（`projectSkillsRoots`），此处只委托。 */
function skillsRootsFor(agent: InstallAgent): string[] {
  return assetSurfaceFor(agent).projectSkillsRoots();
}

/** Copy an entire skill directory into the agent's install root `<skills>/<name>/`.
 *  共用根里已有同名 skill 也算冲突——再铺一份只会被宿主遮住。 */
export async function installSkill(
  projectPath: string,
  sourceDir: string,
  name: string,
  agent: InstallAgent = 'claude',
): Promise<string> {
  assertSafeName(name);
  const roots = skillsRootsFor(agent);
  for (const r of roots) {
    // lstat 判存在：断链也算已装（access 会穿链报不存在，再 cp 就撞 EEXIST）。
    if ((await installForm(path.join(projectPath, r, name))) !== 'absent') {
      throw new InstallConflictError(
        `Skill "${name}" is already installed${agent === 'codex' ? ' (Codex)' : ''}`,
      );
    }
  }
  const target = path.join(projectPath, roots[0], name);
  await cp(sourceDir, target, { recursive: true });
  await recordInstalled(projectPath, { category: 'skill', name, agent });
  return target;
}

/** Remove the agent's skill directory `<skills>/<name>/` — 按根序找第一个存在的
 *  （共用根里的副本由别的工具铺的，也一并管得动）。 */
export async function uninstallSkill(
  projectPath: string,
  name: string,
  agent: InstallAgent = 'claude',
): Promise<void> {
  assertSafeName(name);
  let target: string | undefined;
  for (const root of skillsRootsFor(agent)) {
    const candidate = path.join(projectPath, root, name);
    if ((await installForm(candidate)) !== 'absent') {
      target = candidate;
      break;
    }
  }
  if (!target) {
    throw new AssetNotFoundError(
      `Skill "${name}" is not installed${agent === 'codex' ? ' (Codex)' : ''}`,
    );
  }
  // 链接只 unlink（共用根/市场源里的真身不删），复制体才递归删。
  await removeInstalled(target);
  await forgetInstalled(projectPath, { category: 'skill', name, agent });
}

/**
 * Copy a single template file to the agent/scope-resolved target directory
 * (see file-assets.ts for the surface table). The file is renamed to
 * `<name><ext>` — the library's file stem and the install name agree in
 * practice, but the install name wins so renames stay explicit.
 */
export async function installFileAsset(
  projectPath: string,
  category: FileAssetCategory,
  name: string,
  sourceFile: string,
  agent: InstallAgent = 'claude',
  scope: 'project' | 'user' = 'project',
): Promise<string> {
  assertSafeName(name);
  const targetDir = fileAssetTargetDir(category, agent, scope, projectPath, homedir());
  const target = path.join(targetDir, `${name}${FILE_ASSET_SPECS[category].ext}`);
  if (await pathExists(target)) {
    throw new InstallConflictError(`${category} "${name}" is already installed`);
  }
  await mkdir(targetDir, { recursive: true });
  await cp(sourceFile, target);
  if (scope === 'project') {
    await recordInstalled(projectPath, { category: 'file', name, agent, assetCategory: category });
  }
  return target;
}

/** Remove a single installed file asset (agent/scope-resolved path). */
export async function uninstallFileAsset(
  projectPath: string,
  category: FileAssetCategory,
  name: string,
  agent: InstallAgent = 'claude',
  scope: 'project' | 'user' = 'project',
): Promise<void> {
  assertSafeName(name);
  const targetDir = fileAssetTargetDir(category, agent, scope, projectPath, homedir());
  const target = path.join(targetDir, `${name}${FILE_ASSET_SPECS[category].ext}`);
  if (!(await pathExists(target))) {
    throw new AssetNotFoundError(`${category} "${name}" is not installed`);
  }
  await rm(target, { force: true });
  if (scope === 'project') {
    await forgetInstalled(projectPath, { category: 'file', name, agent, assetCategory: category });
  }
}

/** Add a `mcpServers[name]` entry to `.mcp.json`, preserving existing entries. */
export async function installMcp(
  projectPath: string,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  if (name in (await readMcpServers(projectPath))) {
    throw new InstallConflictError(`MCP server "${name}" is already configured`);
  }
  await assetSurfaceFor('claude').mcpWrite('project', projectPath, homedir(), name, config);
  await recordInstalled(projectPath, { category: 'mcp', name, agent: 'claude' });
}

/** Remove the `mcpServers[name]` entry from `.mcp.json`. */
export async function uninstallMcp(projectPath: string, name: string): Promise<void> {
  if (!(await assetSurfaceFor('claude').mcpRemove('project', projectPath, homedir(), name))) {
    throw new AssetNotFoundError(`MCP server "${name}" is not configured`);
  }
  await forgetInstalled(projectPath, { category: 'mcp', name, agent: 'claude' });
}

/** Read and parse `.mcp.json`; a missing/invalid file yields an empty object. */
export async function readMcpJson(file: string): Promise<{ mcpServers?: Record<string, unknown> }> {
  try {
    const raw = await readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Read the `mcpServers` map from a project's `.mcp.json` (empty if absent). */
export async function readMcpServers(
  projectPath: string,
): Promise<Record<string, McpServerConfig>> {
  return assetSurfaceFor('claude').mcpRead('project', projectPath, homedir());
}
