import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeInit } from '../init/executor';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'weave-exec-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const BASE_OPTIONS = {
  targetDir: '' as string,
  force: false,
  interactive: false,
  preset: 'default' as const,
  components: {},
  hooks: {},
  skills: {},
  commands: {},
  agents: {},
  mcp: {},
};

describe('executeInit', () => {
  it('creates the .claude directory structure', async () => {
    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.success).toBe(true);
    expect(result.created.directories).toContain(path.join(tmpDir, '.claude'));
  });

  it('writes settings.json and CLAUDE.md', async () => {
    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.created.files).toContain(path.join(tmpDir, '.claude', 'settings.json'));
    expect(result.created.files).toContain(path.join(tmpDir, 'CLAUDE.md'));
  });

  // ---- P0-2: no overwrite without --force ----
  it('does not overwrite an existing skill file without force', async () => {
    // Create a user-modified skill first
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'code-review', 'SKILL.md');
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, '# user custom content');

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.skipped).toContain(skillPath);
    // File content preserved
    const content = await readFile(skillPath, 'utf-8');
    expect(content).toBe('# user custom content');
  });

  it('overwrites an existing skill file with force', async () => {
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'code-review', 'SKILL.md');
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, '# user custom content');

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir, force: true });
    expect(result.skipped).not.toContain(skillPath);
    expect(result.created.files).toContain(skillPath);
  });

  // ---- P0-1: no dangling .mcp.json ----
  it('does not write .mcp.json when weave server is not enabled', async () => {
    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    // weave server defaults to false → no .mcp.json written
    expect(result.created.files).not.toContain(path.join(tmpDir, '.mcp.json'));
    await expect(stat(path.join(tmpDir, '.mcp.json'))).rejects.toThrow();
  });

  it('copies skills, commands, and agents for the full preset', async () => {
    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir, preset: 'full' });
    expect(result.summary.skillsCount).toBeGreaterThan(0);
    expect(result.summary.commandsCount).toBeGreaterThan(0);
    expect(result.summary.agentsCount).toBeGreaterThan(0);
    expect(result.created.files.some(f => f.includes('.claude') && f.includes('skills'))).toBe(true);
  });

  // ---- Step 10: .gitignore excludes .weave/ ----
  it('creates a .gitignore ignoring .weave/ when none exists', async () => {
    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const gitignorePath = path.join(tmpDir, '.gitignore');
    expect(result.created.files).toContain(gitignorePath);
    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toContain('.weave/');
  });

  it('appends .weave/ to an existing .gitignore without duplicating', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    await writeFile(gitignorePath, 'node_modules/\n');

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.created.files).toContain(gitignorePath);
    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toContain('.weave/');
    expect(content).toContain('node_modules/'); // user entries preserved
    expect(content.match(/\.weave\//g)?.length).toBe(1);
  });

  it('leaves a .gitignore that already ignores .weave/ untouched', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    const original = '.weave/\nnode_modules/\n';
    await writeFile(gitignorePath, original);

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.skipped).toContain(gitignorePath);
    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toBe(original);
  });
});
