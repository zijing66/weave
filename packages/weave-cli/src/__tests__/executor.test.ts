import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir, lstat, readlink, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { installUserCapture } from '@weavecode/harness';
import { WEAVE_VERSION } from '@weavecode/server';
import { executeInit } from '../init/executor';
import type { PromptPort } from '../init/prompt';

let tmpDir: string;
let homeDir: string;
let savedHome: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'weave-exec-test-'));
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'weave-exec-home-'));
  // user 档采集探测走 os.homedir()（detectPlatform）；指到临时 home，
  // 测试既不受开发机 ~/.claude/settings.json 影响，也不反写它。
  const key = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  savedHome = process.env[key];
  process.env[key] = homeDir;
});

afterEach(async () => {
  const key = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  if (savedHome === undefined) delete process.env[key];
  else process.env[key] = savedHome;
  await rm(tmpDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
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

  it('writes settings.json and the local instruction file', async () => {
    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.created.files).toContain(path.join(tmpDir, '.claude', 'settings.json'));
    expect(result.created.files).toContain(path.join(tmpDir, 'CLAUDE.local.md'));
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

  // ---- Step 10（2026-11-13 无污染裁决）：生成目录免登记全走 info/exclude，
  // 新装不再写嵌套 .gitignore（它本身是待提交项）----
  it('writes no nested .gitignore; generated dirs go to .git/info/exclude', async () => {
    await mkdir(path.join(tmpDir, '.git'), { recursive: true });

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    for (const dir of ['.claude', '.weave']) {
      await expect(readFile(path.join(tmpDir, dir, '.gitignore'), 'utf-8')).rejects.toThrow();
    }
    const exclude = await readFile(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('.claude/');
    expect(exclude).toContain('.weave/');
    expect(exclude).not.toContain('.weave/token');
  });

  it('keeps a user-edited nested .gitignore (narrow exceptions survive re-init)', async () => {
    await mkdir(path.join(tmpDir, '.git'), { recursive: true });
    const edited = '# weave — generated; do not commit\n*\n!.gitignore\n!plugins/\n!plugins/**\n';
    const nested = path.join(tmpDir, '.weave');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, '.gitignore'), edited);

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(await readFile(path.join(nested, '.gitignore'), 'utf-8')).toBe(edited);
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

  it('appends the weave block to .git/info/exclude, preserving user content', async () => {
    await mkdir(path.join(tmpDir, '.git', 'info'), { recursive: true });
    const excludePath = path.join(tmpDir, '.git', 'info', 'exclude');
    await writeFile(excludePath, '# user content\n');

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const text = await readFile(excludePath, 'utf-8');
    expect(text.startsWith('# user content\n')).toBe(true);
    expect(text).toContain('# weave:start');
    expect(text).toContain('CLAUDE.local.md');
    // 幂等：再跑一次不重复追加
    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(await readFile(excludePath, 'utf-8')).toBe(text);
  });

  it('is idempotent — re-init keeps the exclude block identical', async () => {
    await mkdir(path.join(tmpDir, '.git'), { recursive: true });

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const first = await readFile(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf-8');
    const second = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(await readFile(path.join(tmpDir, '.git', 'info', 'exclude'), 'utf-8')).toBe(first);
    expect(second.created.files).not.toContain(path.join(tmpDir, '.git', 'info', 'exclude'));
  });

  // ---- Step 6b: plugin templates bypass the core component switches ----
  it('injects project plugin templates even with agents/commands components off', async () => {
    const id = `exec-plug-${Date.now()}`;
    const plugDir = path.join(tmpDir, '.weave', 'plugins', id);
    await mkdir(path.join(plugDir, 'agents'), { recursive: true });
    await mkdir(path.join(plugDir, 'commands'), { recursive: true });
    await writeFile(
      path.join(plugDir, 'weave-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id,
        name: id,
        version: '0.1.0',
        templates: { agents: ['agents/my-agent.md'], commands: ['commands/my-cmd.md'] },
      }),
    );
    await writeFile(path.join(plugDir, 'agents', 'my-agent.md'), '---\nname: my-agent\ndescription: t\n---\nbody');
    await writeFile(path.join(plugDir, 'commands', 'my-cmd.md'), '# my-cmd');

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.success).toBe(true);
    expect(await readFile(path.join(tmpDir, '.claude', 'agents', 'my-agent.md'), 'utf-8')).toContain('my-agent');
    expect(await readFile(path.join(tmpDir, '.claude', 'commands', 'my-cmd.md'), 'utf-8')).toContain('my-cmd');
  });

  // ---- Step 8: local-first instruction files ----
  it('writes local instruction files on a fresh install; shared files untouched', async () => {
    const result = await executeInit({
      ...BASE_OPTIONS,
      targetDir: tmpDir,
      harnesses: ['claude', 'codex'],
    });

    const claudeLocal = await readFile(path.join(tmpDir, 'CLAUDE.local.md'), 'utf-8');
    expect(claudeLocal).toContain('weave:start');
    expect(claudeLocal).toContain('weave:end');
    expect(result.created.files).toContain(path.join(tmpDir, 'CLAUDE.local.md'));
    const override = await readFile(path.join(tmpDir, 'AGENTS.override.md'), 'utf-8');
    expect(override).toContain('weave:start');
    expect(result.created.files).toContain(path.join(tmpDir, 'AGENTS.override.md'));
    // 项目共享文件不再由 weave 生成
    await expect(stat(path.join(tmpDir, 'CLAUDE.md'))).rejects.toThrow();
    await expect(stat(path.join(tmpDir, 'AGENTS.md'))).rejects.toThrow();
  });

  it('merges the weave block into an existing AGENTS.md instead of writing the override', async () => {
    const agents = path.join(tmpDir, 'AGENTS.md');
    await writeFile(agents, '# Project\n\nHand-written notes.\n');

    const result = await executeInit({
      ...BASE_OPTIONS,
      targetDir: tmpDir,
      harnesses: ['claude', 'codex'],
    });

    // 用户内容逐字节保留、块追加在尾部
    const content = await readFile(agents, 'utf-8');
    expect(content.startsWith('# Project\n\nHand-written notes.\n')).toBe(true);
    expect(content).toContain('weave:start');
    expect(result.merged).toContain(agents);
    // 同目录 override 会压掉 AGENTS.md → 有共享文件时不写
    await expect(stat(path.join(tmpDir, 'AGENTS.override.md'))).rejects.toThrow();
    // claude 恒走 local
    expect(await readFile(path.join(tmpDir, 'CLAUDE.local.md'), 'utf-8')).toContain('weave:start');
  });

  it('is idempotent — re-init replaces the block in place instead of duplicating it', async () => {
    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const localPath = path.join(tmpDir, 'CLAUDE.local.md');
    const once = await readFile(localPath, 'utf-8');

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const twice = await readFile(localPath, 'utf-8');
    expect(twice).toBe(once);
    expect(twice.match(/weave:start/g)).toHaveLength(1);
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

  // ---- user 档采集接管：项目档不落 hooks，旧 weave 组一并清光 ----
  it('user 档采集已安装时项目档 hooks 落空、旧 weave 组清光', async () => {
    await installUserCapture({ home: homeDir, version: WEAVE_VERSION });

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const helpersDir = path.join(tmpDir, '.claude', 'helpers');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: '*', hooks: [{ type: 'command', command: `node "${helpersDir}/hook-handler.cjs"` }] },
            ],
          },
        },
        null,
        2,
      ) + '\n',
    );

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });

    const settings = JSON.parse(await readFile(settingsPath, 'utf-8'));
    // 空即清光：hooks 键在（merge 判据）、weave 组无（双采集已由 user 档接管）
    expect(settings.hooks).toEqual({});
  });

  // ---- helpers: weave-marked files refresh, user files skip ----
  it('refreshes a helper carrying the weave marker', async () => {
    const handlerPath = path.join(tmpDir, '.claude', 'helpers', 'hook-handler.cjs');
    await mkdir(path.dirname(handlerPath), { recursive: true });
    await writeFile(handlerPath, '// @version weave@0.0.1\nold\n');

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(result.updated).toContain(handlerPath);
    const content = await readFile(handlerPath, 'utf-8');
    expect(content).toContain(`@version weave@${WEAVE_VERSION}`);
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
    expect(content).toContain(`initVersion: ${WEAVE_VERSION}`);
  });

  // ---- CLAUDE.local.md: user file, append-only block; existing CLAUDE.md untouched ----
  it('writes the weave block to CLAUDE.local.md and leaves an existing CLAUDE.md alone', async () => {
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const user = '# My existing project instructions\n';
    await writeFile(claudeMdPath, user);

    const result = await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    // 用户 CLAUDE.md 一字不动（追加语义下 local 文件已足够）
    expect(await readFile(claudeMdPath, 'utf-8')).toBe(user);
    expect(result.merged).not.toContain(claudeMdPath);
    const localPath = path.join(tmpDir, 'CLAUDE.local.md');
    expect(result.created.files).toContain(localPath);
    const content = await readFile(localPath, 'utf-8');
    expect(content).toContain('<!-- weave:start -->');
    expect(content.match(/<!-- weave:start -->/g)?.length).toBe(1);
  });

  // ---- .mcp.json: weave server 生成已退役（daemon 托管 MCP）——init 不再写 ----
  it('weave server 退役后 init 不写 .mcp.json（用户文件零改动）', async () => {
    const mcpPath = path.join(tmpDir, '.mcp.json');
    const original = JSON.stringify({
      mcpServers: { 'my-own': { command: 'foo' } },
    }, null, 2) + '\n';
    await writeFile(mcpPath, original);

    const result = await executeInit({
      ...BASE_OPTIONS,
      targetDir: tmpDir,
      mcp: { weave: true },
    });
    expect(result.merged).not.toContain(mcpPath);
    expect(result.created.files).not.toContain(mcpPath);
    expect(await readFile(mcpPath, 'utf-8')).toBe(original);
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

  it.skipIf(!hasGit)('confirm=y → 仅 init 产物入库（exclude 无污染：候选全被挡，零提交零提问）', async () => {
    const dir = await makeRepo();
    try {
      const prompt = makePrompt(true);
      const before = head(dir);
      const out = await withTTY(() =>
        executeInit({ ...BASE_OPTIONS, targetDir: dir, interactive: true }, prompt),
      );
      expect(out.success).toBe(true);
      // 生成目录与指令文件全在 exclude 里 → status 候选为空 → 不提问不提交
      expect(prompt.confirm).not.toHaveBeenCalled();
      expect(head(dir)).toBe(before);
      // 生成物在盘上、但 git status 零痕迹（完全无污染）
      expect(
        git(dir, 'status', '--porcelain', '--', 'CLAUDE.local.md', 'AGENTS.override.md', '.claude', '.weave').trim(),
      ).toBe('');
      const exclude = git(dir, 'status', '--porcelain', '--ignored=matching', '--', '.claude', '.weave');
      void exclude;
      expect(await readFile(path.join(dir, '.claude', 'settings.json'), 'utf-8')).toBeTruthy();
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
      expect(prompt.confirm).not.toHaveBeenCalled();
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

  it.skipIf(!hasGit)('二次 init 幂等 → 候选路径恒空，两次都不提问（exclude 生效零候选）', async () => {
    const dir = await makeRepo();
    try {
      const first = makePrompt(true);
      await withTTY(() =>
        executeInit({ ...BASE_OPTIONS, targetDir: dir, interactive: true }, first),
      );
      expect(first.confirm).not.toHaveBeenCalled();
      const afterFirst = head(dir);

      const second = makePrompt(true);
      await withTTY(() =>
        executeInit({ ...BASE_OPTIONS, targetDir: dir, interactive: true }, second),
      );
      expect(second.confirm).not.toHaveBeenCalled();
      expect(head(dir)).toBe(afterFirst);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
