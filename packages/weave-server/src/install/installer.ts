import { cp, rm, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  FILE_ASSET_SPECS,
  fileAssetTargetDir,
  type FileAssetCategory,
} from './file-assets.js';

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

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Which coding agent an install targets — Claude Code or Codex surfaces. */
export type InstallAgent = 'claude' | 'codex';

const SKILLS_DIR = '.claude/skills';
const CODEX_SKILLS_DIR = '.codex/skills';
const MCP_FILE = '.mcp.json';

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

/** Resolve the skills directory for an agent (Codex project skills live under
 * `.codex/skills/`; everything else is Claude's `.claude/skills/`). */
function skillsDirFor(agent: InstallAgent): string {
  return agent === 'codex' ? CODEX_SKILLS_DIR : SKILLS_DIR;
}

/** Copy an entire skill directory into the agent's `<skills>/<name>/`. */
export async function installSkill(
  projectPath: string,
  sourceDir: string,
  name: string,
  agent: InstallAgent = 'claude',
): Promise<string> {
  assertSafeName(name);
  const target = path.join(projectPath, skillsDirFor(agent), name);
  if (await pathExists(target)) {
    throw new InstallConflictError(
      `Skill "${name}" is already installed${agent === 'codex' ? ' (Codex)' : ''}`,
    );
  }
  await cp(sourceDir, target, { recursive: true });
  return target;
}

/** Remove the agent's skill directory `<skills>/<name>/`. */
export async function uninstallSkill(
  projectPath: string,
  name: string,
  agent: InstallAgent = 'claude',
): Promise<void> {
  assertSafeName(name);
  const target = path.join(projectPath, skillsDirFor(agent), name);
  if (!(await pathExists(target))) {
    throw new AssetNotFoundError(
      `Skill "${name}" is not installed${agent === 'codex' ? ' (Codex)' : ''}`,
    );
  }
  await rm(target, { recursive: true, force: true });
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
  scope: 'project' | 'global' = 'project',
): Promise<string> {
  assertSafeName(name);
  const targetDir = fileAssetTargetDir(category, agent, scope, projectPath, homedir());
  const target = path.join(targetDir, `${name}${FILE_ASSET_SPECS[category].ext}`);
  if (await pathExists(target)) {
    throw new InstallConflictError(`${category} "${name}" is already installed`);
  }
  await mkdir(targetDir, { recursive: true });
  await cp(sourceFile, target);
  return target;
}

/** Remove a single installed file asset (agent/scope-resolved path). */
export async function uninstallFileAsset(
  projectPath: string,
  category: FileAssetCategory,
  name: string,
  agent: InstallAgent = 'claude',
  scope: 'project' | 'global' = 'project',
): Promise<void> {
  assertSafeName(name);
  const targetDir = fileAssetTargetDir(category, agent, scope, projectPath, homedir());
  const target = path.join(targetDir, `${name}${FILE_ASSET_SPECS[category].ext}`);
  if (!(await pathExists(target))) {
    throw new AssetNotFoundError(`${category} "${name}" is not installed`);
  }
  await rm(target, { force: true });
}

/** Add a `mcpServers[name]` entry to `.mcp.json`, preserving existing entries. */
export async function installMcp(
  projectPath: string,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  assertSafeName(name);
  const file = path.join(projectPath, MCP_FILE);
  const json = await readMcpJson(file);
  const servers = (json.mcpServers ?? {}) as Record<string, unknown>;
  if (name in servers) {
    throw new InstallConflictError(`MCP server "${name}" is already configured`);
  }
  servers[name] = config;
  json.mcpServers = servers;
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
}

/** Remove the `mcpServers[name]` entry from `.mcp.json`. */
export async function uninstallMcp(projectPath: string, name: string): Promise<void> {
  assertSafeName(name);
  const file = path.join(projectPath, MCP_FILE);
  const json = await readMcpJson(file);
  const servers = (json.mcpServers ?? {}) as Record<string, unknown>;
  if (!(name in servers)) {
    throw new AssetNotFoundError(`MCP server "${name}" is not configured`);
  }
  delete servers[name];
  json.mcpServers = servers;
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
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
  const json = await readMcpJson(path.join(projectPath, MCP_FILE));
  return (json.mcpServers ?? {}) as Record<string, McpServerConfig>;
}
