import { execFile as execFileCb } from 'node:child_process';
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getDataDir } from '../db/paths.js';
import type { LibraryRepository, LibraryRow } from '../repositories/libraries.js';
import { isInsideDir, toRelPosix } from './resolve.js';
import { marketDir, readManifest, writeManifest, type MarketManifest } from './manifest.js';

/**
 * 资源市场导入（批 9，R10）：本地目录 / git 仓库一律复制（clone）进
 * `<getDataDir()>/market/<resourceId>/` 成唯一事实源，随后登记 libraries 行
 * （path = 相对 dataDir 的 posix 形）。git 更新检查是 BACKLOG，清单预留 commit。
 */

const execFileAsync = promisify(execFileCb);

const CLONE_TIMEOUT_MS = 60_000;
/** git 失败输出截断上限（R10：输出截断）。 */
const MAX_GIT_OUTPUT = 2_000;

export interface GitExecOptions {
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
}
export type GitResult = { stdout: string; stderr: string };
/** git 执行注入点（execFile 边界）：测试传假 exec 断言参数数组，不真联网。 */
export type GitExec = (
  file: string,
  args: string[],
  options: GitExecOptions,
) => Promise<GitResult>;

export interface ImportDeps {
  libraries: LibraryRepository;
  /** 覆盖 dataDir（测试注入）；默认 getDataDir()。 */
  dataDir?: string;
  /** 覆盖 git 执行（测试注入假 exec）。 */
  execGit?: GitExec;
}

export interface ImportedResource {
  /** 市场目录名（slug，白名单 `[a-z0-9-]`）。 */
  id: string;
  /** 市场内绝对路径。 */
  dir: string;
  /** 相对 dataDir 的 posix 形（libraries.path 规范存储形）。 */
  relPath: string;
  manifest: MarketManifest;
  libraryId: number;
  /** 同一来源重复导入 → 复用同一市场目录与 libraries 行（不新增）。 */
  reused: boolean;
  /** 同源再导入时覆盖刷新了缓存内容（M4：覆盖重导 + 触发重扫）。 */
  refreshed: boolean;
}

/** resourceId slug：白名单 `[a-z0-9-]`，其余字符折叠为 `-`；空结果回落 `resource`（防穿越）。 */
export function slugifyResourceId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : 'resource';
}

/** git URL 协议白名单：`https://`、`ssh://`、`git@host:path`；拒 `ext::`、`--upload-pack` 等向量。 */
export function assertSafeGitUrl(raw: string): string {
  const url = raw.trim();
  if (!url) throw new Error('Missing git URL');
  if (url.includes('--upload-pack')) throw new Error('Invalid git URL (--upload-pack rejected)');
  const ok =
    url.startsWith('https://') || url.startsWith('ssh://') || /^git@[^:/\s]+:/.test(url);
  if (!ok) throw new Error(`Unsupported git URL (allowed: https/ssh): ${url}`);
  if (/[\s\r\n\t]/.test(url)) throw new Error('Invalid git URL (whitespace)');
  return url;
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(text: string): string {
  return text.length > MAX_GIT_OUTPUT ? `${text.slice(0, MAX_GIT_OUTPUT)}…(truncated)` : text;
}

/** 双检：导入目标必须落在市场根内（slug 白名单之外的兜底，R10 containment）。 */
function assertContained(target: string, root: string): void {
  if (!isInsideDir(target, root)) {
    throw new Error(`Import target escapes the market directory: ${target}`);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 新市场目录：`base` 冲突时加 `-2`、`-3`… 后缀。 */
async function uniqueMarketDir(base: string, root: string): Promise<string> {
  let candidate = path.join(root, base);
  let n = 1;
  while (await exists(candidate)) {
    n += 1;
    candidate = path.join(root, `${base}-${n}`);
  }
  return candidate;
}

/** 按 manifest.origin 找既有市场目录（同一来源重复导入 → 复用）。 */
async function findByOrigin(root: string, origin: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const manifest = await readManifest(dir);
    if (manifest?.origin === origin) return dir;
  }
  return null;
}

async function register(
  dir: string,
  manifest: MarketManifest,
  deps: ImportDeps,
  reused: boolean,
  refreshed = false,
): Promise<ImportedResource> {
  const dataDir = deps.dataDir ?? getDataDir();
  const relPath = toRelPosix(dir, dataDir);
  const row = deps.libraries.add({ path: relPath, kind: 'both' });
  return {
    id: path.basename(dir),
    dir,
    relPath,
    manifest,
    libraryId: row.id,
    reused,
    refreshed,
  };
}

/** 同源覆盖刷新：内容先落到 `*.refresh-tmp` 再整目录换入（拷贝失败不丢缓存）。 */
async function replaceWithCopy(src: string, existing: string, root: string): Promise<void> {
  const tmp = `${existing}.refresh-tmp`;
  await rm(tmp, { recursive: true, force: true });
  await cp(src, tmp, { recursive: true });
  assertContained(path.resolve(tmp), root);
  await rm(existing, { recursive: true, force: true });
  await rename(tmp, existing);
}

/** 本地目录 → 复制进市场 + 写清单 + 登记 libraries 行。 */
export async function importFromDir(srcPath: string, deps: ImportDeps): Promise<ImportedResource> {
  const dataDir = deps.dataDir ?? getDataDir();
  const src = path.resolve(srcPath);
  const info = await stat(src).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Not a directory: ${srcPath}`);

  const root = marketDir(dataDir);
  const existing = await findByOrigin(root, src);
  if (existing) {
    const prev = (await readManifest(existing))!;
    // 同源再导入 = 覆盖刷新（M4）：重拷缓存并更新 importedAt；src 已在函数
    // 开头 stat 校验存在，origin 缺失时不会走到这里（不会先删缓存）。
    await replaceWithCopy(src, existing, root);
    const manifest: MarketManifest = { ...prev, importedAt: nowIso() };
    await writeManifest(existing, manifest);
    return register(existing, manifest, deps, true, true);
  }

  const target = await uniqueMarketDir(slugifyResourceId(path.basename(src)), root);
  assertContained(target, root);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(src, target, { recursive: true });
  const manifest: MarketManifest = { source: 'dir', origin: src, importedAt: nowIso() };
  await writeManifest(target, manifest);
  assertContained(path.resolve(target), root);
  return register(target, manifest, deps, false);
}

/** git URL → clone 进市场 + 写清单 + 登记 libraries 行（execFile 数组传参无 shell）。 */
export async function importFromGit(rawUrl: string, deps: ImportDeps): Promise<ImportedResource> {
  const dataDir = deps.dataDir ?? getDataDir();
  const url = assertSafeGitUrl(rawUrl);

  const root = marketDir(dataDir);
  const existing = await findByOrigin(root, url);
  if (existing) {
    const prev = (await readManifest(existing))!;
    // 同源再导入 = 覆盖刷新（M4）：clone 到 *.refresh-tmp 再整目录换入，
    // 网络失败时旧缓存仍在（rm 在 clone 成功之后）。
    const tmp = `${existing}.refresh-tmp`;
    await rm(tmp, { recursive: true, force: true });
    const cloneArgs = ['clone', '--depth', '1', url, tmp];
    try {
      await (deps.execGit ?? defaultGitExec)('git', cloneArgs, {
        timeout: CLONE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (e) {
      throw new Error(`git clone failed: ${truncate(gitErrorText(e))}`);
    }
    assertContained(path.resolve(tmp), root);
    await rm(existing, { recursive: true, force: true });
    await rename(tmp, existing);
    const manifest: MarketManifest = { ...prev, importedAt: nowIso() };
    await writeManifest(existing, manifest);
    return register(existing, manifest, deps, true, true);
  }

  const target = await uniqueMarketDir(slugifyResourceId(gitDirName(url)), root);
  assertContained(target, root); // 校验后再拼参数（R10）
  await mkdir(root, { recursive: true });
  const args = ['clone', '--depth', '1', url, target];
  try {
    await (deps.execGit ?? defaultGitExec)('git', args, {
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e) {
    throw new Error(`git clone failed: ${truncate(gitErrorText(e))}`);
  }
  assertContained(path.resolve(target), root); // clone 后双检
  const manifest: MarketManifest = { source: 'git', origin: url, importedAt: nowIso() };
  await writeManifest(target, manifest);
  return register(target, manifest, deps, false);
}

/** legacy 外部源显式迁入：复制进市场 + 改写既有 libraries 行为相对形（不新增行）。 */
export async function importLibraryIntoMarket(
  row: LibraryRow,
  deps: ImportDeps,
): Promise<ImportedResource> {
  const dataDir = deps.dataDir ?? getDataDir();
  const src = path.isAbsolute(row.path) ? row.path : path.join(dataDir, row.path);
  const abs = path.resolve(src);
  const root = marketDir(dataDir);
  if (!(await exists(abs))) throw new Error(`Source directory not found: ${abs}`);

  if (isInsideDir(abs, root)) {
    // 已在市场内：补清单（幂等迁入），不重复复制。
    let manifest = await readManifest(abs);
    if (!manifest) {
      manifest = { source: 'dir', origin: abs, importedAt: nowIso() };
      await writeManifest(abs, manifest);
    }
    return {
      id: path.basename(abs),
      dir: abs,
      relPath: toRelPosix(abs, dataDir),
      manifest,
      libraryId: row.id,
      reused: true,
      refreshed: false,
    };
  }

  const target = await uniqueMarketDir(slugifyResourceId(path.basename(abs)), root);
  assertContained(target, root);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(abs, target, { recursive: true });
  const manifest: MarketManifest = { source: 'dir', origin: abs, importedAt: nowIso() };
  await writeManifest(target, manifest);
  deps.libraries.setPath(row.id, toRelPosix(target, dataDir));
  return {
    id: path.basename(target),
    dir: target,
    relPath: toRelPosix(target, dataDir),
    manifest,
    libraryId: row.id,
    reused: false,
    refreshed: false,
  };
}

/** 从 URL 取仓库目录名（`https://host/u/repo.git` / `git@host:u/repo.git` → `repo`）。 */
function gitDirName(url: string): string {
  const clean = url.split(/[?#]/)[0];
  const slash = clean.lastIndexOf('/');
  const colon = clean.lastIndexOf(':');
  const tail = slash > colon ? clean.slice(slash + 1) : clean.slice(colon + 1);
  return tail.replace(/\.git$/, '') || 'repo';
}

function gitErrorText(e: unknown): string {
  const err = e as { stderr?: unknown; stdout?: unknown; message?: string };
  const parts = [err?.stderr, err?.stdout].filter(Boolean).map(String);
  const text = parts.length ? parts.join('\n') : e instanceof Error ? e.message : String(e);
  return text.trim() || 'unknown error';
}

export const defaultGitExec: GitExec = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, options);
  return { stdout: String(stdout), stderr: String(stderr) };
};
