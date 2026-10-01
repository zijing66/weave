import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir, lstat, readlink, readdir } from 'node:fs/promises';
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

  // ---- Step 10: .weave/ ignore goes to .git/info/exclude, never .gitignore ----
  it('never creates or touches .gitignore outside a git repository', async () => {
    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const gitignorePath = path.join(tmpDir, '.gitignore');
    expect(result.created.files).not.toContain(gitignorePath);
    await expect(stat(gitignorePath)).rejects.toThrow();
  });

  it('leaves an existing .gitignore byte-identical', async () => {
    const gitignorePath = path.join(tmpDir, '.gitignore');
    const original = 'node_modules/\n';
    await writeFile(gitignorePath, original);

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toBe(original);
  });

  // ---- Step 10: generated dirs carry a self-ignoring .gitignore ----
  it('writes a self-ignoring .gitignore into .claude/ and .weave/', async () => {
    await mkdir(path.join(tmpDir, '.git'), { recursive: true });

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    for (const dir of ['.claude', '.weave']) {
      const content = await readFile(path.join(tmpDir, dir, '.gitignore'), 'utf-8');
      expect(content).toContain('*');
      expect(content).toContain('!.gitignore');
    }
  });

  it('still never creates or touches the root .gitignore', async () => {
    await mkdir(path.join(tmpDir, '.git'), { recursive: true });
    const rootGitignore = path.join(tmpDir, '.gitignore');
    const original = 'node_modules/\n';
    await writeFile(rootGitignore, original);

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(await readFile(rootGitignore, 'utf-8')).toBe(original);
    expect(result.created.files).not.toContain(rootGitignore);
  });

  it('leaves .git/info/exclude alone', async () => {
    await mkdir(path.join(tmpDir, '.git', 'info'), { recursive: true });
    const excludePath = path.join(tmpDir, '.git', 'info', 'exclude');
    await writeFile(excludePath, '# user content\n');

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(await readFile(excludePath, 'utf-8')).toBe('# user content\n');
  });

  it('is idempotent — re-init keeps the nested .gitignore byte-identical', async () => {
    await mkdir(path.join(tmpDir, '.git'), { recursive: true });

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const first = await readFile(path.join(tmpDir, '.claude', '.gitignore'), 'utf-8');
    const second = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(await readFile(path.join(tmpDir, '.claude', '.gitignore'), 'utf-8')).toBe(first);
    // already-correct file is not reported as recreated
    expect(second.created.files).not.toContain(path.join(tmpDir, '.claude', '.gitignore'));
  });

  // ---- Step 8: CLAUDE.md and AGENTS.md resolve to one file ----
  it('links AGENTS.md to CLAUDE.md on a fresh install', async () => {
    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });

    const link = await lstat(path.join(tmpDir, 'AGENTS.md'));
    expect(link.isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(tmpDir, 'AGENTS.md'))).toBe('CLAUDE.md');
    // the real file carries the content
    const content = await readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('weave:start');
    expect(content).toContain('## Skills');
  });

  it('adopts an existing AGENTS.md instead of overwriting it', async () => {
    const agents = path.join(tmpDir, 'AGENTS.md');
    await writeFile(agents, '# Project\n\nHand-written notes.\n');

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });

    const link = await lstat(path.join(tmpDir, 'CLAUDE.md'));
    expect(link.isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(tmpDir, 'CLAUDE.md'))).toBe('AGENTS.md');
    // the user's prose survives, weave's block is appended to it
    const content = await readFile(agents, 'utf-8');
    expect(content).toContain('Hand-written notes.');
    expect(content).toContain('weave:start');
  });

  it('replaces an AGENTS.md that duplicates a CLAUDE.md, backing it up first', async () => {
    await writeFile(path.join(tmpDir, 'CLAUDE.md'), '# Project\n\nClaude notes.\n');
    await writeFile(path.join(tmpDir, 'AGENTS.md'), '# Project\n\nAgent notes.\n');

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });

    const link = await lstat(path.join(tmpDir, 'AGENTS.md'));
    expect(link.isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(tmpDir, 'AGENTS.md'))).toBe('CLAUDE.md');

    // the displaced content is preserved under the self-ignored .weave/ dir
    const backups = await readdir(path.join(tmpDir, '.weave', 'backup'));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(tmpDir, '.weave', 'backup', backups[0]), 'utf-8')).toContain(
      'Agent notes.',
    );
  });

  it('is idempotent — an already-correct link is left alone', async () => {
    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const before = await readlink(path.join(tmpDir, 'AGENTS.md'));

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(await readlink(path.join(tmpDir, 'AGENTS.md'))).toBe(before);
    // no second backup was made
    await expect(readdir(path.join(tmpDir, '.weave', 'backup'))).rejects.toThrow();
  });

  // ---- settings.json merge (user file: append-only) ----
  it('merges weave settings into an existing settings.json, preserving user content', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const userSettings = {
      myOwnSetting: 42,
      permissions: { allow: ['Bash(git:*)'] },
      statusLine: { type: 'command', command: 'node /user/my-statusline.cjs' },
    };
    await writeFile(settingsPath, JSON.stringify(userSettings, null, 2) + '\n');

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.merged).toContain(settingsPath);

    const merged = JSON.parse(await readFile(settingsPath, 'utf-8'));
    // user content preserved
    expect(merged.myOwnSetting).toBe(42);
    expect(merged.permissions.allow).toContain('Bash(git:*)');
    expect(merged.statusLine.command).toContain('my-statusline.cjs');
    // weave entries appended
    const hooks = merged.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.PreToolUse[0].hooks[0].command).toContain('hook-handler.cjs');
    expect(merged.permissions.allow).toContain('Bash(pnpm:*)');
  });

  it('re-init of a weave-inited project is idempotent', async () => {
    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const once = await readFile(settingsPath, 'utf-8');

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const twice = await readFile(settingsPath, 'utf-8');
    expect(twice).toBe(once);
  });

  it('skips a corrupt settings.json instead of overwriting it', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const corrupt = '{ this is not json';
    await writeFile(settingsPath, corrupt);

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.skipped).toContain(settingsPath);
    expect(await readFile(settingsPath, 'utf-8')).toBe(corrupt);
  });

  // ---- helpers: weave-marked files refresh, user files skip ----
  it('refreshes a helper carrying the weave marker', async () => {
    const handlerPath = path.join(tmpDir, '.claude', 'helpers', 'hook-handler.cjs');
    await mkdir(path.dirname(handlerPath), { recursive: true });
    await writeFile(handlerPath, '// @version weave@0.0.1\nold\n');

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.updated).toContain(handlerPath);
    const content = await readFile(handlerPath, 'utf-8');
    expect(content).toContain('@version weave@0.1.0');
    expect(content).not.toContain('old');
  });

  it('leaves a user-customized helper at the same path untouched', async () => {
    const handlerPath = path.join(tmpDir, '.claude', 'helpers', 'hook-handler.cjs');
    await mkdir(path.dirname(handlerPath), { recursive: true });
    const custom = '# my own script\n';
    await writeFile(handlerPath, custom);

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.skipped).toContain(handlerPath);
    expect(await readFile(handlerPath, 'utf-8')).toBe(custom);
  });

  // ---- .weave/config.yaml: weave-owned, always refreshed ----
  it('overwrites .weave/config.yaml on re-init', async () => {
    const configPath = path.join(tmpDir, '.weave', 'config.yaml');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, 'initVersion: 0.0.1\n');

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.updated).toContain(configPath);
    const content = await readFile(configPath, 'utf-8');
    expect(content).toContain('initVersion: 0.1.0');
  });

  // ---- CLAUDE.md: user file, append-only block ----
  it('appends the weave block to an existing CLAUDE.md', async () => {
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const user = '# My existing project instructions\n';
    await writeFile(claudeMdPath, user);

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.merged).toContain(claudeMdPath);
    const content = await readFile(claudeMdPath, 'utf-8');
    expect(content).toContain('My existing project instructions');
    expect(content).toContain('<!-- weave:start -->');
    expect(content.match(/<!-- weave:start -->/g)?.length).toBe(1);
  });

  // ---- .mcp.json: user file, append-only servers ----
  it('merges the weave server into an existing .mcp.json', async () => {
    const mcpPath = path.join(tmpDir, '.mcp.json');
    await writeFile(mcpPath, JSON.stringify({
      mcpServers: { 'my-own': { command: 'foo' } },
    }, null, 2) + '\n');

    const result = await executeInit({
      ...BASE_OPTIONS,
      targetDir: tmpDir,
      mcp: { weave: true },
    });
    expect(result.merged).toContain(mcpPath);
    const merged = JSON.parse(await readFile(mcpPath, 'utf-8'));
    expect(merged.mcpServers['my-own']).toEqual({ command: 'foo' });
    expect(merged.mcpServers.weave).toBeDefined();
  });

  it('leaves a corrupt .mcp.json untouched', async () => {
    const mcpPath = path.join(tmpDir, '.mcp.json');
    const corrupt = 'not json';
    await writeFile(mcpPath, corrupt);

    const result = await executeInit({
      ...BASE_OPTIONS,
      targetDir: tmpDir,
      mcp: { weave: true },
    });
    expect(result.skipped).toContain(mcpPath);
    expect(await readFile(mcpPath, 'utf-8')).toBe(corrupt);
  });
});
