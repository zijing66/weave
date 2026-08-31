import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectFile, resolveProjectFile, PathEscapeError } from '../reader.js';
import { AssetNotFoundError } from '../installer.js';

describe('reader — path safety', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-reader-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rejects absolute paths', () => {
    expect(() => resolveProjectFile(dir, join(tmpdir(), 'passwd'))).toThrow(PathEscapeError);
  });

  it('rejects parent traversal', () => {
    expect(() => resolveProjectFile(dir, '../escape')).toThrow(PathEscapeError);
    expect(() => resolveProjectFile(dir, '.claude/../../escape')).toThrow(PathEscapeError);
  });

  it('rejects paths outside allowed roots', () => {
    expect(() => resolveProjectFile(dir, 'package.json')).toThrow(PathEscapeError);
    expect(() => resolveProjectFile(dir, 'src/index.ts')).toThrow(PathEscapeError);
  });

  it('allows .claude/, .mcp.json, CLAUDE.md', () => {
    expect(() => resolveProjectFile(dir, '.claude/skills/foo/SKILL.md')).not.toThrow();
    expect(() => resolveProjectFile(dir, '.mcp.json')).not.toThrow();
    expect(() => resolveProjectFile(dir, 'CLAUDE.md')).not.toThrow();
  });
});

describe('reader — readProjectFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-reader-'));
    mkdirSync(join(dir, '.claude/skills/foo'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/foo/SKILL.md'), '# Title\nbody');
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{}}');
    writeFileSync(join(dir, 'CLAUDE.md'), '# Proj');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a skill SKILL.md', async () => {
    const f = await readProjectFile(dir, '.claude/skills/foo/SKILL.md');
    expect(f.content).toBe('# Title\nbody');
    expect(f.size).toBeGreaterThan(0);
  });

  it('reads .mcp.json and CLAUDE.md', async () => {
    expect((await readProjectFile(dir, '.mcp.json')).content).toContain('mcpServers');
    expect((await readProjectFile(dir, 'CLAUDE.md')).content).toBe('# Proj');
  });

  it('throws AssetNotFoundError for missing files', async () => {
    await expect(
      readProjectFile(dir, '.claude/skills/none/SKILL.md'),
    ).rejects.toBeInstanceOf(AssetNotFoundError);
  });

  it('throws PathEscapeError for traversal', async () => {
    await expect(readProjectFile(dir, '../etc/passwd')).rejects.toBeInstanceOf(PathEscapeError);
  });
});
