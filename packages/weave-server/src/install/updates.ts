import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { FingerprintCache, hashMcpConfig } from './fingerprint.js';
import {
  buildLibraryIndex,
  findSkillSource,
  findMcpSource,
  type LibraryIndex,
} from './library-index.js';
import { readMcpServers } from './installer.js';
import { readGlobalMcpServers, readGlobalSkills } from './global-config.js';
import type { LibraryRow } from '../repositories/libraries.js';

/**
 * Update detection — compares installed assets against their library sources.
 *
 * An installed skill is "outdated" when its directory content hash differs from
 * the source directory's hash; an MCP entry is outdated when its config hash
 * differs from the source template's. Assets without a matching library source
 * are `custom` (no update path) — e.g. hand-authored skills or MCP entries
 * added via the form, not from a template.
 *
 * Scope is inferred from the install path:
 *   project skill → `<project>/.claude/skills/<name>/`
 *   global  skill → `~/.claude/skills/<name>/`
 *   project mcp   → `.mcp.json`
 *   global  mcp   → `~/.claude.json`
 */

const PROJECT_SKILLS_DIR = '.claude/skills';

export interface SkillUpdate {
  name: string;
  scope: 'project' | 'global';
  /** true = installed content differs from source (update available). */
  outdated: boolean;
  /** true = no library source found (cannot update). */
  custom: boolean;
  /** Resolved source directory when not custom. */
  sourceDir?: string;
  libraryId?: number;
}

export interface McpUpdate {
  name: string;
  scope: 'project' | 'global';
  outdated: boolean;
  custom: boolean;
  libraryId?: number;
}

export interface UpdateReport {
  skills: SkillUpdate[];
  mcp: McpUpdate[];
  /** Count of outdated, non-custom assets. */
  available: number;
}

/**
 * Detect skill + MCP updates for a project against the registered libraries.
 * `index` may be passed in (reused across calls) or omitted to rebuild it.
 */
export async function detectUpdates(
  projectPath: string,
  libraries: LibraryRow[],
  cache: FingerprintCache,
  index?: LibraryIndex,
): Promise<UpdateReport> {
  const idx = index ?? (await buildLibraryIndex(libraries));
  const skills = await detectSkillUpdates(projectPath, cache, idx);
  const mcp = await detectMcpUpdates(projectPath, idx);
  const available = skills.filter((s) => !s.custom && s.outdated).length
    + mcp.filter((s) => !s.custom && s.outdated).length;
  return { skills, mcp, available };
}

/** Detect skill updates for a project against the library index. */
export async function detectSkillUpdates(
  projectPath: string,
  cache: FingerprintCache,
  idx: LibraryIndex,
): Promise<SkillUpdate[]> {
  const installedDir = path.join(projectPath, PROJECT_SKILLS_DIR);
  let names: string[];
  try {
    names = (await readdir(installedDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    names = [];
  }
  return Promise.all(
    names.map(async (name) => {
      const installedDirName = path.join(installedDir, name);
      const src = findSkillSource(idx, name);
      if (!src) {
        return { name, scope: 'project' as const, outdated: false, custom: true };
      }
      const [installedHash, sourceHash] = await Promise.all([
        cache.get(installedDirName),
        cache.get(src.dirPath),
      ]);
      return {
        name,
        scope: 'project',
        outdated: installedHash !== sourceHash,
        custom: false,
        sourceDir: src.dirPath,
        libraryId: src.libraryId,
      };
    }),
  );
}

/** Detect MCP updates (project + global) against the library index. */
async function detectMcpUpdates(projectPath: string, idx: LibraryIndex): Promise<McpUpdate[]> {
  const [projectServers, globalServers] = await Promise.all([
    readMcpServers(projectPath).catch(() => ({})),
    readGlobalMcpServers().catch(() => ({})),
  ]);
  const out: McpUpdate[] = [];
  for (const [name, cfg] of Object.entries(projectServers)) {
    const src = findMcpSource(idx, name);
    if (!src) {
      out.push({ name, scope: 'project', outdated: false, custom: true });
    } else {
      out.push({
        name,
        scope: 'project',
        outdated: hashMcpConfig(cfg) !== hashMcpConfig(src.config),
        custom: false,
        libraryId: src.libraryId,
      });
    }
  }
  for (const [name, cfg] of Object.entries(globalServers)) {
    const src = findMcpSource(idx, name);
    if (!src) {
      out.push({ name, scope: 'global', outdated: false, custom: true });
    } else {
      out.push({
        name,
        scope: 'global',
        outdated: hashMcpConfig(cfg) !== hashMcpConfig(src.config),
        custom: false,
        libraryId: src.libraryId,
      });
    }
  }
  return out;
}

/** Re-export for callers that only want the global skills listing. */
export { readGlobalSkills };

