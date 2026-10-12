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
    mkdirSync(path.join(claude, 'plugins', 'demo', 'commands'), { recursive: true });
    mkdirSync(path.join(claude, 'projects', 'session-x'), { recursive: true });
    mkdirSync(path.join(home, '.codex', 'prompts'), { recursive: true });
    // Plugin subtree fixture: registry data (skipped), a mods package, a
    // plain package, and a file deep enough to require the plugins depth budget.
    mkdirSync(path.join(claude, 'plugins', 'marketplaces', 'acme'), { recursive: true });
    mkdirSync(path.join(claude, 'plugins', 'data', 'blob'), { recursive: true });
    mkdirSync(path.join(claude, 'plugins', '.in_use', 'x'), { recursive: true });
    mkdirSync(path.join(claude, 'plugins', 'mods-pkg', '.claude-plugin'), { recursive: true });
    mkdirSync(path.join(claude, 'plugins', 'mods-pkg', 'hooks'), { recursive: true });
    mkdirSync(path.join(claude, 'plugins', 'mods-pkg', 'commands'), { recursive: true });
    mkdirSync(path.join(claude, 'plugins', 'cache', 'm', 'k', '1.0.0', 'src', 'deep'), {
      recursive: true,
    });

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

    // 宿主安装记录：键 `k@m` 装在 cache/m/k/1.0.0 —— 全局文件树的仓库标记据此判
    writeFileSync(
      path.join(claude, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'k@m': [
            {
              scope: 'user',
              installPath: path.join(claude, 'plugins', 'cache', 'm', 'k', '1.0.0'),
            },
          ],
        },
      }),
    );
    writeFileSync(path.join(claude, 'plugins', 'marketplaces', 'acme', 'marketplace.json'), '{}');
    writeFileSync(path.join(claude, 'plugins', 'data', 'blob', 'cache.json'), '{}');
    writeFileSync(path.join(claude, 'plugins', '.in_use', 'x', 'marker'), '{}');
    writeFileSync(
      path.join(claude, 'plugins', 'mods-pkg', '.claude-plugin', 'plugin.json'),
      '{}',
    );
    writeFileSync(
      path.join(claude, 'plugins', 'mods-pkg', 'hooks', 'hooks.json'),
      JSON.stringify({ modules: [{ x: 1 }] }),
    );
    writeFileSync(path.join(claude, 'plugins', 'mods-pkg', 'commands', 'run.md'), '# run');
    writeFileSync(path.join(claude, 'plugins', 'demo', 'commands', 'run.md'), '# run');
    writeFileSync(
      path.join(claude, 'plugins', 'cache', 'm', 'k', '1.0.0', 'src', 'deep', 'file.ts'),
      'x',
    );
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

  it('descends into plugins but still skips skills and internal Claude trees', async () => {
    const assets = await listGlobalFileAssets(home);
    const rels = assets.map((a) => a.relPath);
    const byRel = new Map(assets.map((a) => [a.relPath, a]));

    expect(rels.some((r) => r.includes('skills'))).toBe(false);
    expect(rels.some((r) => r.includes('projects'))).toBe(false);

    // plugins/ is now included …
    expect(rels).toContain('.claude/plugins/installed_plugins.json');
    expect(byRel.get('.claude/plugins/installed_plugins.json')?.category).toBe('plugin');
    expect(byRel.get('.claude/plugins/demo/plugin.json')?.category).toBe('plugin');
    // … registry data under plugins stays out …
    expect(rels.some((r) => r.includes('plugins/marketplaces'))).toBe(false);
    expect(rels.some((r) => r.includes('plugins/data'))).toBe(false);
    expect(rels.some((r) => r.includes('plugins/.in_use'))).toBe(false);
    // … and the deeper plugins budget reaches a file beyond depth 6.
    expect(rels).toContain('.claude/plugins/cache/m/k/1.0.0/src/deep/file.ts');
    // A package with non-empty hooks modules is tagged mods as a whole.
    expect(byRel.get('.claude/plugins/mods-pkg/commands/run.md')?.category).toBe('mods');
    expect(byRel.get('.claude/plugins/mods-pkg/hooks/hooks.json')?.category).toBe('mods');
    expect(byRel.get('.claude/plugins/mods-pkg/.claude-plugin/plugin.json')?.category).toBe(
      'mods',
    );
  });

  it('tags plugin-laid files with their repo namespace, and only those', async () => {
    const assets = await listGlobalFileAssets(home);
    const byRel = new Map(assets.map((a) => [a.relPath, a]));
    // 落在安装记录的 installPath 里 → 键 `k@m` 的市场名
    expect(byRel.get('.claude/plugins/cache/m/k/1.0.0/src/deep/file.ts')?.namespace).toBe('m');
    // 用户自己写的文件、没进任何安装记录的插件目录：无仓库可归
    expect(byRel.get('.claude/commands/review.md')?.namespace).toBeUndefined();
    expect(byRel.get('.claude/settings.json')?.namespace).toBeUndefined();
    expect(byRel.get('.claude/plugins/mods-pkg/commands/run.md')?.namespace).toBeUndefined();
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
