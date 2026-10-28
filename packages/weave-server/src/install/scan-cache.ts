import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  scanLibraryFileAssets,
  scanLibraryMcp,
  scanLibraryPlugins,
  scanLibrarySkills,
  type FileAssetTemplate,
  type MarketPluginAsset,
  type McpTemplate,
  type SkillAsset,
} from './scanner.js';
import type { FileAssetCategory } from './file-assets.js';

/** 四扫描全量原料（不带 kind 门控——门控是调用方的事，缓存只存原料）。 */
export interface LibraryScan {
  plugins: MarketPluginAsset[];
  packRoots: string[];
  skills: SkillAsset[];
  mcp: McpTemplate[];
  files: Record<FileAssetCategory, FileAssetTemplate[]>;
}

const CACHE_FILE = 'scans.json';
const CACHE_VERSION = 1;

/**
 * 冷层落点：`<lib 的父目录>/.weave-scans/<lib 目录名>/scans.json`——每个库
 * 一份同名 scans.json、分别管理（market 导入即在 `<dataDir>/market/` 下）。
 * 不写进被扫目录本身：否则污染 hashSkillDir 内容哈希，还会被 installSkill
 * 整目录拷进项目；`.weave-scans` 是点前缀目录，所有扫描器都跳过。
 */
function cacheDirOf(libPath: string): string {
  const abs = path.resolve(libPath);
  return path.join(path.dirname(abs), '.weave-scans', path.basename(abs));
}

const memory = new Map<string, LibraryScan>();
const inflight = new Map<string, Promise<LibraryScan>>();

/** 四扫描编排唯一出口：plugins 先行定 packRoots（包内资源排除），再三线并扫。 */
export async function scanLibrary(libPath: string): Promise<LibraryScan> {
  const { plugins, packRoots } = await scanLibraryPlugins(libPath);
  const [skills, mcp, files] = await Promise.all([
    scanLibrarySkills(libPath, packRoots),
    scanLibraryMcp(libPath, packRoots),
    scanLibraryFileAssets(libPath, packRoots),
  ]);
  return { plugins, packRoots, skills, mcp, files };
}

/**
 * 缓存读取：内存 → 旁挂 `scans.json` → 扫描（write-through）。
 * 只有导入覆盖/刷新/检查更新等事件失效，开页读路径一律走这里不扫树。
 */
export async function getLibraryScan(libPath: string): Promise<LibraryScan> {
  const key = path.resolve(libPath);
  const hit = memory.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = load(key);
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

async function load(libPath: string): Promise<LibraryScan> {
  // 库目录被外部删掉后缓存文件仍在、root 校验也照样相等 ⇒ 会命中返回幽灵资产。
  // 读缓存前先验目录在不在：不在 = miss + 顺手清掉孤儿缓存文件。
  if (!existsSync(libPath)) {
    try {
      await rm(cacheDirOf(libPath), { recursive: true, force: true });
    } catch {
      // 孤儿缓存清不掉不碍事：目录都不在了，缓存命中已被跳过
    }
    const scan = await scanLibrary(libPath);
    memory.set(libPath, scan);
    return scan;
  }
  const cached = await readScanFile(libPath);
  if (cached) {
    memory.set(libPath, cached);
    return cached;
  }
  const scan = await scanLibrary(libPath);
  await writeScanFile(libPath, scan);
  memory.set(libPath, scan);
  return scan;
}

async function readScanFile(libPath: string): Promise<LibraryScan | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(cacheDirOf(libPath), CACHE_FILE), 'utf8')) as
      | ({ version?: number; root?: string } & Partial<LibraryScan>)
      | null;
    if (
      !parsed ||
      parsed.version !== CACHE_VERSION ||
      // 缓存里存的是绝对路径，且跟随市场目录整体搬迁（数据目录三档）；根对不上
      // 就整份作废重扫，否则搬完还按旧绝对路径去 cp。
      parsed.root !== libPath ||
      !Array.isArray(parsed.plugins) ||
      !Array.isArray(parsed.packRoots) ||
      !Array.isArray(parsed.skills) ||
      !Array.isArray(parsed.mcp) ||
      !parsed.files ||
      typeof parsed.files !== 'object'
    ) {
      return null;
    }
    return parsed as LibraryScan;
  } catch {
    return null; // 缺失/损坏 = 该库 miss 自愈，不牵连别库
  }
}

async function writeScanFile(libPath: string, scan: LibraryScan): Promise<void> {
  try {
    await mkdir(cacheDirOf(libPath), { recursive: true });
    await writeFile(
      path.join(cacheDirOf(libPath), CACHE_FILE),
      JSON.stringify({ version: CACHE_VERSION, root: libPath, ...scan }),
      'utf8',
    );
  } catch {
    // 父目录只读写不进 = 降级纯内存
  }
}

/** 热层删键 + 删该库的 `.weave-scans/<名>/`；等在途扫描落地再删，防旧结果回写。 */
export async function invalidateScan(dir: string): Promise<void> {
  const key = path.resolve(dir);
  memory.delete(key);
  const pending = inflight.get(key);
  if (pending) await pending.catch(() => {});
  await rm(cacheDirOf(key), { recursive: true, force: true });
  memory.delete(key);
}

export function clearScanCache(): void {
  memory.clear();
}
