import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { WatchService, shouldIgnore } from '../watch-service.js';
import type { AssetChangeEvent } from '../types.js';

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

describe('WatchService 全局技能根（目录级递归监听）', () => {
  let db: DatabaseSync;
  let root: string;
  let outside: string;
  let watch: WatchService;
  let events: AssetChangeEvent[];

  /** 已入队的全局事件（[根内相对路径, kind]）。 */
  const paths = () => events.map((e): [string, string] => [e.relPath, e.kind]);

  beforeEach(() => {
    events = [];
    db = openDatabase(':memory:');
    root = mkdtempSync(path.join(tmpdir(), 'weave-groot-'));
    outside = mkdtempSync(path.join(tmpdir(), 'weave-greal-'));
    watch = new WatchService(new ProjectRepository(db), {
      debounceMs: 30,
      reconcileMs: 60_000,
      globalRootSource: () => [{ harness: 'claude', root }],
    });
    watch.subscribe((e) => events.push(e));
  });

  afterEach(() => {
    watch.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('软链技能目录里改文件：事件按软链路径形入队（真身不改路径）', async () => {
    mkdirSync(path.join(outside, 'scripts'), { recursive: true });
    const file = path.join(outside, 'scripts', 'a.py');
    writeFileSync(file, 'x');
    symlinkSync(outside, path.join(root, 'skill-a'), 'junction');
    watch.start();

    writeFileSync(file, 'y');
    await vi.waitFor(() => expect(paths().some(([r]) => r === 'skill-a/scripts/a.py')).toBe(true), {
      timeout: 5000,
    });

    const e = events.find((x) => x.relPath === 'skill-a/scripts/a.py')!;
    expect(e.projectPath).toBe('<global>');
    expect(e.absPath).toBe(path.join(root, 'skill-a', 'scripts', 'a.py'));
    expect(e.category).toBe('skill');
    expect(e.agent).toBe('claude');
  });

  it('新文件入队、删除入队为 unlink', async () => {
    mkdirSync(path.join(root, 'skill-a'), { recursive: true });
    watch.start();

    const file = path.join(root, 'skill-a', 'x.md');
    writeFileSync(file, 'x');
    await vi.waitFor(() => expect(paths().some(([r]) => r === 'skill-a/x.md')).toBe(true), {
      timeout: 5000,
    });

    events = [];
    unlinkSync(file);
    await vi.waitFor(
      () => expect(paths().some(([r, k]) => r === 'skill-a/x.md' && k === 'unlink')).toBe(true),
      { timeout: 5000 },
    );
  });

  it('直接落在根里的文件也入队', async () => {
    watch.start();
    writeFileSync(path.join(root, 'notes.md'), 'x');
    await vi.waitFor(() => expect(paths().some(([r]) => r === 'notes.md')).toBe(true), {
      timeout: 5000,
    });
  });

  it('隐藏路径段不观测（隐藏目录条目 / 目录内的隐藏文件）', async () => {
    mkdirSync(path.join(root, 'skill-a', '.git'), { recursive: true });
    mkdirSync(path.join(root, '.hidden-dir'), { recursive: true });
    watch.start();

    writeFileSync(path.join(root, 'skill-a', '.git', 'index'), 'x');
    writeFileSync(path.join(root, '.hidden-dir', 'a.md'), 'x');
    writeFileSync(path.join(root, 'skill-a', 'visible.md'), 'x');

    await vi.waitFor(() => expect(paths().some(([r]) => r === 'skill-a/visible.md')).toBe(true), {
      timeout: 5000,
    });
    expect(paths().some(([r]) => r.includes('.git') || r.includes('.hidden-dir'))).toBe(false);
  });

  it('悬空软链条目被跳过（启动不抛）', () => {
    const gone = mkdtempSync(path.join(tmpdir(), 'weave-gone-'));
    symlinkSync(gone, path.join(root, 'dangling'), 'junction');
    rmSync(gone, { recursive: true, force: true });

    expect(() => watch.start()).not.toThrow();
    expect(events).toEqual([]);
  });

  it('reconcile 收上新装的技能目录', async () => {
    watch.start();
    mkdirSync(path.join(root, 'skill-new', 'scripts'), { recursive: true });
    watch.reconcile();

    writeFileSync(path.join(root, 'skill-new', 'scripts', 'b.py'), 'x');
    await vi.waitFor(() => expect(paths().some(([r]) => r === 'skill-new/scripts/b.py')).toBe(true), {
      timeout: 5000,
    });
  });
});
