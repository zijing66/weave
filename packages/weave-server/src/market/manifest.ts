import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { getDataDir } from '../db/paths.js';

/** 市场资源目录内的清单文件名（不加表列，元数据随目录走）。 */
export const MANIFEST_FILE = '.weave-market.json';

export interface MarketManifest {
  source: 'dir' | 'git';
  /** 导入前的原始来源（本地绝对路径或 git URL）。 */
  origin: string;
  importedAt: string;
  /** 预留给 git 更新检查（BACKLOG）——当前恒为空。 */
  commit?: string;
}

/** 资源市场收纳根：`<getDataDir()>/market/`。 */
export function marketDir(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'market');
}

export function manifestPath(resourceDir: string): string {
  return path.join(resourceDir, MANIFEST_FILE);
}

/** 读清单；缺失或不合法返回 null（legacy 目录没有清单）。 */
export async function readManifest(resourceDir: string): Promise<MarketManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(resourceDir), 'utf-8')) as MarketManifest;
    return parsed && typeof parsed === 'object' && (parsed.source === 'dir' || parsed.source === 'git')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function writeManifest(
  resourceDir: string,
  manifest: MarketManifest,
): Promise<void> {
  await writeFile(manifestPath(resourceDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}
