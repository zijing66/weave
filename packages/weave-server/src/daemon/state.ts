import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { getDataDir, getDaemonStatePath } from '../db/paths.js';

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
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
