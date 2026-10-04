import type { ProjectRepository } from '../repositories/projects.js';
import type { LibraryRepository } from '../repositories/libraries.js';
import type { PluginManager } from '../hooks/plugin-loader.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { buildLibraryIndex } from '../install/library-index.js';
import { detectUpdates } from '../install/updates.js';
import { syncAll } from '../install/apply-update.js';
import { readProjectConfig, markSynced } from '../install/project-config.js';
import { syncPlugins } from '../hooks/plugin-project-state.js';

/**
 * SyncScheduler — periodically applies outdated updates to projects that have
 * opted into auto-sync (`.weave/config.json` → `autoSync: true`).
 *
 * This is decoupled from the WatchService's 5s reconcile: sync runs on a longer
 * cadence (default 60s) because it rehashes source directories and writes
 * files. Filesystem writes flow back to the dashboard through the existing
 * watch → SSE channel, so the scheduler does not push its own events.
 */

export interface SyncSchedulerOptions {
  /** Interval between sync sweeps, ms. Default 60000. */
  intervalMs?: number;
  /** Fingerprint cache shared with update-detection routes. */
  cache?: FingerprintCache;
  /** 插件清单源（D3 项目同步的 knownIds）；缺省跳过插件同步。 */
  plugins?: Pick<PluginManager, 'list'>;
}

export class SyncScheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly intervalMs: number;
  private readonly cache: FingerprintCache;
  private readonly plugins?: Pick<PluginManager, 'list'>;
  private running = false;

  constructor(
    private readonly projects: ProjectRepository,
    private readonly libraries: LibraryRepository,
    options: SyncSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.cache = options.cache ?? new FingerprintCache();
    this.plugins = options.plugins;
  }

  start(): void {
    if (this.timer) return;
    // Stagger the first tick off the reconcile cadence.
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One sync sweep across all projects opted into auto-sync. */
  async tick(): Promise<void> {
    if (this.running) return; // avoid overlapping sweeps
    if (!this.libraries) return;
    this.running = true;
    try {
      const libs = this.libraries.list();
      // Build the index once per sweep (reused across all projects).
      const index = await buildLibraryIndex(libs);
      const knownIds = this.plugins?.list().map((p) => p.id);
      for (const project of this.projects.list()) {
        const cfg = await readProjectConfig(project.path);
        if (!cfg.autoSync) continue;
        if (knownIds) {
          try {
            syncPlugins(project, knownIds, { projects: this.projects });
          } catch {
            // 插件同步失败不中断资产同步（R8）
          }
        }
        const report = await detectUpdates(project.path, libs, this.cache, index);
        if (report.available === 0) continue;
        await syncAll(project.path, libs, this.cache, index);
        await markSynced(project.path, new Date().toISOString());
      }
    } finally {
      this.running = false;
    }
  }
}
