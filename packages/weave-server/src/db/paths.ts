import path from 'node:path';
import { detectPlatform } from '@weave/core';

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
