import type { AssetAgent, AssetCategory } from './types.js';
import { assetSurfaces } from '../surfaces.js';

/**
 * Classify a project-relative path into an asset category.
 *
 * @param relPath - path relative to the project root, any separators
 * (e.g. ".claude/skills/foo/SKILL.md", ".mcp.json", "AGENTS.md").
 */
export function classifyAsset(relPath: string): AssetCategory {
  const p = normalizeRelPath(relPath);
  if (p === '.mcp.json') return 'mcp';
  if (p.startsWith('.claude/skills/') || p.startsWith('.codex/skills/')) return 'skill';
  if (p === '.claude/settings.json' || p === '.claude/settings.local.json') return 'settings';
  if (p === '.codex/config.toml') return 'settings';
  if (p.startsWith('.claude/commands/') || p.startsWith('.codex/prompts/')) return 'command';
  if (p.startsWith('.claude/agents/')) return 'agent';
  if (p.startsWith('.claude/helpers/')) return 'helper';
  if (p.startsWith('.claude/workflows/')) return 'workflow';
  if (p.startsWith('.claude/rules/')) return 'rule';
  if (p.startsWith('.claude/output-styles/')) return 'output-style';
  // 插件包前缀必须先于下方 base-name 回落：包内的 CLAUDE.md / AGENTS.md
  // 属于插件包自身，不能逃逸成 instructions。
  if (p.startsWith('.claude/plugins/') || p.startsWith('.weave/plugins/')) return 'plugin';
  // Instruction files may live at any depth (nested CLAUDE.md / AGENTS.md),
  // not just the project root. Directory prefixes above win first, so a
  // CLAUDE.md inside a skill or command folder stays part of that folder.
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base === 'CLAUDE.md' || base === 'AGENTS.md') return 'instructions';
  return 'other';
}

/**
 * Which coding agent a project-relative path belongs to: Codex owns `.codex/`
 * and `AGENTS.md`; everything else weave observes is Claude Code's surface.
 *
 * 批 4a：认领规则在各 harness 的 AssetSurface（`classify`），此处只委托——
 * 遍历全部已注册表面找首个认领者（各面认领集互斥），无人认领
 * （weave 未观测的任意路径）默认 claude。
 */
export function classifyAgent(relPath: string): AssetAgent {
  const p = normalizeRelPath(relPath);
  const owner = assetSurfaces().find((s) => s.classify(p));
  return owner?.harness ?? 'claude';
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
