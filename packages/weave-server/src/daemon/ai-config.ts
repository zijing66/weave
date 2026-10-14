import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getAiKeyPath } from '../db/paths.js';

/**
 * AI 助手的供应商 API key：落 `<dataDir>/ai.json`（0600），与 auth.json 同口径——
 * **密钥不进 UI 可读的 settings 表**（GET /settings 直出那张表的内容）。地址与模型名
 * 是非密配置，归 settings 表（`ai.baseUrl` / `ai.model`）。
 */

/** 读 key；缺失/坏文件 → null（调用方按「未配置」处理，不抛）。 */
export function readAiKey(file: string = getAiKeyPath()): string | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { apiKey?: unknown };
    return typeof parsed.apiKey === 'string' && parsed.apiKey !== '' ? parsed.apiKey : null;
  } catch {
    return null;
  }
}

/** 写 key（原子写 + 0600）；`null` = 清除（删文件）。 */
export function writeAiKey(apiKey: string | null, file: string = getAiKeyPath()): void {
  if (apiKey === null || apiKey === '') {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ apiKey }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // 平台不支持时忽略（Windows）
  }
}

export function hasAiKey(file: string = getAiKeyPath()): boolean {
  return readAiKey(file) !== null;
}
