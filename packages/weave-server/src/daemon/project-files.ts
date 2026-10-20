import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PathRefKind } from '@weavecode/harness';

const execFileAsync = promisify(execFile);

/**
 * 项目文件索引：对话页的路径补全面。**不常驻、不 watch**——打开选择器即重建
 * （git ls-files 一万文件 ~20ms），缓存只挡「连续开关选择器」这一种情形。
 * 理由：重建是事实、watch 是猜测（事件会漏，漏了就永远陈旧），而枚举一个项目
 * 比 Everything 那种枚举整个卷便宜三四个数量级，常驻索引不划算。
 */

/** 索引条目上限：再大就不是「路径补全」该扛的量了，退化成目录浏览。 */
export const MAX_INDEX_FILES = 300_000;

/** 缓存存活窗：只为吸收连续开关，不是刷新周期。 */
const INDEX_TTL_MS = 1500;

/** 最多留几个项目的索引（大仓库索引按 MB 计）。 */
const MAX_CACHED_PROJECTS = 3;

/** 非 git 目录的回落枚举跳过这些重量级目录。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'coverage',
  '.turbo',
]);

export interface FileIndex {
  at: number;
  /** 项目相对路径（正斜杠分隔），升序。 */
  files: string[];
  /** 由文件路径前缀派生的目录集（git 不列目录）。 */
  dirs: string[];
  truncated: boolean;
}

export interface PathHit {
  path: string;
  kind: PathRefKind;
  /** 命中字符区间 `[起点, 长度]`（对 `path` 而言），供前端高亮。 */
  ranges: [number, number][];
}

async function listViaGit(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, timeout: 10_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    // gitignore 语义（嵌套 / 取反 / 全局 excludes）白拿；--others 让刚建还没 add 的也在列
    const files = stdout.split('\0').filter(Boolean);
    return files.length > 0 ? files : null;
  } catch {
    // 非 git 仓库 / 没有 git / 超时 → 回落枚举
    return null;
  }
}

async function listViaWalk(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    if (out.length >= MAX_INDEX_FILES) return;
    let entries;
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return; // 读不动的目录（权限 / 竞态删除）跳过，不打断整棵树的枚举
    }
    for (const e of entries) {
      if (out.length >= MAX_INDEX_FILES) return;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(child);
      } else if (e.isFile()) {
        out.push(child);
      }
    }
  };
  await walk('');
  return out;
}

/** 由文件路径前缀派生目录（`a/b/c.ts` → `a`、`a/b`）。 */
function dirsOf(files: readonly string[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    let i = f.lastIndexOf('/');
    while (i > 0) {
      const dir = f.slice(0, i);
      if (set.has(dir)) break;
      set.add(dir);
      i = dir.lastIndexOf('/');
    }
  }
  return [...set].sort();
}

export async function buildIndex(root: string): Promise<FileIndex> {
  const fromGit = await listViaGit(root);
  const files = fromGit ?? (await listViaWalk(root));
  const truncated = files.length > MAX_INDEX_FILES;
  const kept = truncated ? files.slice(0, MAX_INDEX_FILES) : files;
  kept.sort();
  return { at: Date.now(), files: kept, dirs: dirsOf(kept), truncated };
}

const cache = new Map<number, FileIndex>();
const inflight = new Map<number, Promise<FileIndex>>();

/** 取项目索引：新鲜则复用，在飞则共用一次构建（同 `/toolkit` 的口径）。 */
export async function projectFileIndex(projectId: number, root: string): Promise<FileIndex> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit;
  const flying = inflight.get(projectId);
  if (flying) return flying;

  const job = buildIndex(root).then((index) => {
    // 重插到尾部 = 最近使用；超出上限淘汰最旧的
    cache.delete(projectId);
    cache.set(projectId, index);
    while (cache.size > MAX_CACHED_PROJECTS) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return index;
  });
  inflight.set(projectId, job);
  try {
    return await job;
  } finally {
    inflight.delete(projectId);
  }
}

/** 测试用：清空索引缓存。 */
export function clearFileIndexCache(): void {
  cache.clear();
}

/** 目录浏览：`dir`（相对，'' = 根）的直接子项，目录在前、名字排。 */
export function listDirOf(index: FileIndex, dir: string): { path: string; kind: PathRefKind }[] {
  const prefix = dir ? `${dir}/` : '';
  const out: { path: string; kind: PathRefKind }[] = [];
  const push = (p: string, kind: PathRefKind): void => {
    const rest = p.slice(prefix.length);
    if (rest && !rest.includes('/')) out.push({ path: p, kind });
  };
  for (const d of index.dirs) if (d.startsWith(prefix)) push(d, 'dir');
  for (const f of index.files) if (f.startsWith(prefix)) push(f, 'file');
  out.sort((a, b) =>
    a.kind === b.kind
      ? a.path.localeCompare(b.path, undefined, { numeric: true })
      : a.kind === 'dir'
        ? -1
        : 1,
  );
  return out;
}

/** 有没有某一段路径以 `q` 开头。**不 split**——这条每敲一下都要对全索引跑一遍，
 *  每次分配一个分段数组正是这里最贵的动作。 */
function segmentStartsWith(lowerPath: string, q: string): boolean {
  let at = 0;
  for (;;) {
    if (lowerPath.startsWith(q, at)) return true;
    const next = lowerPath.indexOf('/', at);
    if (next < 0) return false;
    at = next + 1;
  }
}

/** 四档排序：basename 前缀 > basename 子串 > 路径段前缀 > 整条子序列；同档短的靠前。 */
function rankOf(lowerPath: string, base: string, q: string): number {
  if (base.startsWith(q)) return 3;
  if (base.includes(q)) return 2;
  if (segmentStartsWith(lowerPath, q)) return 1;
  return isSubsequence(lowerPath, q) ? 0 : -1;
}

function isSubsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/** 命中区间：按 rank 的档位定位（子序列档逐字符给），供前端上色。 */
function rangesOf(original: string, rank: number, q: string): [number, number][] {
  const baseAt = original.lastIndexOf('/') + 1;
  const base = original.slice(baseAt).toLowerCase();
  if (rank === 3 || rank === 2) {
    const at = base.indexOf(q);
    return at < 0 ? [] : [[baseAt + at, q.length]];
  }
  if (rank === 1) {
    const at = original.toLowerCase().indexOf(q);
    return at < 0 ? [] : [[at, q.length]];
  }
  const out: [number, number][] = [];
  const lower = original.toLowerCase();
  let i = 0;
  for (let j = 0; j < lower.length && i < q.length; j++) {
    if (lower[j] === q[i]) {
      out.push([j, 1]);
      i++;
    }
  }
  return out;
}

/** 全索引模糊匹配 top `limit`（文件与目录同池竞争）。 */
export function matchPaths(index: FileIndex, query: string, limit: number): {
  hits: PathHit[];
  total: number;
} {
  const q = query.trim().toLowerCase();
  if (!q) return { hits: [], total: 0 };
  const scored: { path: string; kind: PathRefKind; rank: number; len: number }[] = [];
  const consider = (p: string, kind: PathRefKind): void => {
    const lower = p.toLowerCase();
    const rank = rankOf(lower, lower.slice(lower.lastIndexOf('/') + 1), q);
    if (rank < 0) return;
    scored.push({ path: p, kind, rank, len: p.length });
  };
  for (const f of index.files) consider(f, 'file');
  for (const d of index.dirs) consider(d, 'dir');
  scored.sort((a, b) => b.rank - a.rank || a.len - b.len || a.path.localeCompare(b.path));
  // 命中区间只为真的会下发的那几条算：宽查询（`src`）能命中整个索引，逐条去算
  // 区间就是白烧——被 limit 切掉的没人看。
  return {
    hits: scored.slice(0, limit).map((s) => ({
      path: s.path,
      kind: s.kind,
      ranges: rangesOf(s.path, s.rank, q),
    })),
    total: scored.length,
  };
}
