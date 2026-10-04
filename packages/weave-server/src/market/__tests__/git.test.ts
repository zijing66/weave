import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  assertSafeGitUrl,
  importFromGit,
  type GitExec,
} from '../import.js';
import { marketDir, readManifest } from '../manifest.js';
import { isInsideDir } from '../resolve.js';
import { openDatabase } from '../../db/db.js';
import { LibraryRepository } from '../../repositories/libraries.js';
import type { DatabaseSync } from 'node:sqlite';

let dataDir: string;
const tempDirs: string[] = [];
let db: DatabaseSync;
let libs: LibraryRepository;

function newDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'weave-market-git-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  dataDir = newDataDir();
  db = openDatabase(':memory:');
  libs = new LibraryRepository(db, dataDir);
});
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('assertSafeGitUrl（R10 协议白名单）', () => {
  it('放行 https / ssh / git@', () => {
    expect(assertSafeGitUrl('https://github.com/acme/skills.git')).toBe(
      'https://github.com/acme/skills.git',
    );
    expect(assertSafeGitUrl('ssh://git@github.com/acme/skills.git')).toBe(
      'ssh://git@github.com/acme/skills.git',
    );
    expect(assertSafeGitUrl('git@github.com:acme/skills.git')).toBe(
      'git@github.com:acme/skills.git',
    );
  });

  it('拒 ext:: 等非白名单协议与本地路径', () => {
    expect(() => assertSafeGitUrl('ext::sh -c evil')).toThrow(/Unsupported/);
    expect(() => assertSafeGitUrl('file:///etc/passwd')).toThrow(/Unsupported/);
    expect(() => assertSafeGitUrl('http://insecure.example/repo.git')).toThrow(/Unsupported/);
    expect(() => assertSafeGitUrl('/local/repo')).toThrow(/Unsupported/);
    expect(() => assertSafeGitUrl('')).toThrow(/Missing/);
  });

  it('拒 --upload-pack 向量与空白注入', () => {
    expect(() =>
      assertSafeGitUrl('https://x.example/repo.git --upload-pack=evil'),
    ).toThrow(/upload-pack/);
    expect(() => assertSafeGitUrl('https://x.example/repo.git\n--upload-pack')).toThrow();
    expect(() => assertSafeGitUrl('git@host:a b')).toThrow(/whitespace/);
  });
});

describe('importFromGit（假 exec，不真联网）', () => {
  const url = 'https://github.com/acme/skills.git';

  it('execFile 参数数组断言：git + clone --depth 1 <url> <target>', async () => {
    const calls: { file: string; args: string[]; options: { timeout: number } }[] = [];
    const execGit: GitExec = async (file, args, options) => {
      calls.push({ file, args, options });
      mkdirSync(args[4], { recursive: true }); // 模拟 clone 落盘
      return { stdout: '', stderr: '' };
    };
    const res = await importFromGit(url, { libraries: libs, dataDir, execGit });

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('git');
    expect(Array.isArray(calls[0].args)).toBe(true);
    expect(calls[0].args).toEqual([
      'clone',
      '--depth',
      '1',
      url,
      path.join(dataDir, 'market', 'skills'),
    ]);
    expect(calls[0].options.timeout).toBeGreaterThan(0); // 超时 kill

    // containment 双检：目标落在市场根内
    expect(isInsideDir(calls[0].args[4], marketDir(dataDir))).toBe(true);
    expect(isInsideDir(res.dir, marketDir(dataDir))).toBe(true);

    // 清单 + 行登记
    const manifest = await readManifest(res.dir);
    expect(manifest?.source).toBe('git');
    expect(manifest?.origin).toBe(url);
    expect(manifest?.commit).toBeUndefined(); // BACKLOG 预留
    expect(libs.getById(res.libraryId)?.path).toBe(res.dir);
  });

  it('git@ URL 取仓库名作 slug', async () => {
    const calls: string[][] = [];
    const execGit: GitExec = async (_file, args) => {
      calls.push(args);
      mkdirSync(args[4], { recursive: true });
      return { stdout: '', stderr: '' };
    };
    const res = await importFromGit('git@github.com:acme/my-skills.git', {
      libraries: libs,
      dataDir,
      execGit,
    });
    expect(calls[0][4]).toBe(path.join(dataDir, 'market', 'my-skills'));
    expect(res.id).toBe('my-skills');
  });

  it('URL 校验先行：非法 URL 不触达 exec', async () => {
    const execGit = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }));
    await expect(
      importFromGit('ext::sh -c evil', { libraries: libs, dataDir, execGit }),
    ).rejects.toThrow(/Unsupported/);
    expect(execGit).not.toHaveBeenCalled();
    expect(libs.list()).toHaveLength(0);
  });

  it('git 失败输出截断', async () => {
    const execGit: GitExec = async () => {
      throw Object.assign(new Error('git exited 128'), {
        stderr: 'x'.repeat(10_000),
        stdout: '',
      });
    };
    await expect(importFromGit(url, { libraries: libs, dataDir, execGit })).rejects.toThrow(
      /truncated/,
    );
    await importFromGit(url, { libraries: libs, dataDir, execGit }).catch((e: Error) => {
      expect(e.message.length).toBeLessThan(2_500);
    });
    expect(libs.list()).toHaveLength(0); // 失败不登记
  });

  it('同一 URL 重复导入 → 复用既有目录', async () => {
    let n = 0;
    const execGit: GitExec = async (_file, args) => {
      n += 1;
      mkdirSync(args[4], { recursive: true });
      return { stdout: '', stderr: '' };
    };
    const first = await importFromGit(url, { libraries: libs, dataDir, execGit });
    const second = await importFromGit(url, { libraries: libs, dataDir, execGit });
    expect(n).toBe(1);
    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);
    expect(libs.list()).toHaveLength(1);
  });
});
