import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildIndex,
  clearFileIndexCache,
  listDirOf,
  matchPaths,
  projectFileIndex,
} from '../project-files.js';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const write = (root: string, rel: string, body = ''): void => {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
};

let root: string;

/** 测试里的提交：身份走 env，免得依赖跑测试那台机器的 git 配置。 */
const commit = (cwd: string): void => {
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'init'], {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'weave-test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'weave-test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'weave-files-'));
  clearFileIndexCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildIndex', () => {
  it.skipIf(!hasGit)('① 走 git ls-files：gitignore 里的不进来，没跟踪的也进来', async () => {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    write(root, '.gitignore', 'dist/\n*.log\n');
    write(root, 'src/a.ts');
    write(root, 'src/lib/b.ts');
    write(root, 'run.log');
    write(root, 'dist/out.js');
    const idx = await buildIndex(root);
    expect(idx.files).toEqual(['.gitignore', 'src/a.ts', 'src/lib/b.ts']);
    expect(idx.dirs).toEqual(['src', 'src/lib']);
    expect(idx.truncated).toBe(false);
  });

  it('② 不是 git 仓就退回目录遍历，跳过 node_modules 一类重目录', async () => {
    write(root, 'src/a.ts');
    write(root, 'node_modules/pkg/index.js');
    write(root, '.git/HEAD', 'ref: refs/heads/main\n');
    write(root, 'dist/out.js');
    const idx = await buildIndex(root);
    expect(idx.files).toEqual(['src/a.ts']);
    expect(idx.dirs).toEqual(['src']);
  });

  it('③ 目录由文件路径的前缀派生（不另扫一遍盘）', async () => {
    write(root, 'a/b/c/d.ts');
    expect((await buildIndex(root)).dirs).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it.skipIf(!hasGit)('④ 子模块里的文件也在索引里（git 只给一个 gitlink）', async () => {
    const lib = mkdtempSync(path.join(tmpdir(), 'weave-lib-'));
    try {
      execFileSync('git', ['init'], { cwd: lib, stdio: 'ignore' });
      write(lib, 'a.ts');
      write(lib, 'src/b.ts');
      commit(lib);
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      write(root, 'm.ts');
      commit(root);
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', lib, 'vendor/lib'], {
        cwd: root,
        stdio: 'ignore',
      });
      // 子模块里刚建、还没 add 的那份也最想能引用
      write(root, 'vendor/lib/untracked.ts');
      const idx = await buildIndex(root);
      expect(idx.files).toEqual([
        '.gitmodules',
        'm.ts',
        'vendor/lib/a.ts',
        'vendor/lib/src/b.ts',
        'vendor/lib/untracked.ts',
      ]);
      expect(idx.dirs).toEqual(['vendor', 'vendor/lib', 'vendor/lib/src']);
      // gitlink 不当文件露一遍：子模块那一行只该是目录
      expect(listDirOf(idx, 'vendor').map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:vendor/lib']);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGit)('⑤ 没克隆的子模块：不冒充它去问 git（否则会列出外层文件），目录仍在', async () => {
    const lib = mkdtempSync(path.join(tmpdir(), 'weave-lib-'));
    try {
      execFileSync('git', ['init'], { cwd: lib, stdio: 'ignore' });
      write(lib, 'a.ts');
      commit(lib);
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      write(root, 'm.ts');
      commit(root);
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', lib, 'vendor/lib'], {
        cwd: root,
        stdio: 'ignore',
      });
      rmSync(path.join(root, 'vendor/lib/.git'), { force: true });
      const idx = await buildIndex(root);
      expect(idx.files).toEqual(['.gitmodules', 'm.ts']);
      expect(idx.dirs).toEqual(['vendor', 'vendor/lib']);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGit)('⑥ 被 ignore 的嵌套仓照样进去列：忽略的是那个仓，不是它的文件', async () => {
    const notes = mkdtempSync(path.join(tmpdir(), 'weave-notes-'));
    try {
      execFileSync('git', ['init'], { cwd: notes, stdio: 'ignore' });
      write(notes, '00-raw/a.md');
      commit(notes);
      write(notes, '00-raw/untracked.md');
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      write(root, '.gitignore', '/Notes/\nscratch/\n');
      write(root, 'm.ts');
      commit(root);
      cpSync(notes, path.join(root, 'Notes'), { recursive: true });
      // 同样被忽略、但不是仓库的目录不进来
      write(root, 'scratch/tmp.txt');
      const idx = await buildIndex(root);
      expect(idx.files).toEqual([
        '.gitignore',
        'Notes/00-raw/a.md',
        'Notes/00-raw/untracked.md',
        'm.ts',
      ]);
      expect(idx.dirs).toEqual(['Notes', 'Notes/00-raw']);
      expect(listDirOf(idx, '').map((e) => `${e.kind}:${e.path}`)).toEqual([
        'dir:Notes',
        'file:.gitignore',
        'file:m.ts',
      ]);
    } finally {
      rmSync(notes, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGit)('⑦ 没被忽略的嵌套仓（git 只给 `dir/`）一样进目录、进去列', async () => {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    write(root, 'm.ts');
    commit(root);
    mkdirSync(path.join(root, 'inner'), { recursive: true });
    execFileSync('git', ['init'], { cwd: path.join(root, 'inner'), stdio: 'ignore' });
    write(root, 'inner/README.md');
    const idx = await buildIndex(root);
    expect(idx.files).toEqual(['inner/README.md', 'm.ts']);
    expect(idx.dirs).toEqual(['inner']);
  });
});

describe('listDirOf', () => {
  it('① 只列直接子项，目录在前、父目录不重复出现', async () => {
    write(root, 'src/a.ts');
    write(root, 'src/lib/b.ts');
    write(root, 'README.md');
    const idx = await buildIndex(root);
    const top = listDirOf(idx, '');
    expect(top.map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:src', 'file:README.md']);
    const under = listDirOf(idx, 'src');
    expect(under.map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:src/lib', 'file:src/a.ts']);
  });
});

describe('matchPaths', () => {
  const index = (files: string[]) => ({
    at: Date.now(),
    files,
    dirs: [],
    truncated: false,
  });

  it('① 文件名前缀 > 文件名包含 > 路径段前缀 > 子序列，同档短的在前', () => {
    const idx = index(['src/lib/route.ts', 'src/routes/other.ts', 'docs/route-notes.md', 'src/geroute.ts']);
    const hits = matchPaths(idx, 'route', 10).hits;
    // 两条 basename 都以 route 开头：同档，短的那个在前（更可能是常用的那个）
    expect(hits.map((h) => h.path)).toEqual([
      'src/lib/route.ts',
      'docs/route-notes.md',
      // 然后是 basename 里含 route 的
      'src/geroute.ts',
      // 最后是路径段以 route 开头的（routes/）
      'src/routes/other.ts',
    ]);
  });

  it('② 命中区间落在原路径的下标上（前端拿去上色）', () => {
    const idx = index(['src/lib/route.ts']);
    const hit = matchPaths(idx, 'lib', 10).hits[0]!;
    expect(hit.path.slice(...[hit.ranges[0]![0], hit.ranges[0]![0] + hit.ranges[0]![1]])).toBe('lib');
  });

  it('③ 大小写不敏感，且空查询不给结果', () => {
    const idx = index(['src/Route.ts']);
    expect(matchPaths(idx, 'ROUTE', 10).total).toBe(1);
    expect(matchPaths(idx, '   ', 10).total).toBe(0);
  });

  it('④ limit 只截返回、total 仍是全量（截断提示靠它）', () => {
    const idx = index(['a/one.ts', 'a/two.ts', 'a/three.ts']);
    const res = matchPaths(idx, 'a', 2);
    expect(res.hits).toHaveLength(2);
    expect(res.total).toBe(3);
  });
});

describe('projectFileIndex（缓存）', () => {
  it('① TTL 内复用同一份索引（打开即重建，但不是每敲一个字都重扫）', async () => {
    write(root, 'a.ts');
    const first = await projectFileIndex(1, root);
    const second = await projectFileIndex(1, root);
    expect(second).toBe(first);
  });

  it('② 同时到达的多个请求共用一次构建（在飞去重）', async () => {
    write(root, 'a.ts');
    const [a, b] = await Promise.all([projectFileIndex(1, root), projectFileIndex(1, root)]);
    expect(a).toBe(b);
  });

  it('③ 不同项目各持一份（按 projectId 分键，不是按路径）', async () => {
    write(root, 'a.ts');
    const a = await projectFileIndex(1, root);
    const b = await projectFileIndex(2, root);
    expect(a).not.toBe(b);
  });
});
