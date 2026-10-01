import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listGlobalFileAssets } from '../global-file-assets.js';

describe('listGlobalFileAssets', () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), 'weave-gfa-'));
    const claude = path.join(home, '.claude');
    mkdirSync(path.join(claude, 'commands', 'nested'), { recursive: true });
    mkdirSync(path.join(claude, 'skills', 'foo'), { recursive: true });
    mkdirSync(path.join(claude, 'plugins', 'demo'), { recursive: true });
    mkdirSync(path.join(claude, 'projects', 'session-x'), { recursive: true });
    mkdirSync(path.join(home, '.codex', 'prompts'), { recursive: true });

    writeFileSync(path.join(claude, 'commands', 'review.md'), '# review');
    writeFileSync(path.join(claude, 'commands', 'nested', 'deep.md'), '# deep');
    writeFileSync(path.join(claude, 'CLAUDE.md'), '# memory');
    writeFileSync(path.join(claude, 'settings.json'), '{}');
    writeFileSync(path.join(claude, 'skills', 'foo', 'SKILL.md'), '# skill');
    writeFileSync(path.join(claude, 'plugins', 'demo', 'plugin.json'), '{}');
    writeFileSync(path.join(claude, 'projects', 'session-x', 'transcript.jsonl'), 'x');
    writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"');
    writeFileSync(path.join(home, '.codex', 'prompts', 'old.md'), '# legacy');
    writeFileSync(path.join(home, '.codex', 'AGENTS.real.md'), '# agents');
    symlinkSync('AGENTS.real.md', path.join(home, '.codex', 'AGENTS.md'));
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('lists whitelisted harness files with their classification', async () => {
    const assets = await listGlobalFileAssets(home);
    const byRel = new Map(assets.map((a) => [a.relPath, a]));

    expect(byRel.get('.claude/commands/review.md')?.category).toBe('command');
    expect(byRel.get('.claude/commands/nested/deep.md')?.category).toBe('command');
    expect(byRel.get('.claude/CLAUDE.md')?.category).toBe('instructions');
    expect(byRel.get('.claude/settings.json')?.category).toBe('settings');
    expect(byRel.get('.codex/config.toml')?.category).toBe('settings');
    expect(byRel.get('.codex/config.toml')?.agent).toBe('codex');
    // Codex's removed prompts surface still shows if the files linger.
    expect(byRel.get('.codex/prompts/old.md')?.category).toBe('command');
    expect(byRel.get('.codex/prompts/old.md')?.agent).toBe('codex');
  });

  it('never descends into skills, plugins or internal Claude trees', async () => {
    const rels = (await listGlobalFileAssets(home)).map((a) => a.relPath);
    expect(rels.some((r) => r.includes('skills'))).toBe(false);
    expect(rels.some((r) => r.includes('plugins'))).toBe(false);
    expect(rels.some((r) => r.includes('projects'))).toBe(false);
  });

  it('flags symlinked files and resolves through them', async () => {
    const assets = await listGlobalFileAssets(home);
    const agents = assets.find((a) => a.relPath === '.codex/AGENTS.md');
    expect(agents?.isSymlink).toBe(true);
    expect(agents?.category).toBe('instructions');
    expect(agents?.agent).toBe('codex');
    // The raw target file is not whitelisted — only AGENTS.md itself shows.
    expect(assets.some((a) => a.relPath.endsWith('AGENTS.real.md'))).toBe(false);
  });

  it('returns a sorted, tool-prefixed list (two tree roots)', async () => {
    const assets = await listGlobalFileAssets(home);
    const roots = new Set(assets.map((a) => a.relPath.split('/')[0]));
    expect([...roots].sort()).toEqual(['.claude', '.codex']);
    const rels = assets.map((a) => a.relPath);
    expect([...rels].sort()).toEqual(rels);
  });
});
