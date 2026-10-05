import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PluginModsSniffer } from '../plugin-mods.js';
import type { AssetCategory } from '../types.js';

describe('PluginModsSniffer', () => {
  let root: string;
  let sniffer: PluginModsSniffer;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'weave-mods-'));
    sniffer = new PluginModsSniffer();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function write(rel: string, content: string): string {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  }

  function refine(rel: string, category: AssetCategory = 'plugin'): AssetCategory {
    return sniffer.refine(category, rel, path.join(root, ...rel.split('/')));
  }

  it('flips every file of a mods package to mods', () => {
    write('.claude/plugins/foo/.claude-plugin/plugin.json', '{}');
    write('.claude/plugins/foo/hooks/hooks.json', JSON.stringify({ modules: [{ x: 1 }] }));
    write('.claude/plugins/foo/commands/run.md', '# run');
    write('.claude/plugins/foo/README.md', '# readme');

    expect(refine('.claude/plugins/foo/commands/run.md')).toBe('mods');
    expect(refine('.claude/plugins/foo/README.md')).toBe('mods');
    // sniff 只在 category === 'plugin' 时动作，其余原样返回。
    expect(refine('.claude/plugins/foo/commands/run.md', 'skill')).toBe('skill');
    expect(refine('.claude/plugins/foo/commands/run.md', 'other')).toBe('other');
  });

  it('keeps a plain package as plugin', () => {
    write('.claude/plugins/plain/.claude-plugin/plugin.json', '{}');
    write('.claude/plugins/plain/hooks/hooks.json', JSON.stringify({ name: 'x' }));
    write('.claude/plugins/plain/commands/run.md', '# run');

    expect(refine('.claude/plugins/plain/commands/run.md')).toBe('plugin');
  });

  it.each([
    ['empty modules array', JSON.stringify({ modules: [] })],
    ['modules not an array', JSON.stringify({ modules: { a: 1 } })],
    ['modules a string', JSON.stringify({ modules: 'nope' })],
    ['invalid JSON', '{ not json'],
    ['not an object', '[1,2,3]'],
  ])('treats %s as non-mods', (_label, hooksContent) => {
    write('.claude/plugins/foo/.claude-plugin/plugin.json', '{}');
    write('.claude/plugins/foo/hooks/hooks.json', hooksContent);
    write('.claude/plugins/foo/commands/run.md', '# run');

    expect(refine('.claude/plugins/foo/commands/run.md')).toBe('plugin');
  });

  it('treats a missing hooks.json as non-mods', () => {
    write('.claude/plugins/foo/.claude-plugin/plugin.json', '{}');
    write('.claude/plugins/foo/commands/run.md', '# run');

    expect(refine('.claude/plugins/foo/commands/run.md')).toBe('plugin');
  });

  it('does not let an outer mods package pollute a nested inner package', () => {
    write('.claude/plugins/outer/.claude-plugin/plugin.json', '{}');
    write('.claude/plugins/outer/hooks/hooks.json', JSON.stringify({ modules: [{ x: 1 }] }));
    write('.claude/plugins/outer/commands/run.md', '# run');
    // Inner package: has its own manifest, no hooks.json of its own.
    write('.claude/plugins/outer/vendor/inner/.claude-plugin/plugin.json', '{}');
    write('.claude/plugins/outer/vendor/inner/skills/deep/SKILL.md', '# s');

    expect(refine('.claude/plugins/outer/commands/run.md')).toBe('mods');
    expect(refine('.claude/plugins/outer/vendor/inner/skills/deep/SKILL.md')).toBe('plugin');
  });

  it('does not misread hooks.json planted on the plugin root boundary', () => {
    write('.claude/plugins/hooks/hooks.json', JSON.stringify({ modules: [{ x: 1 }] }));
    write('.claude/plugins/installed_plugins.json', '{}');
    write('.claude/plugins/plain/commands/run.md', '# run');

    expect(refine('.claude/plugins/installed_plugins.json')).toBe('plugin');
    expect(refine('.claude/plugins/plain/commands/run.md')).toBe('plugin');
  });

  it('re-sniffs when hooks.json mtime changes (cache invalidation)', () => {
    write('.claude/plugins/foo/.claude-plugin/plugin.json', '{}');
    const hooks = write(
      '.claude/plugins/foo/hooks/hooks.json',
      JSON.stringify({ modules: [{ x: 1 }] }),
    );
    write('.claude/plugins/foo/commands/run.md', '# run');
    const rel = '.claude/plugins/foo/commands/run.md';

    expect(refine(rel)).toBe('mods');

    // Rewrite with empty modules AND bump mtime so the cache notices.
    writeFileSync(hooks, JSON.stringify({ modules: [] }));
    const future = new Date(Date.now() + 5000);
    utimesSync(hooks, future, future);

    expect(refine(rel)).toBe('plugin');
  });

  it('stays plugin for .weave/plugins paths without hooks.json', () => {
    write('.weave/plugins/bar/weave-plugin.json', '{}');
    write('.weave/plugins/bar/commands/run.md', '# run');
    write('.weave/plugins/bar/hooks/hooks.json', JSON.stringify({ name: 'no-modules' }));

    expect(refine('.weave/plugins/bar/commands/run.md')).toBe('plugin');
    expect(refine('.weave/plugins/bar/weave-plugin.json')).toBe('plugin');
  });

  it('revalidate:false 复用 startDir 结论（请求级实例），新实例仍重走', () => {
    write('.claude/plugins/foo/.claude-plugin/plugin.json', '{}');
    const hooks = write(
      '.claude/plugins/foo/hooks/hooks.json',
      JSON.stringify({ modules: [{ x: 1 }] }),
    );
    write('.claude/plugins/foo/commands/run.md', '# run');
    const rel = '.claude/plugins/foo/commands/run.md';
    const requestScoped = new PluginModsSniffer({ revalidate: false });

    expect(requestScoped.refine('plugin', rel, path.join(root, ...rel.split('/')))).toBe('mods');

    // 同请求内结论稳定：mtime 变化不触发重走（请求内文件视为稳定）
    writeFileSync(hooks, JSON.stringify({ modules: [] }));
    const future = new Date(Date.now() + 5000);
    utimesSync(hooks, future, future);
    expect(requestScoped.refine('plugin', rel, path.join(root, ...rel.split('/')))).toBe('mods');

    // 新实例（下一请求）重走 → 拾取最新 hooks.json
    const next = new PluginModsSniffer({ revalidate: false });
    expect(next.refine('plugin', rel, path.join(root, ...rel.split('/')))).toBe('plugin');
  });
});
