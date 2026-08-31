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
});
