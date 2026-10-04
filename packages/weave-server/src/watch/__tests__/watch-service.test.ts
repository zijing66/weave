import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { WatchService, shouldIgnore } from '../watch-service.js';

vi.setConfig({ testTimeout: 20000 });

describe('shouldIgnore', () => {
  it.each<[string, boolean]>([
    ['.', false],
    ['', false],
    ['.mcp.json', false],
    ['.claude', false],
    ['.claude/skills/foo/SKILL.md', false],
    ['.weave/token', false],
    ['node_modules', true],
    ['node_modules/x', true],
    ['.git', true],
    ['.claude/projects/abc', true],
    ['.claude/cache/x', true],
    ['package.json', true],
    ['src/index.ts', true],
  ])('shouldIgnore(%j) === %s', (rel, expected) => {
    expect(shouldIgnore(rel)).toBe(expected);
  });
});

describe('WatchService', () => {
  let db: DatabaseSync;
  let projects: ProjectRepository;
  let projectDir: string;
  let watch: WatchService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    projectDir = mkdtempSync(path.join(tmpdir(), 'weave-watch-'));
    projects.register({ path: projectDir, name: 'test', token: 't', source: 'init' });
    watch = new WatchService(projects, { debounceMs: 30, reconcileMs: 60_000 });
  });

  afterEach(() => {
    watch.stop();
    db.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('caches existing files during the initial scan', async () => {
    mkdirSync(path.join(projectDir, '.claude', 'skills', 'foo'), { recursive: true });
    writeFileSync(path.join(projectDir, '.claude', 'skills', 'foo', 'SKILL.md'), '# Foo');
    writeFileSync(path.join(projectDir, '.mcp.json'), '{}');

    watch.start();
    await vi.waitFor(() => expect(watch.getAssets(projectDir).length).toBeGreaterThanOrEqual(2), {
      timeout: 5000,
    });

    const assets = watch.getAssets(projectDir);
    expect(assets.find((a) => a.relPath === '.claude/skills/foo/SKILL.md')?.category).toBe('skill');
    expect(assets.find((a) => a.relPath === '.mcp.json')?.category).toBe('mcp');
  });

  it('emits a change event when a file is added', async () => {
    watch.start();
    await vi.waitFor(() => expect(watch.getAssets(projectDir).length).toBe(0), {
      timeout: 3000,
    });

    const events: Array<{ category: string; kind: string }> = [];
    const unsub = watch.subscribe((e) => events.push(e));

    mkdirSync(path.join(projectDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(projectDir, '.claude', 'commands', 'review.md'), 'x');

    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 5000 });
    unsub();

    expect(events.some((e) => e.category === 'command' && e.kind === 'add')).toBe(true);
  });

  it('removes an entry from cache on unlink', async () => {
    mkdirSync(path.join(projectDir, '.claude', 'skills', 'foo'), { recursive: true });
    const file = path.join(projectDir, '.claude', 'skills', 'foo', 'SKILL.md');
    writeFileSync(file, '# Foo');

    watch.start();
    await vi.waitFor(() => expect(watch.getAssets(projectDir).length).toBeGreaterThanOrEqual(1), {
      timeout: 5000,
    });

    unlinkSync(file);
    await vi.waitFor(
      () => {
        const assets = watch.getAssets(projectDir);
        expect(assets.find((a) => a.relPath === '.claude/skills/foo/SKILL.md')).toBeUndefined();
      },
      { timeout: 5000 },
    );
  });

  it('classifies files of a mods plugin package as mods in cache and event frames', async () => {
    const pkg = path.join(projectDir, '.claude', 'plugins', 'foo');
    mkdirSync(path.join(pkg, '.claude-plugin'), { recursive: true });
    mkdirSync(path.join(pkg, 'hooks'), { recursive: true });
    mkdirSync(path.join(pkg, 'commands'), { recursive: true });
    writeFileSync(path.join(pkg, '.claude-plugin', 'plugin.json'), '{}');
    writeFileSync(path.join(pkg, 'hooks', 'hooks.json'), JSON.stringify({ modules: [{ x: 1 }] }));
    writeFileSync(path.join(pkg, 'commands', 'run.md'), '# run');

    const frames: Array<{ relPath: string; category: string }> = [];
    const unsub = watch.subscribe((e) => frames.push(e));
    watch.start();

    const rel = '.claude/plugins/foo/commands/run.md';
    await vi.waitFor(
      () => expect(watch.getAssets(projectDir).find((a) => a.relPath === rel)?.category).toBe('mods'),
      { timeout: 8000 },
    );
    await vi.waitFor(() => expect(frames.some((f) => f.relPath === rel && f.category === 'mods')).toBe(true), {
      timeout: 8000,
    });
    unsub();
    expect(watch.getAssets(projectDir).find((a) => a.relPath === rel)?.category).toBe('mods');
  });

  it('keeps a plain plugin package as plugin', async () => {
    const pkg = path.join(projectDir, '.claude', 'plugins', 'plain');
    mkdirSync(path.join(pkg, '.claude-plugin'), { recursive: true });
    mkdirSync(path.join(pkg, 'commands'), { recursive: true });
    writeFileSync(path.join(pkg, '.claude-plugin', 'plugin.json'), '{}');
    writeFileSync(path.join(pkg, 'commands', 'run.md'), '# run');

    watch.start();
    const rel = '.claude/plugins/plain/commands/run.md';
    await vi.waitFor(
      () => expect(watch.getAssets(projectDir).find((a) => a.relPath === rel)?.category).toBe('plugin'),
      { timeout: 8000 },
    );
  });

  it('reconcile stops watchers for projects removed from the registry', async () => {
    mkdirSync(path.join(projectDir, '.claude', 'skills', 'foo'), { recursive: true });
    writeFileSync(path.join(projectDir, '.claude', 'skills', 'foo', 'SKILL.md'), '# Foo');
    watch.start();
    await vi.waitFor(() => expect(watch.getAssets(projectDir).length).toBeGreaterThanOrEqual(1), {
      timeout: 5000,
    });

    const [proj] = projects.list();
    projects.remove(proj.id);
    watch.reconcile();

    expect(watch.getAssets(projectDir)).toHaveLength(0);
  });

  it('emits project added/removed frames when the registry changes', async () => {
    watch.start(); // initial reconcile registers projectDir before we subscribe
    const frames: Array<{ action: string; projectPath: string }> = [];
    const unsub = watch.subscribeProjects((e) => frames.push(e));

    // Register a second project (simulates `weave init` in another process).
    const dir2 = mkdtempSync(path.join(tmpdir(), 'weave-watch2-'));
    try {
      projects.register({ path: dir2, name: 'second', token: 't2', source: 'init' });
      watch.reconcile();
      await vi.waitFor(() =>
        expect(frames.some((f) => f.action === 'added' && f.projectPath === dir2)).toBe(true),
      );

      // Stable state: a repeat reconcile must not re-emit for known watchers.
      watch.reconcile();
      expect(frames.filter((f) => f.action === 'added' && f.projectPath === dir2)).toHaveLength(1);

      const [proj] = projects.list().filter((p) => p.path === dir2);
      projects.remove(proj.id);
      watch.reconcile();
      await vi.waitFor(() =>
        expect(frames.some((f) => f.action === 'removed' && f.projectPath === dir2)).toBe(true),
      );
    } finally {
      unsub();
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
