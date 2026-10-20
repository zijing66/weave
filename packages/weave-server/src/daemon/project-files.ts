import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PathRefKind } from '@weavecode/harness';
import { getIndexDir } from '../db/paths.js';

const execFileAsync = promisify(execFile);

/**
 * 项目文件索引：对话页的路径补全面。**不常驻、不 watch**——打开选择器即重建
 * （`?fresh=1`），开着的期间靠 git 指纹（`.git/index`）重验 + 硬窗兜底；**重建
 * 结果落盘**（`<dataDir>/cache/index/<projectId>.json`，可弃档）当下一次进程启动
 * 的 L2，省掉冷启动后第一次补全/粘贴认引用的整棵重建。
 * 理由：重建是事实、watch 是猜测（事件会漏，漏了就永远陈旧），而枚举一个项目
 * 比 Everything 那种枚举整个卷便宜三四个数量级，常驻索引不划算。
 */

/** 索引条目上限：再大就不是「路径补全」该扛的量了，退化成目录浏览。 */
export const MAX_INDEX_FILES = 300_000;

/** 快照格式版本：作废盘上的旧文件，改形状必须递增。 */
export const INDEX_VERSION = 1;

/** 硬窗：到点必重建。**新建的未跟踪文件不动 `.git/index`**（实测），只有这条能兜住。 */
const INDEX_TTL_MS = 30_000;

/** 盘上那份能直接端出去的年纪上限（先服务、不阻塞；过了就重建）。 */
const INDEX_MAX_STALE_MS = 10 * 60_000;

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

/**
 * 索引的可序列化部分 = **落盘那一份的形状**：枚举结果 + 建它时的根与 git 指纹。
 * 派生出来的东西（小写表、目录子项映射）**不在这层**，读回来现算。
 */
export interface FileIndexSnapshot {
  v: number;
  /** 建索引时的项目根：路径变了这份就不能再用。 */
  root: string;
  /** 建索引的时刻（硬窗从它算）。 */
  at: number;
  /** 那一拍 `.git/index` 的指纹；null = 非 git / 读不到（重验只能靠硬窗）。 */
  stamp: string | null;
  truncated: boolean;
  /** 项目相对路径（正斜杠分隔），升序。 */
  files: string[];
  /** 目录集：由文件路径前缀派生 + 子模块的 gitlink（git 不列目录）。 */
  dirs: string[];
}

/** 一个目录的直接子项（完整相对路径）。排序**等第一次浏览这个目录时再做**：
 *  30 万条上 `localeCompare({numeric:true})` 是每个比较几微秒，建索引时全排一遍要半分钟。 */
export interface DirChildren {
  dirs: string[];
  files: string[];
  sorted: boolean;
}

export interface FileIndex extends FileIndexSnapshot {
  /** `files` 的小写（同下标）：匹配热路径上半条都要对 30 万条跑，不能现算。 */
  lower: string[];
  dirLower: string[];
  /** 目录 → 直接子项：浏览面 O(子项数)，不再扫全索引。 */
  children: Map<string, DirChildren>;
}

export interface PathHit {
  path: string;
  kind: PathRefKind;
  /** 命中字符区间 `[起点, 长度]`（对 `path` 而言），供前端高亮。 */
  ranges: [number, number][];
}

async function gitLsFiles(cwd: string, args: string[]): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', ...args], {
      cwd,
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    // gitignore 语义（嵌套 / 取反 / 全局 excludes）白拿；--others 让刚建还没 add 的也在列
    return stdout.split('\0').filter(Boolean);
  } catch {
    // 非 git 仓库 / 没有 git / 超时 → 这一层回落枚举
    return null;
  }
}

/** 子模块（gitlink）：`--stage` 里的 mode 160000，路径读 tab 之后那一截（可能带空格）。 */
async function gitlinksOf(root: string): Promise<string[]> {
  const staged = await gitLsFiles(root, ['--stage']);
  if (!staged) return [];
  return staged.filter((l) => l.startsWith('160000 ')).map((l) => l.slice(l.indexOf('\t') + 1));
}

/** 该目录是不是一个仓库的根（`.git` 目录 = 普通仓，`.git` 文件 = worktree / 子模块）。 */
function hasGitDir(dir: string): Promise<boolean> {
  return lstat(path.join(dir, '.git')).then(
    () => true,
    () => false,
  );
}

/**
 * 被 ignore 的目录里也可能立着独立仓库（Obsidian 库 / 独立笔记仓）：外层 git 只给一条
 * 折叠后的 `Notes/`，里面的文件同样得各自进去列一遍（同子模块口径）。只认真有 `.git`
 * 的——`.trash`、`.obsidian/.tmp` 这类被忽略目录照旧不进来；而 `--directory` 折叠到最
 * 外层忽略目录，`node_modules` 里夹着的杂仓也不会被翻出来。
 */
async function ignoredReposOf(root: string): Promise<string[]> {
  const listed = await gitLsFiles(root, [
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
  ]);
  const out: string[] = [];
  for (const p of listed ?? []) {
    if (!p.endsWith('/')) continue;
    const dir = p.slice(0, -1);
    if (await hasGitDir(path.join(root, dir))) out.push(dir);
  }
  return out;
}

/**
 * git 索引 + **仓库边界里的索引**：git 只给仓库边界一个名字，里面的文件得各自进去
 * 列一遍（`--recurse-submodules` 只认 `--cached`/`--stage`，给不了 `--others`，
 * 里面刚建还没 add 的文件正是最想引用的那种）。边界有三种同形的来源——子模块的
 * gitlink、未跟踪的嵌套仓（`--others` 给 `dir/`）、被 ignore 的嵌套仓。前后两种
 * 都是「用户的另一个仓」，不是「该被忽略的文件」，故一律进去列。
 */
async function listViaGit(
  root: string,
  prefix = '',
): Promise<{ files: string[]; links: string[] } | null> {
  const listed = await gitLsFiles(root, ['--cached', '--others', '--exclude-standard']);
  if (!listed) return null;
  const nested = new Set<string>();
  // `.gitmodules` 不在列就一次额外的 git 都不起
  if (listed.includes('.gitmodules')) for (const p of await gitlinksOf(root)) nested.add(p);
  for (const p of listed) if (p.endsWith('/')) nested.add(p.slice(0, -1));
  for (const p of await ignoredReposOf(root)) nested.add(p);
  // 边界自身不是文件——它由 links 当目录给出，留在 files 里会让同一行出现两次
  const files = listed.filter((f) => !f.endsWith('/') && !nested.has(f)).map((f) => prefix + f);
  const links = [...nested].map((p) => prefix + p);
  for (const p of nested) {
    const dir = path.join(root, p);
    // 没克隆的子模块（工作区里没有 `.git`）别去问 git：那样的空目录里 `ls-files`
    // 会一路上溯找到外层仓库，把外层文件挂到子模块名下
    if (!(await hasGitDir(dir))) continue;
    const inner = await listViaGit(dir, `${prefix}${p}/`);
    if (!inner) continue;
    files.push(...inner.files);
    links.push(...inner.links);
  }
  return { files, links };
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
      } else if (e.isFile() && e.name !== '.git') {
        // `.git` 文件（worktree / 子模块）不是要看的东西
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

/**
 * git 指纹：`.git/index` 的 mtime + 大小。**新建未跟踪文件不动它**（实测），所以它管
 * 「commit / 切分支 / checkout」这类立刻可感的变动，未跟踪的新建仍由硬窗兜。
 * `.git` 是文件（worktree / 子模块）时按里面那行 `gitdir:` 找过去。
 */
async function gitStamp(root: string): Promise<string | null> {
  try {
    let gitDir = path.join(root, '.git');
    if (!(await lstat(gitDir)).isDirectory()) {
      const line = /^gitdir:\s*(.+)$/m.exec(await readFile(gitDir, 'utf8'));
      if (!line) return null;
      gitDir = path.resolve(root, line[1]!.trim());
    }
    const s = await stat(path.join(gitDir, 'index'));
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null; // 没 .git / 刚 init 还没 add 过任何东西
  }
}

/** 枚举 → 快照（这一层只落可序列化的东西）。 */
async function enumerateIndex(root: string): Promise<FileIndexSnapshot> {
  const fromGit = await listViaGit(root);
  const files = fromGit?.files ?? (await listViaWalk(root));
  const truncated = files.length > MAX_INDEX_FILES;
  const kept = truncated ? files.slice(0, MAX_INDEX_FILES) : files;
  kept.sort();
  // 子模块目录直接由 gitlink 给出——没克隆的子模块没有内容可派生，它自己也还要在
  // （连同它的上层目录：`vendor/lib` 空着时 `vendor` 仍然得能进去）
  const links = fromGit?.links ?? [];
  const dirs = [...new Set([...dirsOf(kept), ...links, ...dirsOf(links)])].sort();
  return {
    v: INDEX_VERSION,
    root,
    at: Date.now(),
    stamp: await gitStamp(root),
    truncated,
    files: kept,
    dirs,
  };
}

/**
 * 快照 → 可查的索引：小写表与目录子项映射这些**派生态**在这里算好挂在索引上。
 * 落盘那份读回来走的也是这一条（只存快照、不存派生）。
 */
export function hydrateIndex(snap: FileIndexSnapshot): FileIndex {
  const lower = new Array<string>(snap.files.length);
  for (let i = 0; i < snap.files.length; i++) lower[i] = snap.files[i]!.toLowerCase();
  const dirLower = new Array<string>(snap.dirs.length);
  for (let i = 0; i < snap.dirs.length; i++) dirLower[i] = snap.dirs[i]!.toLowerCase();

  const children = new Map<string, DirChildren>();
  const kidsOf = (dir: string): DirChildren => {
    let kids = children.get(dir);
    if (!kids) children.set(dir, (kids = { dirs: [], files: [], sorted: false }));
    return kids;
  };
  for (const d of snap.dirs) kidsOf(d.slice(0, Math.max(0, d.lastIndexOf('/')))).dirs.push(d);
  for (const f of snap.files) kidsOf(f.slice(0, Math.max(0, f.lastIndexOf('/')))).files.push(f);
  return { ...snap, lower, dirLower, children };
}

export async function buildIndex(root: string): Promise<FileIndex> {
  return hydrateIndex(await enumerateIndex(root));
}

const cache = new Map<number, FileIndex>();
const inflight = new Map<number, Promise<FileIndex>>();

/** 落盘根（测试注入临时目录；生产 = `<dataDir>/cache/index`）。 */
let indexRoot: string | null = null;

/** 测试用：把落盘根改到临时目录（null = 回到生产口径）。 */
export function setFileIndexRoot(dir: string | null): void {
  indexRoot = dir;
}

function indexPathOf(projectId: number): string {
  return path.join(indexRoot ?? getIndexDir(), `${projectId}.json`);
}

/** 只挑可序列化那七个字段：`FileIndex` 上的派生表（小写 / 子项）绝不进盘。 */
function snapshotOf(index: FileIndex): FileIndexSnapshot {
  return {
    v: index.v,
    root: index.root,
    at: index.at,
    stamp: index.stamp,
    truncated: index.truncated,
    files: index.files,
    dirs: index.dirs,
  };
}

/** 落盘（tmp + rename 原子换）。写不进去不影响这次结果——下次重建就是。 */
async function writeSnapshot(projectId: number, index: FileIndex): Promise<void> {
  const file = indexPathOf(projectId);
  const tmp = `${file}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(snapshotOf(index)), 'utf8');
    await rename(tmp, file);
  } catch {
    // 可弃档：盘满 / 权限 / 并发写同一个项目都只是少一层缓存
  }
}

/** 读盘上的快照：版本与根对不上就作废（项目换了路径、旧格式）。 */
async function readSnapshot(projectId: number, root: string): Promise<FileIndexSnapshot | null> {
  try {
    const snap = JSON.parse(await readFile(indexPathOf(projectId), 'utf8')) as FileIndexSnapshot;
    if (snap?.v !== INDEX_VERSION || snap.root !== root) return null;
    if (!Array.isArray(snap.files) || !Array.isArray(snap.dirs)) return null;
    return snap;
  } catch {
    return null;
  }
}

function remember(projectId: number, index: FileIndex): void {
  // 重插到尾部 = 最近使用；超出上限淘汰最旧的
  cache.delete(projectId);
  cache.set(projectId, index);
  while (cache.size > MAX_CACHED_PROJECTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function rebuild(projectId: number, root: string): Promise<FileIndex> {
  const flying = inflight.get(projectId);
  if (flying) return flying;
  const job = buildIndex(root).then((index) => {
    remember(projectId, index);
    void writeSnapshot(projectId, index);
    return index;
  });
  inflight.set(projectId, job);
  const done = (): void => {
    inflight.delete(projectId);
  };
  job.then(done, done);
  return job;
}

/**
 * 取项目索引：`fresh` = 打开选择器那一拍，无条件重建；否则在飞则共用一次构建
 * （同 `/toolkit` 的口径），命中缓存则**先核 git 指纹**——变了立刻重建，没变才复用
 * （一次 lstat + 一次 stat，比一个请求本身还便宜）。
 *
 * 内存里没有（daemon 刚起来）先看**盘上那份**：版本、根、git 指纹全对得上、年纪
 * 在 `INDEX_MAX_STALE_MS` 内就直接端出去，省掉整棵重建（粘贴认引用是每次粘贴都要
 * 走的路径）。`fresh` 仍然不许走后门——它就是「现在重建」。
 */
export async function projectFileIndex(
  projectId: number,
  root: string,
  opts: { fresh?: boolean } = {},
): Promise<FileIndex> {
  const hit = cache.get(projectId);
  if (hit && hit.root === root && !opts.fresh) {
    if (Date.now() - hit.at < INDEX_TTL_MS && (await gitStamp(root)) === hit.stamp) return hit;
    cache.delete(projectId);
  } else if (hit) {
    cache.delete(projectId); // 换了根 / 要求重建：内存这份不再作数
  }

  const flying = inflight.get(projectId);
  if (flying) return flying;

  // 盘上那份只在**内存空着**（daemon 刚起来）时接手：内存里那份是被硬窗判过期的，
  // 再从盘上捞回来等于把 30 秒硬窗悄悄延长到十分钟。
  if (!hit && !opts.fresh) {
    const snap = await readSnapshot(projectId, root);
    if (snap && Date.now() - snap.at < INDEX_MAX_STALE_MS && (await gitStamp(root)) === snap.stamp) {
      const index = hydrateIndex(snap);
      remember(projectId, index);
      return index;
    }
  }
  return rebuild(projectId, root);
}

/** 测试用：清空索引缓存。 */
export function clearFileIndexCache(): void {
  cache.clear();
}

/** 删掉已不在库里的项目的快照（大仓库一份按 MB 计），daemon 启动时清一次。 */
export function pruneFileIndexes(projectIds: readonly number[]): void {
  const dir = indexRoot ?? getIndexDir();
  const keep = new Set(projectIds.map((id) => `${id}.json`));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // 还没建过索引
  }
  for (const name of names) {
    if (!name.endsWith('.json') || keep.has(name)) continue;
    try {
      rmSync(path.join(dir, name));
    } catch {
      // 正被别的进程写着：下次启动再清
    }
  }
}

/** 自然序（`file-2` 在 `file-10` 前）。**共用一个 `Intl.Collator`**：`localeCompare`
 *  每次都现造排序器，30 万条排一遍要六百毫秒，这个只要二十六毫秒。 */
const BY_NAME = new Intl.Collator(undefined, { numeric: true });

/** 目录浏览：`dir`（相对，'' = 根）的直接子项，目录在前、名字排（自然序）。 */
export function listDirOf(index: FileIndex, dir: string): { path: string; kind: PathRefKind }[] {
  const kids = index.children.get(dir);
  if (!kids) return [];
  if (!kids.sorted) {
    // 同一父目录下比较全长与只比较名字等价（前缀一致），故直接按全长排
    kids.dirs.sort(BY_NAME.compare);
    kids.files.sort(BY_NAME.compare);
    kids.sorted = true;
  }
  const out: { path: string; kind: PathRefKind }[] = [];
  for (const d of kids.dirs) out.push({ path: d, kind: 'dir' });
  for (const f of kids.files) out.push({ path: f, kind: 'file' });
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

interface Candidate {
  path: string;
  kind: PathRefKind;
  rank: number;
  len: number;
}

/** 排序口径：档位高的在前，同档短的在前（更可能是要的那个），再按路径升序。 */
function compareHits(a: Candidate, b: Candidate): number {
  return b.rank - a.rank || a.len - b.len || a.path.localeCompare(b.path);
}

export interface MatchResult {
  hits: PathHit[];
  /** 命中数；`capped` 时是「至少这么多」（提前收工，没再往下数）。 */
  total: number;
  /** 满档即停：后面同档的命中用户本来就翻不到，不必扫完。 */
  capped: boolean;
}

export interface MatchJob {
  /** 跑一小刀（约 `budgetMs`）；true = 完事。 */
  step(budgetMs: number): boolean;
  result(): MatchResult;
}

/** 每刀 ~8ms：30 万条全扫是一两百毫秒，一口气跑完这段时间里所有请求（含 SSE 写帧）都得等。 */
const MATCH_SLICE_MS = 8;
const MATCH_YIELD_EVERY = 1024;

/**
 * 全索引模糊匹配 top `limit`（文件与目录同池竞争），分刀形态：调用方在刀与刀之间
 * 让出事件循环。`limit` 满且最差那条已是最高档时直接收工——再扫也挤不进榜。
 */
export function startMatch(index: FileIndex, query: string, limit: number): MatchJob {
  const q = query.trim().toLowerCase();
  const best: Candidate[] = [];
  let phase: 'files' | 'dirs' | 'done' = q && limit > 0 ? 'files' : 'done';
  let at = 0;
  let seen = 0;
  let capped = false;

  const offer = (p: string, lowerPath: string, kind: PathRefKind): void => {
    const rank = rankOf(lowerPath, lowerPath.slice(lowerPath.lastIndexOf('/') + 1), q);
    if (rank < 0) return;
    seen++;
    const c: Candidate = { path: p, kind, rank, len: p.length };
    if (best.length === limit && compareHits(c, best[limit - 1]!) >= 0) return;
    const full = best.length === limit;
    // 满档时新来的顶掉最差那条，再往前冒泡到位
    let i = full ? limit - 1 : best.length;
    if (full) best[limit - 1] = c;
    else best.push(c);
    while (i > 0 && compareHits(c, best[i - 1]!) < 0) {
      best[i] = best[i - 1]!;
      i--;
    }
    best[i] = c;
  };

  return {
    step(budgetMs: number): boolean {
      const deadline = Date.now() + budgetMs;
      let ticks = 0;
      while (phase !== 'done') {
        const paths = phase === 'files' ? index.files : index.dirs;
        const lowers = phase === 'files' ? index.lower : index.dirLower;
        const kind: PathRefKind = phase === 'files' ? 'file' : 'dir';
        while (at < paths.length) {
          offer(paths[at]!, lowers[at]!, kind);
          at++;
          if (best.length === limit && best[limit - 1]!.rank === 3) {
            capped = true;
            phase = 'done';
            return true;
          }
          if ((++ticks & (MATCH_YIELD_EVERY - 1)) === 0 && Date.now() > deadline) return false;
        }
        at = 0;
        phase = phase === 'files' ? 'dirs' : 'done';
      }
      return true;
    },
    result(): MatchResult {
      // 命中区间只为真的会下发的那几条算：宽查询（`src`）能命中整个索引，逐条去算
      // 区间就是白烧——被 limit 切掉的没人看。
      return {
        hits: best.map((s) => ({
          path: s.path,
          kind: s.kind,
          ranges: rangesOf(s.path, s.rank, q),
        })),
        total: capped ? best.length : seen,
        capped,
      };
    },
  };
}

/** 全索引模糊匹配 top `limit`：分刀跑完，刀与刀之间让出事件循环。 */
export async function matchPaths(
  index: FileIndex,
  query: string,
  limit: number,
): Promise<MatchResult> {
  const job = startMatch(index, query, limit);
  while (!job.step(MATCH_SLICE_MS)) await new Promise<void>((resolve) => setImmediate(resolve));
  return job.result();
}
