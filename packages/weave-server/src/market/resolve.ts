import path from 'node:path';
import { getDataDir } from '../db/paths.js';
import type { LibraryRepository } from '../repositories/libraries.js';
import { marketDir } from './manifest.js';
import { isBuiltinMarketDir } from './builtin.js';

/**
 * 批 9（R11 迁移兼容闸）：`libraries.path` 的读侧单点。
 *
 * - 相对路径（posix 分隔符入库）→ `path.join(dataDir, rel)` 还原（Windows 下分隔符/盘符经 join 归一）；
 * - 绝对路径且在 dataDir 内 → 旧写法，返回解析值；`LibraryRepository` 读侧据此惰性 UPDATE 为相对形；
 * - 绝对路径且在 dataDir 外 → legacy 外部源，原样返回（永不改写、不自动复制，显式迁入才进市场）。
 */
export function resolveLibraryPath(
  row: { path: string },
  dataDir: string = getDataDir(),
): string {
  if (!path.isAbsolute(row.path)) return path.join(dataDir, row.path);
  const abs = path.resolve(row.path);
  return isInsideDir(abs, dataDir) ? abs : row.path;
}

/** `target` 是否落在 `dir` 内（path.resolve 归一后比较，Windows 盘符差异视为界外）。 */
export function isInsideDir(target: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  if (path.isAbsolute(rel)) return false; // 不同盘符
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

/** 绝对路径 → 相对 dataDir 的 posix 形（markets.path 的规范存储形）。 */
export function toRelPosix(absPath: string, dataDir: string = getDataDir()): string {
  return path.relative(path.resolve(dataDir), path.resolve(absPath)).split(path.sep).join('/');
}

/**
 * managed 市场资源根（位于 `<dataDir>/market/` 内的库行）——toolkit 扫描源与
 * plugin-loader 装载源共用的同一口径（M3 装载桥）；legacy 外部源不入内。
 *
 * **内置仓排除在外**：它的根由 `discoverToolkitSources()` 以 `provenance:'builtin'`
 * 单独提供；若这里也返回，同一棵树会被两遍扫描、同一个包出现两条（一遍 builtin
 * 一遍 market），开关与列表都会重复。
 */
export function marketLibraryRoots(
  libraries: Pick<LibraryRepository, 'list'>,
  dataDir: string = getDataDir(),
): string[] {
  const md = path.resolve(marketDir(dataDir));
  const out = new Set<string>();
  for (const row of libraries.list()) {
    const abs = path.resolve(row.path); // list() 读侧已 resolve，此处归一兜底
    if (abs === md || isBuiltinMarketDir(abs, dataDir)) continue;
    if (isInsideDir(abs, md)) out.add(abs);
  }
  return [...out];
}
