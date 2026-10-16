import type { ProjectRepository } from '../repositories/projects.js';
import type { LibraryRepository } from '../repositories/libraries.js';
import type { PluginManager } from '../hooks/plugin-loader.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { buildLibraryIndex } from '../install/library-index.js';
import { detectUpdates } from '../install/updates.js';
import { syncAll } from '../install/apply-update.js';
import { markSynced } from '../install/project-config.js';
import { syncPlugins } from '../hooks/plugin-project-state.js';

/**
 * SyncScheduler — periodically applies outdated updates to every project.
 *
 * **自动/手动由 git 分类单点决定，不再是 per-project 开关**（用户裁决）：不进 git
 * 的 init 生成物与资产由这里自动刷新；会进 git 的一律只报不写，dashboard 提醒
 * 用户跑 `weave init`。所以 tick 无条件扫全部项目，落盘范围由 `syncAll` 内部按
 * git 归类分流。
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
  /**
   * 一轮同步落地后的对账面（项目角标刷新器）。资产写盘会经 watch → SSE 回流，
   * 但项目插件模板的物化落点（`.claude/` 副本）不带 plugin.reloaded——角标只能
   * 靠这一下对账，否则 autoSync 清掉漂移后角标会一直亮着。
   */
  onSynced?: () => void;
}

export class SyncScheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly intervalMs: number;
  private readonly cache: FingerprintCache;
  private readonly plugins?: Pick<PluginManager, 'list'>;
  private readonly onSynced?: () => void;
  private running = false;

  constructor(
    private readonly projects: ProjectRepository,
    private readonly libraries: LibraryRepository,
    options: SyncSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.cache = options.cache ?? new FingerprintCache();
    this.plugins = options.plugins;
    this.onSynced = options.onSynced;
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

  /** One sync sweep across all projects. */
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
        this.onSynced?.();
      }
    } finally {
      this.running = false;
    }
  }
}
