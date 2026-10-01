/**
 * @weave/server — watch service types.
 *
 * The watch service observes each registered project's harness asset
 * directories (Claude Code `.claude/` + `.mcp.json` + CLAUDE.md, Codex
 * `.codex/` + AGENTS.md) and maintains an in-memory cache. It NEVER writes
 * asset state to sqlite — the filesystem is the single source of truth
 * (persistence boundary: see weave-dashboard-architecture).
 */

/** Coarse classification of an observed asset file. */
export type AssetCategory =
  | 'skill'
  | 'command'
  | 'agent'
  | 'helper'
  | 'settings'
  | 'mcp'
  | 'workflow'
  | 'rule'
  | 'output-style'
  | 'instructions'
  | 'other';

/** Which coding agent an asset belongs to (`.claude/` vs `.codex/` + AGENTS.md). */
export type AssetAgent = 'claude' | 'codex';

/** A single cached asset file within a project. */
export interface AssetEntry {
  /** Absolute filesystem path. */
  absPath: string;
  /** Path relative to the project root, posix separators. */
  relPath: string;
  category: AssetCategory;
  agent: AssetAgent;
  /** Last modification time in ms since epoch. */
  mtimeMs: number;
  /** True when the file itself is a symbolic link (its target is watched). */
  isSymlink?: boolean;
}

/** Kind of change observed for a file. */
export type AssetChangeKind = 'add' | 'change' | 'unlink';

/** A single change event pushed to SSE subscribers. */
export interface AssetChangeEvent {
  projectPath: string;
  projectName: string;
  category: AssetCategory;
  agent: AssetAgent;
  relPath: string;
  absPath: string;
  kind: AssetChangeKind;
  /** True when the file itself is a symbolic link (its target is watched). */
  isSymlink?: boolean;
}
