import type { AssetAgent, AssetCategory } from './types.js';

/**
 * Classify a project-relative path into an asset category.
 *
 * @param relPath - path relative to the project root, any separators
 * (e.g. ".claude/skills/foo/SKILL.md", ".mcp.json", "AGENTS.md").
 */
export function classifyAsset(relPath: string): AssetCategory {
  const p = normalizeRelPath(relPath);
  if (p === '.mcp.json') return 'mcp';
  if (p === 'CLAUDE.md' || p === 'AGENTS.md') return 'instructions';
  if (p === '.claude/settings.json' || p === '.claude/settings.local.json') return 'settings';
  if (p === '.codex/config.toml') return 'settings';
  if (p.startsWith('.claude/skills/') || p.startsWith('.codex/skills/')) return 'skill';
  if (p.startsWith('.claude/commands/') || p.startsWith('.codex/prompts/')) return 'command';
  if (p.startsWith('.claude/agents/')) return 'agent';
  if (p.startsWith('.claude/helpers/')) return 'helper';
  if (p.startsWith('.claude/workflows/')) return 'workflow';
  if (p.startsWith('.claude/rules/')) return 'rule';
  if (p.startsWith('.claude/output-styles/')) return 'output-style';
  return 'other';
}

/**
 * Which coding agent a project-relative path belongs to: Codex owns `.codex/`
 * and `AGENTS.md`; everything else weave observes is Claude Code's surface.
 */
export function classifyAgent(relPath: string): AssetAgent {
  const p = normalizeRelPath(relPath);
  if (p === 'AGENTS.md' || p === '.codex' || p.startsWith('.codex/')) return 'codex';
  return 'claude';
}

/**
 * Normalize a path to posix separators, stripping leading `./` and `/`.
 * chokidar may report backslash separators on Windows; cache keys must be
 * separator-stable.
 */
export function normalizeRelPath(relPath: string): string {
  let p = relPath.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  return p;
}
