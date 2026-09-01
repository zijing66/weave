import { rm, cp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { installMcp, uninstallMcp } from './installer.js';
import { writeGlobalMcpServer } from './global-config.js';
import { applyStatuslineConfig } from '../statusline/manager.js';
import { readStatuslineConfig } from '../statusline/manager.js';
import {
  buildLibraryIndex,
  findSkillSource,
  findMcpSource,
  findFileAssetSource,
  type LibraryIndex,
} from './library-index.js';
import { detectUpdates } from './updates.js';
import { FingerprintCache } from './fingerprint.js';
import { FILE_ASSET_SPECS, fileAssetTargetDir, isFileAssetCategory } from './file-assets.js';
import type { LibraryRow } from '../repositories/libraries.js';

/**
 * Apply updates — overwrite installed assets with their library sources.
 *
 * Update = destructive overwrite: the installed copy is removed and replaced
 * with the current source content. Any local edits to the installed copy are
 * lost. The UI must surface this clearly before invoking.
 *
 * Scope + agent are honoured:
 *   project skill → `.claude/skills/` (claude) · `.codex/skills/` (codex)
 *   global  skill → `~/.claude/skills/` (claude) · `~/.codex/skills/` (codex)
 *   project mcp   → `.mcp.json`, global mcp → `~/.claude.json`
 *   file assets   → the kind's project dir (see file-assets.ts)
 */

export interface ApplyUpdateInput {
  category: 'skill' | 'mcp' | 'command' | 'agent' | 'workflow' | 'rule' | 'output-style';
  name: string;
  scope: 'project' | 'global';
  /** Which agent's surface to refresh (skills only matter today). */
  agent?: 'claude' | 'codex';
}

/** Overwrite one installed asset from its library source. */
export async function applyUpdate(
  projectPath: string,
  input: ApplyUpdateInput,
  index?: LibraryIndex,
  libraries?: LibraryRow[],
): Promise<void> {
  const idx =
    index ?? (libraries ? await buildLibraryIndex(libraries) : await buildLibraryIndex([]));
  const agent = input.agent ?? 'claude';

  if (input.category === 'skill') {
    const src = findSkillSource(idx, input.name);
    if (!src) throw new Error(`No library source for skill "${input.name}"`);
    const skillsRoot =
      input.scope === 'global'
        ? path.join(homedir(), agent === 'codex' ? '.codex' : '.claude', 'skills')
        : path.join(projectPath, agent === 'codex' ? '.codex' : '.claude', 'skills');
    const targetDir = path.join(skillsRoot, input.name);
    await rm(targetDir, { recursive: true, force: true });
    await cp(src.dirPath, targetDir, { recursive: true });
    return;
  }

  if (isFileAssetCategory(input.category)) {
    const src = findFileAssetSource(idx, input.category, input.name);
    if (!src) throw new Error(`No library source for ${input.category} "${input.name}"`);
    const targetDir = fileAssetTargetDir(input.category, agent, input.scope, projectPath, homedir());
    await mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, `${input.name}${FILE_ASSET_SPECS[input.category].ext}`);
    await rm(target, { force: true });
    await cp(src.filePath, target);
    return;
  }

  // mcp
  const src = findMcpSource(idx, input.name);
  if (!src) throw new Error(`No library source for MCP "${input.name}"`);
  if (input.scope === 'global') {
    await writeGlobalMcpServer(input.name, src.config);
  } else {
    // remove then re-add to refresh the entry cleanly
    try {
      await uninstallMcp(projectPath, input.name);
    } catch {
      // not present — fine, we're (re)installing
    }
    await installMcp(projectPath, input.name, src.config);
  }
}

/**
 * Sync every outdated, non-custom asset in a project. Returns a summary of what
 * was updated. Skills and MCP entries with no library source are skipped.
 */
export async function syncAll(
  projectPath: string,
  libraries: LibraryRow[],
  cache: FingerprintCache,
  index?: LibraryIndex,
): Promise<{ updated: ApplyUpdateInput[]; skipped: number }> {
  const idx = index ?? (await buildLibraryIndex(libraries));
  const report = await detectUpdates(projectPath, libraries, cache, idx);
  const updated: ApplyUpdateInput[] = [];
  for (const s of report.skills) {
    if (s.custom || !s.outdated) continue;
    await applyUpdate(
      projectPath,
      { category: 'skill', name: s.name, scope: s.scope, agent: s.agent },
      idx,
    );
    updated.push({ category: 'skill', name: s.name, scope: s.scope, agent: s.agent });
  }
  for (const m of report.mcp) {
    if (m.custom || !m.outdated) continue;
    await applyUpdate(projectPath, { category: 'mcp', name: m.name, scope: m.scope }, idx);
    updated.push({ category: 'mcp', name: m.name, scope: m.scope });
  }
  for (const f of report.files) {
    if (f.custom || !f.outdated) continue;
    await applyUpdate(
      projectPath,
      { category: f.category, name: f.name, scope: f.scope },
      idx,
    );
    updated.push({ category: f.category, name: f.name, scope: f.scope });
  }
  return { updated, skipped: 0 };
}

/**
 * Re-apply the statusline config (regenerates the script + settings entry).
 * Used when weave itself upgrades and the generator output changes.
 */
export async function refreshStatusline(projectPath: string): Promise<void> {
  const config = await readStatuslineConfig(projectPath);
  await applyStatuslineConfig(projectPath, config);
}
