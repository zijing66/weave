import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildIndex,
  clearFileIndexCache,
  hydrateIndex,
  INDEX_VERSION,
  listDirOf,
  matchPaths,
  projectFileIndex,
  pruneFileIndexes,
  setFileIndexRoot,
  startMatch,
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

let indexDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'weave-files-'));
  // 快照落盘根指向临时目录：跑测试绝不能写进真实的缓存档。
  indexDir = mkdtempSync(path.join(tmpdir(), 'weave-idx-'));
  setFileIndexRoot(indexDir);
  clearFileIndexCache();
});

afterEach(() => {
  setFileIndexRoot(null);
  rmSync(root, { recursive: true, force: true });
  rmSync(indexDir, { recursive: true, force: true });
});

/** 落盘是 fire-and-forget 的（不拖慢请求路径），测试里轮询等它落地。 */
async function waitForFile(file: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`snapshot not written: ${file}`);
}

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

  it('③′ 目录型符号链接：内容进索引（可进入可检索），环不死循环', async () => {
    write(root, 'real/inside.ts');
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'junction');
    // 环：real 里再摆一枚指回根的链接
    symlinkSync(root, path.join(root, 'real', 'loop'), 'junction');
    const idx = await buildIndex(root);
    expect(idx.files).toEqual(['link/inside.ts', 'real/inside.ts']);
    expect(idx.dirs).toEqual(['link', 'real']);
    // 链接目录能进（子项在 children map 里）
    expect(listDirOf(idx, 'link').map((e) => `${e.kind}:${e.path}`)).toEqual(['file:link/inside.ts']);
  });

  it.skipIf(!hasGit)('③″ git 仓里已跟踪的目录链接（120000）也当目录：avic/temp 实测形态', async () => {
    write(root, 'real/inside.ts');
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    // 先 add 真目录（此刻还没有链接，git 不会平铺 junction），再塞 120000 叶子
    execFileSync('git', ['add', 'real'], { cwd: root, stdio: 'ignore' });
    execFileSync(
      'git',
      ['update-index', '--add', '--cacheinfo', '120000,0123456789012345678901234567890123456789,link'],
      { cwd: root, stdio: 'ignore' },
    );
    symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'junction');
    const idx = await buildIndex(root);
    expect(idx.files).toEqual(['link/inside.ts', 'real/inside.ts']);
    expect(idx.dirs).toEqual(['link', 'real']);
    expect(listDirOf(idx, '').map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:link', 'dir:real']);
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
      // gitlink 不当文件露一遍：子模块那一行只该是目录，且带实际 HEAD 短 hash
      const vendored = listDirOf(idx, 'vendor');
      expect(vendored.map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:vendor/lib']);
      expect(vendored[0]!.head).toMatch(/^[0-9a-f]{7}$/);
      expect(idx.submodules['vendor/lib']).toBe(vendored[0]!.head);
    } finally {
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGit)('④′ gitlink 无 .gitmodules 也进得去（avic/aadl-adapter 实测形态）', async () => {
    const lib = mkdtempSync(path.join(tmpdir(), 'weave-lib2-'));
    try {
      execFileSync('git', ['init'], { cwd: lib, stdio: 'ignore' });
      write(lib, 'a.ts');
      commit(lib);
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      write(root, 'm.ts');
      commit(root);
      // 手搓 gitlink（不经 submodule add，故无 .gitmodules）：index 里塞 160000 条目
      execFileSync(
        'git',
        ['update-index', '--add', '--cacheinfo', '160000,0123456789012345678901234567890123456789,nested/repo'],
        { cwd: root, stdio: 'ignore' },
      );
      // 工作区里摆上子仓本体（clone 的等价物）
      cpSync(lib, path.join(root, 'nested/repo'), { recursive: true });
      const idx = await buildIndex(root);
      expect(idx.files).toEqual(['m.ts', 'nested/repo/a.ts']);
      expect(idx.dirs).toEqual(['nested', 'nested/repo']);
      const nested = listDirOf(idx, 'nested');
      expect(nested.map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:nested/repo']);
      expect(nested[0]!.head).toMatch(/^[0-9a-f]{7}$/);
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

describe('hydrateIndex（快照 → 可查的索引：持久化读回来走同一条）', () => {
  it('① 快照 JSON 往返后文件/目录/子项一致（派生态读回来现算，不落快照）', async () => {
    write(root, 'src/a.ts');
    write(root, 'src/lib/b.ts');
    const idx = await buildIndex(root);
    // 落盘只存这一份：派生出来的小写表、目录子项映射都不在里面
    const snap = JSON.parse(
      JSON.stringify({
        v: idx.v,
        root: idx.root,
        at: idx.at,
        stamp: idx.stamp,
        truncated: idx.truncated,
        files: idx.files,
        dirs: idx.dirs,
      }),
    );
    expect(snap.v).toBe(INDEX_VERSION);
    const back = hydrateIndex(snap);
    expect(back.files).toEqual(idx.files);
    expect(back.dirs).toEqual(idx.dirs);
    expect(back.lower).toEqual(idx.lower);
    expect(listDirOf(back, '')).toEqual(listDirOf(idx, ''));
    expect(listDirOf(back, 'src')).toEqual(listDirOf(idx, 'src'));
  });
});

describe('matchPaths', () => {
  // 真实索引在建索引时已排序（`kept.sort()`），二分定位依赖这一点——夹具同口径
  const index = (files: string[], dirs: string[] = []) =>
    hydrateIndex({
      v: INDEX_VERSION,
      root: '/p',
      at: Date.now(),
      stamp: null,
      truncated: false,
      files: [...files].sort(),
      dirs: [...dirs].sort(),
    });

  it('① 名字前缀 > 名字包含 > 名字子序列，同档短的在前；路径段命中不算', async () => {
    const idx = index(['src/lib/route.ts', 'src/routes/other.ts', 'docs/route-notes.md', 'src/geroute.ts']);
    const hits = (await matchPaths(idx, 'route', 10)).hits;
    // 两条 basename 都以 route 开头：同档，短的那个在前（更可能是常用的那个）
    expect(hits.map((h) => h.path)).toEqual([
      'src/lib/route.ts',
      'docs/route-notes.md',
      // 然后是 basename 里含 route 的
      'src/geroute.ts',
      // `src/routes/other.ts` 只有路径段命中——不算（匹配只认叶子名字）
    ]);
  });

  it('② 命中区间落在名字段上（前端拿去上色）', async () => {
    const idx = index(['src/lib/route.ts']);
    const hit = (await matchPaths(idx, 'route', 10)).hits[0]!;
    expect(hit.path.slice(...[hit.ranges[0]![0], hit.ranges[0]![0] + hit.ranges[0]![1]])).toBe('route');
  });

  it('③ 大小写不敏感，且空查询不给结果', async () => {
    const idx = index(['src/Route.ts']);
    expect((await matchPaths(idx, 'ROUTE', 10)).total).toBe(1);
    expect((await matchPaths(idx, '   ', 10)).total).toBe(0);
  });

  it('④ limit 只截返回；满档且最差已是最高档时 total 只是下限', async () => {
    const idx = index(['a/one.ts', 'a/two.ts', 'a/three.ts']);
    // two/three 的名字以 t 打头（rank 3）：榜满 2 条即停，total 只是下限
    const res = await matchPaths(idx, 't', 2);
    expect(res.hits).toHaveLength(2);
    expect(res.total).toBe(2);
    expect(res.capped).toBe(true);
    // 换一个不满档的查询：total 是准的全量
    const all = await matchPaths(idx, 'ne', 10);
    expect(all.hits.map((h) => h.path)).toEqual(['a/one.ts']);
    expect(all.capped).toBe(false);
  });

  it('⑤ 满档且最差那条已是最高档 → 即停，total 只是下限', async () => {
    const files = Array.from({ length: 3000 }, (_, i) => `src/f${String(i).padStart(4, '0')}.ts`);
    const res = await matchPaths(index(files), 'f', 20);
    expect(res.hits).toHaveLength(20);
    expect(res.capped).toBe(true);
    expect(res.total).toBe(20);
  });

  it('⑥ 榜满后扫描序靠后的高分条目照样挤进来（有界 top-N 与全排一致）', async () => {
    const files = [
      ...Array.from({ length: 50 }, (_, i) => `b/xb${String(i).padStart(2, '0')}.ts`),
      'ab.ts',
    ];
    const res = await matchPaths(index(files), 'b', 3);
    // 前 50 条是名字包含（rank 2），扫描序最后的 ab.ts 是名字前缀（rank 3）
    expect(res.hits.map((h) => h.path)).toEqual(['ab.ts', 'b/xb00.ts', 'b/xb01.ts']);
    expect(res.capped).toBe(false);
    expect(res.total).toBe(51);
  });

  it('⑦ dir 子树：只收前缀段内的条目，段外同名不算', async () => {
    const idx = index(
      ['src/a.ts', 'src/deep/b.ts', 'docs/a.ts', 'a.ts'],
      ['src', 'src/deep', 'docs'],
    );
    const res = await matchPaths(idx, 'a', 10, 'src');
    // `src/deep/b.ts` 的名字不含 a（子序列也不构成）——只有 `src/a.ts` 命中
    expect(res.hits.map((h) => h.path)).toEqual(['src/a.ts']);
    expect(res.total).toBe(1);
  });

  it('⑧ dir 子树对目录条目同样生效（目录名匹配、范围按前缀段）', async () => {
    const idx = index(['src/lib/x.ts', 'other/lib/y.ts'], ['src', 'src/lib', 'other', 'other/lib']);
    const res = await matchPaths(idx, 'lib', 10, 'src');
    expect(res.hits.map((h) => h.path)).toEqual(['src/lib']);
  });

  it('⑨ 分刀跑与一口气跑结果相同（刀与刀之间让出事件循环）', () => {
    // 刀点按毫秒判：条目太少时整趟扫完不到 1ms，一次也不会让出（快机器上曾假红）。
    // limit 大过真正能满档的命中数，扫描不会提前收工，整趟必须跨过若干刀。
    const files = Array.from({ length: 200_000 }, (_, i) => `d${i % 7}/x${i}.ts`);
    const idx = index(files);
    const whole = startMatch(idx, 'x499', 1000);
    expect(whole.step(60_000)).toBe(true);
    const cut = startMatch(idx, 'x499', 1000);
    let steps = 0;
    while (!cut.step(0)) steps++;
    expect(steps).toBeGreaterThan(1);
    expect(cut.result()).toEqual(whole.result());
  });
});

describe('projectFileIndex（缓存）', () => {
  it('① 硬窗内复用同一份索引（打开即重建，但不是每敲一个字都重扫）', async () => {
    write(root, 'a.ts');
    const first = await projectFileIndex(1, root);
    const second = await projectFileIndex(1, root);
    expect(second).toBe(first);
  });

  it('④ 刚建、还没跟踪的文件不动 git 指纹 → 只有 `fresh`（打开选择器）才看得到', async () => {
    write(root, 'a.ts');
    const first = await projectFileIndex(1, root);
    write(root, 'b.ts');
    expect(await projectFileIndex(1, root)).toBe(first);
    const again = await projectFileIndex(1, root, { fresh: true });
    expect(again.files).toEqual(['a.ts', 'b.ts']);
  });

  it.skipIf(!hasGit)('⑤ commit 改了 git 指纹 → 下一次取索引立刻重建', async () => {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    write(root, 'a.ts');
    commit(root);
    const first = await projectFileIndex(1, root);
    write(root, 'b.ts');
    commit(root);
    const second = await projectFileIndex(1, root);
    expect(second).not.toBe(first);
    expect(second.files).toEqual(['a.ts', 'b.ts']);
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

describe('projectFileIndex（落盘）', () => {
  it('⑥ 重建即落盘：只写快照七字段，派生表不进盘', async () => {
    write(root, 'a.ts');
    await projectFileIndex(1, root);
    const file = path.join(indexDir, '1.json');
    await waitForFile(file);
    const snap = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(snap).sort()).toEqual(['at', 'dirs', 'files', 'root', 'stamp', 'truncated', 'v']);
    expect(snap.v).toBe(INDEX_VERSION);
    expect(snap.files).toEqual(['a.ts']);
  });

  it('⑦ 内存空着时直接读盘：源文件删了也还在列（= 没重新枚举）', async () => {
    write(root, 'a.ts');
    await projectFileIndex(1, root);
    await waitForFile(path.join(indexDir, '1.json'));
    rmSync(path.join(root, 'a.ts'));
    clearFileIndexCache(); // 模拟 daemon 重启
    const seeded = await projectFileIndex(1, root);
    expect(seeded.files).toEqual(['a.ts']);
  });

  it('⑧ 格式版本变了 → 盘上那份作废，重建', async () => {
    write(root, 'a.ts');
    await projectFileIndex(1, root);
    await waitForFile(path.join(indexDir, '1.json'));
    clearFileIndexCache();
    writeFileSync(path.join(indexDir, '1.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(indexDir, '1.json'), 'utf8')), v: 0 }));
    const fresh = await projectFileIndex(1, root);
    expect(fresh.v).toBe(INDEX_VERSION);
  });

  it('⑨ `fresh` 不走盘（它就是「现在重建」）', async () => {
    write(root, 'a.ts');
    await projectFileIndex(1, root);
    await waitForFile(path.join(indexDir, '1.json'));
    rmSync(path.join(root, 'a.ts'));
    clearFileIndexCache();
    expect((await projectFileIndex(1, root, { fresh: true })).files).toEqual([]);
  });

  it('⑩ pruneFileIndexes 只留还在库里的项目', async () => {
    write(root, 'a.ts');
    await projectFileIndex(1, root);
    await projectFileIndex(2, root);
    await waitForFile(path.join(indexDir, '2.json'));
    pruneFileIndexes([2]);
    expect(existsSync(path.join(indexDir, '1.json'))).toBe(false);
    expect(existsSync(path.join(indexDir, '2.json'))).toBe(true);
  });
});
