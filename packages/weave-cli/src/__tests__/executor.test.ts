import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir, lstat, readlink, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { executeInit } from '../init/executor';
import type { PromptPort } from '../init/prompt';

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
  it('does not overwrite an existing template file without force', async () => {
    // 用内置 command 模板验证 writeFileIfAbsent 语义（内置 skill 模板已移除）
    const cmdPath = path.join(tmpDir, '.claude', 'commands', 'review.md');
    await mkdir(path.dirname(cmdPath), { recursive: true });
    await writeFile(cmdPath, '# user custom content');

    const result = await executeInit({
      ...BASE_OPTIONS,
      targetDir: tmpDir,
      components: { commands: true }, // 默认 preset 不含 commands，显式打开以拷模板
    });
    expect(result.skipped).toContain(cmdPath);
    // File content preserved
    const content = await readFile(cmdPath, 'utf-8');
    expect(content).toBe('# user custom content');
  });

  it('overwrites an existing template file with force', async () => {
    const cmdPath = path.join(tmpDir, '.claude', 'commands', 'review.md');
    await mkdir(path.dirname(cmdPath), { recursive: true });
    await writeFile(cmdPath, '# user custom content');

    const result = await executeInit({
      ...BASE_OPTIONS,
      targetDir: tmpDir,
      force: true,
      components: { commands: true },
    });
    expect(result.skipped).not.toContain(cmdPath);
    expect(result.created.files).toContain(cmdPath);
  });

  // ---- P0-1: no dangling .mcp.json ----
  it('does not write .mcp.json when weave server is not enabled', async () => {
    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    // weave server defaults to false → no .mcp.json written
    expect(result.created.files).not.toContain(path.join(tmpDir, '.mcp.json'));
    // 未生成的文件也不得计入「跳过已有文件」（否则汇总误报 + --force 提示失效）
    expect(result.skipped).not.toContain(path.join(tmpDir, '.mcp.json'));
    await expect(stat(path.join(tmpDir, '.mcp.json'))).rejects.toThrow();
  });

  it('copies commands and agents for the full preset; skills 模板已移除为 0', async () => {
    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir, preset: 'full' });
    expect(result.summary.skillsCount).toBe(0);
    expect(result.summary.commandsCount).toBeGreaterThan(0);
    expect(result.summary.agentsCount).toBeGreaterThan(0);
    expect(result.created.files.some(f => f.includes('.claude') && f.includes('commands'))).toBe(true);
    // 不再注入任何内置 skill 文件
    expect(result.created.files.some(f => f.includes(`${path.sep}skills${path.sep}`))).toBe(false);
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
    // 旧版本戳被替换（不断言不含 'old' 子串——正文注释里合法出现，见 drop-oldest）
    expect(content).not.toContain('@version weave@0.0.1');
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

  it('按标记清扫：带 weave 版本戳但不在本次清单的遗留脚本被移除，用户文件保留', async () => {
    const helpersDir = path.join(tmpDir, '.claude', 'helpers');
    await mkdir(helpersDir, { recursive: true });
    const legacy = path.join(helpersDir, 'legacy-hook.cjs');
    const userFile = path.join(helpersDir, 'my-local.cjs');
    await writeFile(legacy, '// @version weave@0.0.1\nold generated script\n');
    await writeFile(userFile, '# user authored, no marker\n');

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.removed).toContain(legacy);
    await expect(stat(legacy)).rejects.toThrow(); // 已删除
    expect(await readFile(userFile, 'utf-8')).toBe('# user authored, no marker\n');
    // 本次清单内的文件不受清扫影响
    expect(await readFile(path.join(helpersDir, 'hook-handler.cjs'), 'utf-8')).toContain('@version weave@');
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

// ---- 真实 git 集成：init 后交互式询问 commit（git-commit.ts 的九闸走真 git）----
describe('executeInit — 询问 commit（真实 git 集成）', () => {
  const hasGit = (() => {
    try {
      return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
    } catch {
      return false;
    }
  })();

  const git = (dir: string, ...args: string[]): string =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf-8' }).stdout ?? '';

  const head = (dir: string): string => git(dir, 'rev-parse', 'HEAD').trim();

  const makePrompt = (confirmAnswer: boolean): PromptPort => ({
    confirm: vi.fn(async () => confirmAnswer),
    multiselect: vi.fn(async <T extends string>(_o: readonly T[], d: readonly T[]) => [...d]),
  });

  /** 临时 git 仓库 + 局部 user 身份 + 基线提交（避免 unborn HEAD 主导语义）。 */
  async function makeRepo(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'weave-git-init-'));
    git(dir, 'init');
    git(dir, 'config', 'user.name', 'weave-test');
    git(dir, 'config', 'user.email', 'weave@test.local');
    await writeFile(path.join(dir, 'README.md'), 'baseline\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'baseline');
    return dir;
  }

  /** 临时把 stdin/stdout 标成 TTY（executor 交互闸），用完还原。 */
  async function withTTY<T>(run: () => Promise<T>): Promise<T> {
    const origIn = process.stdin.isTTY;
    const origOut = process.stdout.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    try {
      return await run();
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = origIn;
      (process.stdout as { isTTY?: boolean }).isTTY = origOut;
    }
  }

  it.skipIf(!hasGit)('confirm=y → 仅 init 产物入库（嵌套 gitignore 裁剪生效）', async () => {
    const dir = await makeRepo();
    try {
      const prompt = makePrompt(true);
      const before = head(dir);
      const out = await withTTY(() =>
        executeInit({ ...BASE_OPTIONS, targetDir: dir, interactive: true }, prompt),
      );
      expect(out.success).toBe(true);
      expect(prompt.confirm).toHaveBeenCalledTimes(1);
      expect(head(dir)).not.toBe(before);

      const files = git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
      expect(files).toEqual(
        expect.arrayContaining(['CLAUDE.md', 'AGENTS.md', '.claude/.gitignore', '.weave/.gitignore']),
      );
      // 嵌套 .gitignore 内容（* / !.gitignore）阻止其余产物入库
      expect(files).not.toContain('.claude/settings.json');
      expect(files).not.toContain('.weave/config.yaml');
      // 提交后候选路径工作区干净
      expect(
        git(dir, 'status', '--porcelain', '--', 'CLAUDE.md', 'AGENTS.md', '.claude', '.weave').trim(),
      ).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGit)('confirm=n → 无新 commit、index 干净（declined 零残留）', async () => {
    const dir = await makeRepo();
    try {
      const prompt = makePrompt(false);
      const before = head(dir);
      await withTTY(() =>
        executeInit({ ...BASE_OPTIONS, targetDir: dir, interactive: true }, prompt),
      );
      expect(prompt.confirm).toHaveBeenCalledTimes(1);
      expect(head(dir)).toBe(before);
      expect(
        spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: dir }).status,
      ).toBe(0); // 无任何暂存残留
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGit)('非 TTY → confirm 根本不被调用、无 commit（防静默 true 自动提交）', async () => {
    const dir = await makeRepo();
    try {
      const prompt = makePrompt(true); // 假 confirm 返回 true——非 TTY 仍不得提交
      const before = head(dir);
      await executeInit({ ...BASE_OPTIONS, targetDir: dir, interactive: true }, prompt);
      expect(prompt.confirm).not.toHaveBeenCalled();
      expect(head(dir)).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGit)('二次 init 幂等 → 候选路径无变化，confirm 不再被调用（只问一次）', async () => {
    const dir = await makeRepo();
    try {
      const first = makePrompt(true);
      await withTTY(() =>
        executeInit({ ...BASE_OPTIONS, targetDir: dir, interactive: true }, first),
      );
      expect(first.confirm).toHaveBeenCalledTimes(1);
      const afterFirst = head(dir);

      const second = makePrompt(true);
      await withTTY(() =>
        executeInit({ ...BASE_OPTIONS, targetDir: dir, interactive: true }, second),
      );
      expect(second.confirm).not.toHaveBeenCalled(); // status 对候选路径为空 → 不提问
      expect(head(dir)).toBe(afterFirst); // 也没有产生空 commit
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
