/**
 * File-backed harness asset kinds — the single source of truth for everything
 * that installs as ONE file (unlike skills, which install as a directory).
 *
 * A kind is fully described by where its files live on each surface:
 *  - `dir`        — Claude Code project directory (`.claude/<kind>/`)
 *  - `userDir`    — Claude Code user-level directory (`~/.claude/<kind>/`),
 *                   when the kind is also supported globally
 *  - `codexUserDir` — Codex user-level equivalent (`~/.codex/...`), when Codex
 *                   supports the kind at all (its per-project surface is
 *                   skills-only, handled separately)
 *
 * The same table drives: library scanning (scanner.ts), install/uninstall
 * (installer.ts), update detection (updates.ts) and the dashboard badges.
 *
 * 批 4a 从 `weave-server/src/install/file-assets.ts` 迁入（纯数据 + 类型，
 * 零依赖）；server 原位置 re-export，存量 import 零改动。
 */

/** Asset kinds installed as a single file (skills excluded — directory assets). */
export type FileAssetCategory = 'command' | 'agent' | 'workflow' | 'rule' | 'output-style';

export interface FileAssetSpec {
  /** Project directory (relative to the project root) for Claude Code. */
  dir: string;
  /** File extension for this kind. */
  ext: '.md' | '.js';
  /** Claude user-level directory (relative to `~`), when supported globally. */
  userDir?: string;
  /** Codex user-level directory (relative to `~`), when Codex supports it. */
  codexUserDir?: string;
}

export const FILE_ASSET_SPECS: Record<FileAssetCategory, FileAssetSpec> = {
  command: {
    dir: '.claude/commands',
    ext: '.md',
    userDir: '.claude/commands',
    // No Codex surface: Codex removed custom prompts (`$CODEX_HOME/prompts`,
    // gone from its source), and its slash commands are a compile-time enum.
    // Its only file-based command path is a plugin's `commands/`, which Codex
    // migrates into skills on load.
  },
  agent: { dir: '.claude/agents', ext: '.md', userDir: '.claude/agents' },
  workflow: { dir: '.claude/workflows', ext: '.js' },
  rule: { dir: '.claude/rules', ext: '.md' },
  'output-style': { dir: '.claude/output-styles', ext: '.md', userDir: '.claude/output-styles' },
};

export const FILE_ASSET_CATEGORIES = Object.keys(FILE_ASSET_SPECS) as FileAssetCategory[];

/** Is `category` one of the single-file asset kinds? */
export function isFileAssetCategory(category: string): category is FileAssetCategory {
  return Object.prototype.hasOwnProperty.call(FILE_ASSET_SPECS, category);
}
