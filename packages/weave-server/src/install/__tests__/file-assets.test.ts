import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { FILE_ASSET_SPECS, fileAssetTargetDir } from '../file-assets.js';

/**
 * The Codex surface each kind installs to.
 *
 * Codex removed its custom-prompts directory, so a category that still pointed
 * there would install into a path nothing reads — silently doing nothing. The
 * point of these tests is that every declared Codex surface is one Codex
 * actually reads.
 */

const HOME = join('/', 'home', 'user');
const PROJECT = join('/', 'repo');

describe('fileAssetTargetDir — Claude surfaces', () => {
  it('install to .claude/<kind> at project scope', () => {
    expect(fileAssetTargetDir('command', 'claude', 'project', PROJECT, HOME)).toBe(
      join(PROJECT, '.claude', 'commands'),
    );
    expect(fileAssetTargetDir('agent', 'claude', 'project', PROJECT, HOME)).toBe(
      join(PROJECT, '.claude', 'agents'),
    );
    expect(fileAssetTargetDir('workflow', 'claude', 'project', PROJECT, HOME)).toBe(
      join(PROJECT, '.claude', 'workflows'),
    );
    expect(fileAssetTargetDir('rule', 'claude', 'project', PROJECT, HOME)).toBe(
      join(PROJECT, '.claude', 'rules'),
    );
    expect(fileAssetTargetDir('output-style', 'claude', 'project', PROJECT, HOME)).toBe(
      join(PROJECT, '.claude', 'output-styles'),
    );
  });

  it('install to ~/.claude/<kind> at global scope', () => {
    expect(fileAssetTargetDir('command', 'claude', 'global', PROJECT, HOME)).toBe(
      join(HOME, '.claude', 'commands'),
    );
    expect(fileAssetTargetDir('output-style', 'claude', 'global', PROJECT, HOME)).toBe(
      join(HOME, '.claude', 'output-styles'),
    );
  });

  it('install every kind at global scope except the two still missing a user dir', () => {
    for (const category of ['command', 'agent', 'output-style'] as const) {
      expect(fileAssetTargetDir(category, 'claude', 'global', PROJECT, HOME)).toBe(
        join(HOME, '.claude', category === 'command' ? 'commands' : category === 'agent' ? 'agents' : 'output-styles'),
      );
    }
    // KNOWN GAP, not desired behaviour: Claude Code reads user-level
    // `~/.claude/workflows/` and `~/.claude/rules/`, but these two specs carry
    // no `userDir`, so a global install throws. Tracked in docs/BACKLOG.md.
    for (const category of ['workflow', 'rule'] as const) {
      expect(() => fileAssetTargetDir(category, 'claude', 'global', PROJECT, HOME)).toThrow(
        /project-scoped only/,
      );
    }
  });
});

describe('fileAssetTargetDir — Codex surfaces', () => {
  it('has no Codex surface for commands', () => {
    // Codex deleted `$CODEX_HOME/prompts`; installing there would write into a
    // directory nothing reads.
    expect(FILE_ASSET_SPECS.command.codexUserDir).toBeUndefined();
    expect(() => fileAssetTargetDir('command', 'codex', 'global', PROJECT, HOME)).toThrow(
      /no Codex/,
    );
  });

  it('has no Codex surface for the Claude-only kinds', () => {
    for (const category of ['agent', 'workflow', 'rule', 'output-style'] as const) {
      expect(FILE_ASSET_SPECS[category].codexUserDir).toBeUndefined();
      expect(() => fileAssetTargetDir(category, 'codex', 'global', PROJECT, HOME)).toThrow(
        /no Codex/,
      );
    }
  });

  it('only ever declares a Codex surface that Codex reads', () => {
    // Anything declared here must be a path Codex's own host_roots/loader
    // reads. `~/.codex/prompts` was removed; `.agents/skills` and
    // `.codex/skills` are the skill roots.
    const declared = Object.entries(FILE_ASSET_SPECS)
      .map(([category, spec]) => [category, spec.codexUserDir] as const)
      .filter(([, dir]) => dir !== undefined);
    for (const [category, dir] of declared) {
      expect(dir, `${category} points at a removed Codex path`).not.toBe('.codex/prompts');
    }
  });
});
