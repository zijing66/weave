import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installSkill,
  uninstallSkill,
  installMcp,
  uninstallMcp,
  InstallConflictError,
  AssetNotFoundError,
} from '../installer.js';

describe('installer — skill', () => {
  let project: string;
  const source = mkdtempSync(join(tmpdir(), 'weave-src-'));

  beforeAll(() => {
    mkdirSync(join(source, 'scripts'), { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '# skill');
    writeFileSync(join(source, 'scripts', 'run.py'), 'print(1)');
  });
  afterAll(() => rmSync(source, { recursive: true, force: true }));

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'weave-proj-'));
    mkdirSync(join(project, '.claude'), { recursive: true });
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it('copies the whole skill directory including subtrees', async () => {
    await installSkill(project, source, 'my-skill');
    expect(existsSync(join(project, '.claude', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.claude', 'skills', 'my-skill', 'scripts', 'run.py'))).toBe(
      true,
    );
  });

  it('throws InstallConflictError when already installed', async () => {
    await installSkill(project, source, 'dup');
    await expect(installSkill(project, source, 'dup')).rejects.toBeInstanceOf(
      InstallConflictError,
    );
  });

  it('uninstalls a skill directory', async () => {
    await installSkill(project, source, 'gone');
    await uninstallSkill(project, 'gone');
    expect(existsSync(join(project, '.claude', 'skills', 'gone'))).toBe(false);
  });

  it('throws AssetNotFoundError when uninstalling a missing skill', async () => {
    await expect(uninstallSkill(project, 'nope')).rejects.toBeInstanceOf(AssetNotFoundError);
  });

  it('rejects path-traversal names', async () => {
    await expect(installSkill(project, source, '../escape')).rejects.toThrow();
  });
});

describe('installer — mcp', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'weave-mcp-'));
    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { weave: { command: 'npx', args: ['weave'] } } }),
    );
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it('adds an entry preserving existing ones', async () => {
    await installMcp(project, 'foo', { command: 'node', args: ['svr.js'] });
    const json = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8'));
    expect(json.mcpServers.weave).toBeDefined();
    expect(json.mcpServers.foo).toEqual({ command: 'node', args: ['svr.js'] });
  });

  it('throws InstallConflictError when already configured', async () => {
    await installMcp(project, 'bar', { command: 'x' });
    await expect(installMcp(project, 'bar', { command: 'x' })).rejects.toBeInstanceOf(
      InstallConflictError,
    );
  });

  it('removes an entry preserving others', async () => {
    await installMcp(project, 'foo', { command: 'x' });
    await uninstallMcp(project, 'foo');
    const json = JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8'));
    expect(json.mcpServers.foo).toBeUndefined();
    expect(json.mcpServers.weave).toBeDefined();
  });

  it('throws AssetNotFoundError when removing a missing entry', async () => {
    await expect(uninstallMcp(project, 'nope')).rejects.toBeInstanceOf(AssetNotFoundError);
  });

  it('creates .mcp.json when absent', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'weave-empty-'));
    try {
      await installMcp(empty, 'fresh', { command: 'node' });
      const json = JSON.parse(readFileSync(join(empty, '.mcp.json'), 'utf8'));
      expect(json.mcpServers.fresh).toEqual({ command: 'node' });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
