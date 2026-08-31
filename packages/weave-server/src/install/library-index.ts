import { scanLibrarySkills, scanLibraryMcp, type SkillAsset, type McpTemplate } from './scanner.js';
import type { LibraryRow } from '../repositories/libraries.js';
import type { McpServerConfig } from './installer.js';

/**
 * Library source index — resolves "where did this installed asset come from?"
 * WITHOUT persisting a source mapping to sqlite.
 *
 * The join key is the asset's *name*: a skill installed at
 * `.claude/skills/<name>/` is matched against every registered library's
 * `scanLibrarySkills` output (which also keys by directory basename). MCP
 * entries (`.mcp.json` key = name) are matched the same way against library
 * MCP templates. This keeps the filesystem the single source of truth: we
 * never store "skill X came from library Y" as state — we recompute it on
 * demand from the live library directories.
 *
 * Scope is likewise inferred from path, not stored:
 *   project → `<project>/.claude/skills/`
 *   global  → `~/.claude/skills/`
 *
 * Multi-source edge case: if two libraries both define `<name>`, the first one
 * (by `libraries.list()` order) wins for update-checking. Any matching source
 * is sufficient to detect "outdated"; a precise multi-source UI can be layered
 * on later without a schema change.
 */

export interface SkillSource {
  name: string;
  libraryId: number;
  libraryPath: string;
  /** Absolute path to the skill directory in the library (copy source). */
  dirPath: string;
}

export interface McpSource {
  name: string;
  libraryId: number;
  libraryPath: string;
  config: McpServerConfig;
  /** Absolute path to the JSON file this template was loaded from. */
  sourcePath: string;
}

export interface LibraryIndex {
  /** name → source (first library wins on collision). */
  skills: Map<string, SkillSource>;
  /** name → source (first library wins on collision). */
  mcp: Map<string, McpSource>;
}

/**
 * Scan every registered library and build name→source indexes for skills and
 * MCP templates. Libraries whose kind excludes a category, or that are
 * unreadable, are skipped for that category.
 */
export async function buildLibraryIndex(libraries: LibraryRow[]): Promise<LibraryIndex> {
  const skills = new Map<string, SkillSource>();
  const mcp = new Map<string, McpSource>();
  for (const lib of libraries) {
    const wantSkill = lib.kind === 'skill' || lib.kind === 'both';
    const wantMcp = lib.kind === 'mcp' || lib.kind === 'both';
    if (wantSkill) {
      try {
        const scanned: SkillAsset[] = await scanLibrarySkills(lib.path);
        for (const s of scanned) {
          if (!skills.has(s.name)) {
            skills.set(s.name, {
              name: s.name,
              libraryId: lib.id,
              libraryPath: lib.path,
              dirPath: s.dirPath,
            });
          }
        }
      } catch {
        // unreadable library — skip
      }
    }
    if (wantMcp) {
      try {
        const scanned: McpTemplate[] = await scanLibraryMcp(lib.path);
        for (const t of scanned) {
          if (!mcp.has(t.name)) {
            const { name, command, args, env, sourcePath } = t;
            const config: McpServerConfig = { command, ...(args && { args }), ...(env && { env }) };
            mcp.set(t.name, { name, libraryId: lib.id, libraryPath: lib.path, config, sourcePath });
          }
        }
      } catch {
        // unreadable library — skip
      }
    }
  }
  return { skills, mcp };
}

/** Resolve the library source for an installed skill by name, if any. */
export function findSkillSource(index: LibraryIndex, name: string): SkillSource | undefined {
  return index.skills.get(name);
}

/** Resolve the library source for an installed MCP server by name, if any. */
export function findMcpSource(index: LibraryIndex, name: string): McpSource | undefined {
  return index.mcp.get(name);
}
