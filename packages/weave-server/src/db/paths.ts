import path from 'node:path';
import { detectPlatform } from '@weavecode/core';

/** Absolute path to the global weave data directory (`<configDir>/weave`). */
export function getDataDir(): string {
  return path.join(detectPlatform().configDir, 'weave');
}

/** Absolute path to the SQLite database file. */
export function getDbPath(): string {
  return path.join(getDataDir(), 'weave.db');
}

/** Absolute path to the daemon state file (`{ pid, port, startedAt }`). */
export function getDaemonStatePath(): string {
  return path.join(getDataDir(), 'daemon.json');
}

/** Absolute path to the daemon auth file (password hash + secrets, 0600). */
export function getAuthPath(): string {
  return path.join(getDataDir(), 'auth.json');
}

/** Absolute path to the one-shot initial-password marker (0600; 首个 CLI 命令领取后即删). */
export function getInitialPasswordPath(): string {
  return path.join(getDataDir(), 'initial-password');
}
