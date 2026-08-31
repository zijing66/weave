import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { buildLibraryIndex } from '../library-index.js';
import { FingerprintCache } from '../fingerprint.js';
import { applyUpdate, syncAll } from '../apply-update.js';
import { LibraryRepository } from '../../repositories/libraries.js';
import { openDatabase } from '../../db/db.js';
import type { DatabaseSync } from 'node:sqlite';

// Isolate HOME so global-config writes never touch the real ~/.claude.
let fakeHome: string;
let db: DatabaseSync;
let libraries: LibraryRepository;

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'weave-au-home-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  db = openDatabase(':memory:');
  libraries = new LibraryRepository(db);
});
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  db.close();
});

describe('applyUpdate — skill (project scope)', () => {
  let project: string;
  let libDir: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'weave-au-proj-'));
    libDir = mkdtempSync(join(tmpdir(), 'weave-au-lib-'));
    mkdirSync(join(libDir, 'foo'), { recursive: true });
    writeFileSync(join(libDir, 'foo', 'SKILL.md'), '# Foo v1');
    // install v1 into project
    mkdirSync(join(project, '.claude/skills/foo'), { recursive: true });
    cpSync(join(libDir, 'foo'), join(project, '.claude/skills/foo'), { recursive: true });
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(libDir, { recursive: true, force: true });
  });

  it('overwrites the installed skill with the current source', async () => {
    writeFileSync(join(libDir, 'foo', 'SKILL.md'), '# Foo v2');
    const lib = libraries.add({ path: libDir, kind: 'skill' });
    const index = await buildLibraryIndex([lib]);
    await applyUpdate(project, { category: 'skill', name: 'foo', scope: 'project' }, index);
    expect(readFileSync(join(project, '.claude/skills/foo/SKILL.md'), 'utf-8')).toBe('# Foo v2');
  });

  it('throws when no library source matches', async () => {
    const lib = libraries.add({ path: libDir, kind: 'skill' });
    const index = await buildLibraryIndex([lib]);
    await expect(
      applyUpdate(project, { category: 'skill', name: 'nope', scope: 'project' }, index),
    ).rejects.toThrow(/No library source/);
  });
});

describe('syncAll — batches all outdated', () => {
  let project: string;
  let libDir: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'weave-au-sync-'));
    libDir = mkdtempSync(join(tmpdir(), 'weave-au-synclib-'));
    // two skills
    for (const n of ['a', 'b']) {
      mkdirSync(join(libDir, n), { recursive: true });
      writeFileSync(join(libDir, n, 'SKILL.md'), `# ${n} v1`);
      mkdirSync(join(project, `.claude/skills/${n}`), { recursive: true });
      cpSync(join(libDir, n), join(project, `.claude/skills/${n}`), { recursive: true });
    }
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(libDir, { recursive: true, force: true });
  });

  it('updates only outdated skills, leaves up-to-date ones alone', async () => {
    // mutate only 'a' in the library
    writeFileSync(join(libDir, 'a', 'SKILL.md'), '# a v2');
    const lib = libraries.add({ path: libDir, kind: 'skill' });
    const libs = [lib];
    const cache = new FingerprintCache();
    const result = await syncAll(project, libs, cache);
    expect(result.updated.map((u) => u.name)).toEqual(['a']);
    expect(readFileSync(join(project, '.claude/skills/a/SKILL.md'), 'utf-8')).toBe('# a v2');
    expect(readFileSync(join(project, '.claude/skills/b/SKILL.md'), 'utf-8')).toBe('# b v1');
  });
});

describe('applyUpdate — skill (global scope)', () => {
  let libDir: string;
  beforeEach(() => {
    libDir = mkdtempSync(join(tmpdir(), 'weave-au-globlib-'));
    mkdirSync(join(libDir, 'gskill'), { recursive: true });
    writeFileSync(join(libDir, 'gskill', 'SKILL.md'), '# G v2');
    // pre-install v1 globally
    mkdirSync(join(fakeHome, '.claude/skills/gskill'), { recursive: true });
    writeFileSync(join(fakeHome, '.claude/skills/gskill/SKILL.md'), '# G v1');
  });
  afterEach(() => {
    rmSync(libDir, { recursive: true, force: true });
    rmSync(join(fakeHome, '.claude/skills/gskill'), { recursive: true, force: true });
  });

  it('overwrites the global skill from source', async () => {
    const lib = libraries.add({ path: libDir, kind: 'skill' });
    const index = await buildLibraryIndex([lib]);
    await applyUpdate({} as string, { category: 'skill', name: 'gskill', scope: 'global' }, index);
    expect(readFileSync(join(fakeHome, '.claude/skills/gskill/SKILL.md'), 'utf-8')).toBe('# G v2');
  });
});

describe('applyUpdate — mcp (project scope)', () => {
  let project: string;
  let libDir: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'weave-au-mcp-'));
    libDir = mkdtempSync(join(tmpdir(), 'weave-au-mcplib-'));
    mkdirSync(join(libDir, 'mcp'), { recursive: true });
    writeFileSync(join(libDir, 'mcp', 'svc.json'), JSON.stringify({ command: 'npx', args: ['v2'] }));
    // project has v1
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { svc: { command: 'npx', args: ['v1'] } } }));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(libDir, { recursive: true, force: true });
  });

  it('overwrites the mcp entry with the template value', async () => {
    const lib = libraries.add({ path: libDir, kind: 'both' });
    const index = await buildLibraryIndex([lib]);
    await applyUpdate(project, { category: 'mcp', name: 'svc', scope: 'project' }, index);
    const json = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf-8'));
    expect(json.mcpServers.svc.args).toEqual(['v2']);
  });
});

// sanity: homedir isolation is actually in effect
describe('homedir isolation', () => {
  it('HOME points at the fake home', () => {
    expect(process.env.HOME).toBe(fakeHome);
    expect(homedir()).toBe(fakeHome);
  });
});
