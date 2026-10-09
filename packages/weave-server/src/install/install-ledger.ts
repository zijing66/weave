import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Harness } from '@weavecode/core';
import type { FileAssetCategory } from './file-assets.js';

/**
 * 安装意图账本（`.weave/installed.json`）——"本该装着"的资产清单。
 *
 * 扫盘只能看到现存的东西：**被删掉的和从没装过的在报告里长得一模一样**，自动同步
 * 因此无从补齐。安装时登记、卸载时删账（主动卸载不该被补齐逆回），账本损坏一律
 * 当空（读侧口径同 server 其它 JSON 读）。只收 project scope —— 全局资产是用户级
 * 共享，不随某个项目的同步走。
 */
export interface InstalledAssetRecord {
  category: 'skill' | 'mcp' | 'file';
  name: string;
  agent: Harness;
  /** file 资产必填（FILE_ASSET_SPECS 的键）。 */
  assetCategory?: FileAssetCategory;
}

const LEDGER_REL = path.join('.weave', 'installed.json');

/** 身份键：同类同名同 agent 同资产类别才算同一条（不含 scope——只收 project）。 */
const keyOf = (record: InstalledAssetRecord): string =>
  [record.category, record.name, record.agent, record.assetCategory ?? ''].join('\u0000');

function isRecord(value: unknown): value is InstalledAssetRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    (r['category'] === 'skill' || r['category'] === 'mcp' || r['category'] === 'file') &&
    typeof r['name'] === 'string' &&
    r['name'] !== '' &&
    typeof r['agent'] === 'string'
  );
}

export async function readInstalledLedger(projectPath: string): Promise<InstalledAssetRecord[]> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(projectPath, LEDGER_REL), 'utf-8'),
    ) as { assets?: unknown };
    return Array.isArray(raw.assets) ? raw.assets.filter(isRecord) : [];
  } catch {
    return [];
  }
}

export async function recordInstalled(
  projectPath: string,
  record: InstalledAssetRecord,
): Promise<void> {
  const assets = await readInstalledLedger(projectPath);
  if (assets.some((a) => keyOf(a) === keyOf(record))) return;
  await writeLedger(projectPath, [...assets, record]);
}

export async function forgetInstalled(
  projectPath: string,
  record: InstalledAssetRecord,
): Promise<void> {
  const assets = await readInstalledLedger(projectPath);
  const next = assets.filter((a) => keyOf(a) !== keyOf(record));
  if (next.length === assets.length) return;
  await writeLedger(projectPath, next);
}

async function writeLedger(
  projectPath: string,
  assets: InstalledAssetRecord[],
): Promise<void> {
  const file = path.join(projectPath, LEDGER_REL);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: 1, assets }, null, 2)}\n`, 'utf-8');
}
