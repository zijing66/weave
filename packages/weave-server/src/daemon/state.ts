import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { getDataDir, getDaemonStatePath } from '../db/paths.js';

export interface DaemonState {
  pid: number;
  port: number;
  startedAt: string;
  /** 实际绑定地址（供 CLI 打印局域网访问地址；旧状态文件无此字段）。 */
  host?: string;
}

export function readDaemonState(): DaemonState | null {
  const p = getDaemonStatePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as DaemonState;
  } catch {
    return null;
  }
}

export function writeDaemonState(state: DaemonState): void {
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(getDaemonStatePath(), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export function clearDaemonState(): void {
  const p = getDaemonStatePath();
  if (existsSync(p)) rmSync(p);
}
