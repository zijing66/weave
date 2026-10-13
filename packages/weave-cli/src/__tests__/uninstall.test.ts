import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  mkdir,
  lstat,
  access,
  readdir,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  hookShardId,
  openDatabase,
  ProjectRepository,
  registerProject,
  SessionRepository,
} from '@weavecode/server';
import { executeInit } from '../init/executor';
import { executeUninstall } from '../init/uninstall';
import { COMMIT_MESSAGE } from '../init/git-commit';

let tmpDir: string;
let srvDir: string;
let dbPath: string;
let hooksDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'weave-uninstall-test-'));
  // server 注册表注入临时根（独立于项目目录：不污染 git status 断言）；
  // uninstall 现在会动真实注册表，测试绝不能碰
  srvDir = await mkdtemp(path.join(os.tmpdir(), 'weave-uninstall-srv-'));
  dbPath = path.join(srvDir, 'weave.db');
  hooksDir = path.join(srvDir, 'hooks');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  await rm(srvDir, { recursive: true, force: true });
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

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function git(args: string[], cwd = tmpDir): ReturnType<typeof spawnSync> {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return res;
}

/** 仿 init 收尾的提交面：固定候选路径逐路径 add（绝不 -A）+ 规定消息。 */
function commitInitOutputs(): void {
  git(['add', '--', 'CLAUDE.md', 'AGENTS.md', '.claude', '.weave']);
  git(['commit', '-m', COMMIT_MESSAGE]);
}

/** 统一走临时 server 根的卸载入口。 */
function uninstall(dir = tmpDir) {
  return executeUninstall({ targetDir: dir, dbPath, hooksDir });
}

/** 注册表里该路径的行；无则 undefined。 */
function projectRow(dir = tmpDir) {
  const db = openDatabase(dbPath);
  try {
    return new ProjectRepository(db).getByPath(dir);
  } finally {
    db.close();
  }
}

/** 在临时管道根落一个 mirror 文件（模拟 daemon 写出的注入镜像）。 */
async function seedMirrorFile(token: string): Promise<string> {
  const mirrorFile = path.join(hooksDir, 'mirror', `${hookShardId(token)}.json`);
  await mkdir(path.dirname(mirrorFile), { recursive: true });
  await writeFile(mirrorFile, '{"rules":[]}\n', 'utf-8');
  return mirrorFile;
}

describe('executeUninstall', () => {
  it('reports not-initialized when .weave is absent', async () => {
    const result = await uninstall();
    expect(result.status).toBe('not-initialized');
    expect(result.server.outcome).toBe('absent');
  });

  it('unregisters a server-registered project even when .weave is gone', async () => {
    // 用户场景：曾注册过、.weave/ 已被手动删掉——本地无事可做，但 server 行还在
    const reg = registerProject(tmpDir, 'init', dbPath);
    const db = openDatabase(dbPath);
    new SessionRepository(db).touch('sess-1', reg.id);
    db.close();
    const mirrorFile = await seedMirrorFile(reg.token);
    await rm(path.join(tmpDir, '.weave'), { recursive: true, force: true });

    const result = await uninstall();
    expect(result.status).toBe('not-initialized');
    expect(result.server.outcome).toBe('removed');
    expect(result.server.purged).toEqual({ events: 0, dispatches: 0, sessions: 1 });
    expect(projectRow()).toBeUndefined();
    expect(await exists(mirrorFile)).toBe(false);
  });

  it('unregisters the project from the server during a normal uninstall', async () => {
    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const reg = registerProject(tmpDir, 'init', dbPath);
    const mirrorFile = await seedMirrorFile(reg.token);

    const result = await uninstall();
    expect(result.status).toBe('ok');
    expect(result.server.outcome).toBe('removed');
    expect(projectRow()).toBeUndefined();
    expect(await exists(mirrorFile)).toBe(false);
  });

  it('removes everything a fresh init wrote (no git repo)', async () => {
    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    expect(await exists(path.join(tmpDir, '.weave'))).toBe(true);

    const result = await uninstall();
    expect(result.status).toBe('ok');
    expect(result.git).toBe('skipped-not-repo');

    // weave 生成面全清：.weave 整目录、.claude 整目录、指令文件对
    expect(await exists(path.join(tmpDir, '.weave'))).toBe(false);
    expect(await exists(path.join(tmpDir, '.claude'))).toBe(false);
    expect(await exists(path.join(tmpDir, 'CLAUDE.md'))).toBe(false);
    expect(await exists(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
    expect(result.keptUserFiles).toHaveLength(0);
  });

  it('preserves user-authored content while stripping weave bits', async () => {
    // 用户先在：自己的 hook 组、statusLine、permission 与 CLAUDE.md 正文
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const userSettings = {
      $comment: 'user note',
      hooks: {
        Stop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo user-hook' }],
          },
        ],
      },
      statusLine: { type: 'command', command: 'echo user-statusline' },
      permissions: { allow: ['Bash(user:*)'] },
      env: { USER_KEY: '1' },
    };
    await writeFile(settingsPath, JSON.stringify(userSettings, null, 2) + '\n');
    await writeFile(path.join(tmpDir, 'CLAUDE.md'), '# Project\n\nUser notes.\n\n');

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });

    const result = await uninstall();
    expect(result.status).toBe('ok');

    // settings.json 剥回用户原样（含 user hook/statusLine/permission/env）
    const after = JSON.parse(await readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
    expect(after).toEqual(userSettings);

    // CLAUDE.md 只剥 weave 段，正文保留
    const md = await readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(md).toContain('User notes.');
    expect(md).not.toContain('weave:start');
    expect(md).not.toContain(WEAVE_HEADER_TEXT);
    // AGENTS.md 链接摘掉
    expect(await exists(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
    // .claude 里只剩用户的东西（settings.json），空壳目录被回收
    expect((await readdir(path.join(tmpDir, '.claude'))).sort()).toEqual(['settings.json']);
    expect(result.keptUserFiles).toHaveLength(0);
  });

  it('keeps user-modified copies of weave templates and reports them', async () => {
    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir, components: { commands: true } });
    const commandPath = path.join(tmpDir, '.claude', 'commands', 'review.md');
    expect(await exists(commandPath)).toBe(true);
    await writeFile(commandPath, '# user rewrote this command\n');

    const result = await uninstall();
    expect(result.keptUserFiles).toContain(commandPath);
    expect(await readFile(commandPath, 'utf-8')).toBe('# user rewrote this command\n');
    // 用户改过的文件还在 → .claude 不回收
    expect(await exists(path.join(tmpDir, '.claude'))).toBe(true);
  });

  it('rolls the git pointer back when HEAD is the init commit', async () => {
    git(['init']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 't']);
    await writeFile(path.join(tmpDir, 'README.md'), 'base\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'base']);

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    commitInitOutputs();
    const initSha = git(['rev-parse', 'HEAD']).stdout.trim();
    expect(git(['log', '-1', '--format=%s']).stdout.trim()).toBe(COMMIT_MESSAGE);

    const result = await uninstall();
    expect(result.status).toBe('ok');
    expect(result.git).toBe('reset');

    // 指针回到 base 提交，历史只剩一笔，工作区干净
    expect(git(['rev-parse', 'HEAD']).stdout.trim()).not.toBe(initSha);
    expect(git(['log', '--oneline']).stdout.trim().split('\n')).toHaveLength(1);
    expect(git(['status', '--porcelain']).stdout.trim()).toBe('');
    expect(await exists(path.join(tmpDir, '.weave'))).toBe(false);
    expect(await exists(path.join(tmpDir, '.claude'))).toBe(false);
  });

  it('commits the removal when history has moved past the init commit', async () => {
    git(['init']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 't']);
    await writeFile(path.join(tmpDir, 'README.md'), 'base\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'base']);

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    commitInitOutputs();

    await writeFile(path.join(tmpDir, 'feature.txt'), 'feature\n');
    git(['add', 'feature.txt']);
    git(['commit', '-m', 'feature']);

    const result = await uninstall();
    expect(result.status).toBe('ok');
    expect(result.git).toBe('committed');
    expect(git(['log', '-1', '--format=%s']).stdout.trim()).toBe(
      'chore: weave uninstall 移除 init 生成物',
    );

    // 跟踪面：weave 文件从索引消失，用户提交原样
    const lsFiles = git(['ls-files']).stdout.trim().split('\n');
    expect(lsFiles).toContain('README.md');
    expect(lsFiles).toContain('feature.txt');
    expect(lsFiles.some((f) => f === '.claude/.gitignore' || f.startsWith('.claude/') || f.startsWith('.weave/'))).toBe(false);
    expect(lsFiles).not.toContain('CLAUDE.md');
    expect(lsFiles).not.toContain('AGENTS.md');
    expect(git(['status', '--porcelain']).stdout.trim()).toBe('');
  });

  it('skips git when the index is dirty', async () => {
    git(['init']);
    git(['config', 'user.email', 't@example.com']);
    git(['config', 'user.name', 't']);
    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });

    await writeFile(path.join(tmpDir, 'staged.txt'), 'user staged\n');
    git(['add', 'staged.txt']);

    const result = await uninstall();
    expect(result.git).toBe('skipped-dirty-index');
    // 文件面照常清理，用户暂存原样保留
    expect(await exists(path.join(tmpDir, '.weave'))).toBe(false);
    expect(git(['diff', '--cached', '--name-only']).stdout.trim()).toBe('staged.txt');
  });

  it('restores the AGENTS.md displaced by init', async () => {
    const original = '# Project\n\nPre-init AGENTS.md content.\n';
    await writeFile(path.join(tmpDir, 'AGENTS.md'), original);
    await writeFile(path.join(tmpDir, 'CLAUDE.md'), '# Project\n\nPre-init CLAUDE.md.\n');

    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    // init 把两个文件合一：AGENTS.md 被顶替并备份
    const mdLink = await lstat(path.join(tmpDir, 'AGENTS.md'));
    expect(mdLink.isSymbolicLink()).toBe(true);

    const result = await uninstall();
    expect(result.status).toBe('ok');
    expect(result.restoredFromBackup).toBe(path.join(tmpDir, 'AGENTS.md'));
    // 备份还原为真文件；CLAUDE.md 剥段后只剩用户正文
    expect(await readFile(path.join(tmpDir, 'AGENTS.md'), 'utf-8')).toBe(original);
    expect(await readFile(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')).toBe('# Project\n\nPre-init CLAUDE.md.\n');
  });
});

const WEAVE_HEADER_TEXT = 'This file is managed by [weave]';
