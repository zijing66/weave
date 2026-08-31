import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Per-project weave configuration, stored as `.weave/config.json`.
 *
 * Currently holds only the auto-sync toggle + last-sync timestamp. This is
 * weave's own bookkeeping (not Claude Code's settings.json), so it lives under
 * `.weave/` alongside statusline.json — both are ignored by the watch service
 * as "weave-owned" sidecars.
 */

const WEAVE_DIR = '.weave';
const CONFIG_FILE = 'config.json';

export interface ProjectConfig {
  /** When true, the SyncScheduler auto-applies outdated updates on its tick. */
  autoSync: boolean;
  /** ISO timestamp of the last successful sync (null if never). */
  lastSyncAt: string | null;
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  autoSync: false,
  lastSyncAt: null,
};

function configPath(projectPath: string): string {
  return path.join(projectPath, WEAVE_DIR, CONFIG_FILE);
}

function merge(parsed: Partial<ProjectConfig>): ProjectConfig {
  return {
    autoSync: parsed.autoSync ?? DEFAULT_PROJECT_CONFIG.autoSync,
    lastSyncAt: parsed.lastSyncAt ?? DEFAULT_PROJECT_CONFIG.lastSyncAt,
  };
}

/** Read the project's weave config; falls back to defaults when absent. */
export async function readProjectConfig(projectPath: string): Promise<ProjectConfig> {
  try {
    const raw = await readFile(configPath(projectPath), 'utf-8');
    return merge(JSON.parse(raw) as Partial<ProjectConfig>);
  } catch {
    return DEFAULT_PROJECT_CONFIG;
  }
}

/** Persist the project config, creating `.weave/` if needed. */
export async function writeProjectConfig(
  projectPath: string,
  config: ProjectConfig,
): Promise<void> {
  const dir = path.join(projectPath, WEAVE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(configPath(projectPath), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

/** Mark a sync as having happened at the given ISO timestamp. */
export async function markSynced(projectPath: string, iso: string): Promise<void> {
  const cfg = await readProjectConfig(projectPath);
  await writeProjectConfig(projectPath, { ...cfg, lastSyncAt: iso });
}
