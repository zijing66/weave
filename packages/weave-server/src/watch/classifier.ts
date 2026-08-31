import type { AssetCategory } from './types.js';

/**
 * Classify a project-relative path into an asset category.
 *
 * @param relPath - path relative to the project root, any separators
 * (e.g. ".claude/skills/foo/SKILL.md", ".mcp.json").
 */
export function classifyAsset(relPath: string): AssetCategory {
  const p = normalizeRelPath(relPath);
  if (p === '.mcp.json') return 'mcp';
  if (p === '.claude/settings.json' || p === '.claude/settings.local.json') return 'settings';
  if (p.startsWith('.claude/skills/')) return 'skill';
  if (p.startsWith('.claude/commands/')) return 'command';
  if (p.startsWith('.claude/agents/')) return 'agent';
  if (p.startsWith('.claude/helpers/')) return 'helper';
  return 'other';
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
