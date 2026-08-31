import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanLibrarySkills } from '../scanner.js';

describe('scanLibrarySkills', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-scan-'));
    mkdirSync(join(root, 'skill-a'), { recursive: true });
    writeFileSync(join(root, 'skill-a', 'SKILL.md'), '# A');
    // skill with a subtree — must NOT be descended into.
    mkdirSync(join(root, 'skill-b', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'skill-b', 'SKILL.md'), '# B');
    writeFileSync(join(root, 'skill-b', 'scripts', 'x.py'), 'print(1)');
    // a skill nested deeper.
    mkdirSync(join(root, 'nested', 'dir', 'skill-c'), { recursive: true });
    writeFileSync(join(root, 'nested', 'dir', 'skill-c', 'SKILL.md'), '# C');
    // node_modules must be skipped.
    mkdirSync(join(root, 'node_modules', 'skip'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'skip', 'SKILL.md'), '# skip');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds every directory containing a SKILL.md', async () => {
    const skills = await scanLibrarySkills(root);
    expect(skills.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b', 'skill-c']);
  });

  it('does not descend into a skill subtree', async () => {
    const skills = await scanLibrarySkills(root);
    expect(skills.find((s) => s.name === 'scripts')).toBeUndefined();
  });

  it('skips node_modules', async () => {
    const skills = await scanLibrarySkills(root);
    expect(skills.find((s) => s.name === 'skip')).toBeUndefined();
  });

  it('returns absolute dirPath and posix relPath', async () => {
    const skills = await scanLibrarySkills(root);
    const a = skills.find((s) => s.name === 'skill-a')!;
    expect(a.dirPath).toBe(join(root, 'skill-a'));
    expect(a.relPath).toBe('skill-a');
  });

  it('groups skills by their parent directory', async () => {
    const skills = await scanLibrarySkills(root);
    const a = skills.find((s) => s.name === 'skill-a')!;
    const c = skills.find((s) => s.name === 'skill-c')!;
    // skill-a sits directly under the root → empty group
    expect(a.group).toBe('');
    // skill-c sits under nested/dir → its parent is the group
    expect(c.group).toBe('nested/dir');
  });

  it('returns an empty list for an unreadable path', async () => {
    expect(await scanLibrarySkills(join(root, 'does-not-exist'))).toEqual([]);
  });
});
