import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import type { FSWatcher } from 'chokidar';
import type { ProjectRepository } from '../repositories/projects.js';
import { WatchCache } from './cache.js';
import { classifyAgent, classifyAsset, normalizeRelPath } from './classifier.js';
import type { AssetChangeEvent, AssetChangeKind, AssetEntry } from './types.js';
import { globalPersonalSkillRoots } from '../install/global-config.js';

/** Synthetic projectPath for global skill events. Personal skill roots
 * (`~/.claude/skills/`, `~/.agents/skills/`, and the deprecated
 * `~/.codex/skills/`) are watched so edits to a
 * symlinked skill's original files reach the dashboard. These events are not
 * tied to any registered project — App.tsx ignores them for its project asset
 * cache (projectPath mismatch) and the skill drawer listens on its own. */
const GLOBAL_SENTINEL = '<global>';

/**
 * Decide whether a project-relative path (posix separators) should be ignored
 * by the watcher.
 *
 * chokidar v4 dropped glob support, so we watch the project root (`'.'` with
 * `cwd`) and filter with this function: keep only `.claude/`, `.codex/`,
 * `.weave/`, `.mcp.json` and the two instruction files (CLAUDE.md / AGENTS.md);
 * drop large/irrelevant subtrees (`node_modules`, `.git`, and the
 * session-history/cache dirs under `.claude`).
 */
export function shouldIgnore(rel: string): boolean {
  if (rel === '' || rel === '.') return false; // project root itself
  // Drop noisy / large subtrees first.
  if (rel === 'node_modules' || rel.startsWith('node_modules/')) return true;
  if (rel === '.git' || rel.startsWith('.git/')) return true;
  if (rel === '.claude/projects' || rel.startsWith('.claude/projects/')) return true;
  if (rel === '.claude/cache' || rel.startsWith('.claude/cache/')) return true;
  // Keep everything else under .claude / .codex / .weave, and the mcp config file.
  if (rel === '.claude' || rel.startsWith('.claude/')) return false;
  if (rel === '.codex' || rel.startsWith('.codex/')) return false;
  if (rel === '.weave' || rel.startsWith('.weave/')) return false;
  if (rel === '.mcp.json') return false;
  if (rel === 'CLAUDE.md' || rel === 'AGENTS.md') return false;
  return true; // ignore all other project files
}

export interface WatchServiceOptions {
  /** Debounce window for batching change events, ms. Default 300. */
  debounceMs?: number;
  /** Interval to reconcile watchers against the projects table, ms. Default 5000. */
  reconcileMs?: number;
  /** Custom ignore predicate (project-relative posix path). Default: shouldIgnore. */
  isIgnored?: (rel: string) => boolean;
}

/**
 * Watches each registered project's Claude Code assets and maintains an
 * in-memory cache. The cache is the sole read target for HTTP handlers;
 * asset state is NEVER persisted to sqlite (filesystem is single source of truth).
 *
 * A periodic reconciler diffs the `projects` table against active watchers so
 * projects registered later (e.g. via `weave init`/`weave scan` in another
 * process) are picked up without an explicit notify channel.
 */
export class WatchService {
  private readonly emitter = new EventEmitter();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly cache = new WatchCache();
  private readonly debounceMs: number;
  private readonly reconcileMs: number;
  private readonly isIgnored: (rel: string) => boolean;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, Map<string, AssetChangeEvent>>();
  private reconcileTimer: NodeJS.Timeout | undefined;
  // Global personal skill roots (~/.claude/skills/, ~/.agents/skills/, and the
  // deprecated ~/.codex/skills/) watched
  // for live preview of symlinked skills. Keyed by absolute root path.
  private readonly globalWatchers = new Map<string, FSWatcher>();
  private readonly globalPending = new Map<string, AssetChangeEvent>();
  private globalTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly projects: ProjectRepository,
    options: WatchServiceOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 300;
    this.reconcileMs = options.reconcileMs ?? 5000;
    this.isIgnored = options.isIgnored ?? shouldIgnore;
  }

  /** Begin watching all currently-registered projects + periodic reconcile. */
  start(): void {
    this.reconcile();
    this.reconcileTimer = setInterval(() => this.reconcile(), this.reconcileMs);
  }

  /** Stop all watchers and clear caches/timers. */
  stop(): void {
    for (const w of this.watchers.values()) void w.close();
    this.watchers.clear();
    for (const w of this.globalWatchers.values()) void w.close();
    this.globalWatchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
    this.globalPending.clear();
    if (this.globalTimer) {
      clearTimeout(this.globalTimer);
      this.globalTimer = undefined;
    }
    this.cache.clearAll();
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
  }

  /** Sync watchers with the projects table: start new projects, drop removed.
   * Also reconcile global personal skill roots so a root created after start
   * (e.g. ~/.claude/skills/ appearing later) gets picked up. */
  reconcile(): void {
    const current = new Set(this.projects.list().map((p) => p.path));
    for (const projectPath of current) {
      if (!this.watchers.has(projectPath)) this.watchProject(projectPath);
    }
    for (const projectPath of [...this.watchers.keys()]) {
      if (!current.has(projectPath)) this.unwatchProject(projectPath);
    }
    this.reconcileGlobalRoots();
  }

  /** Watch any existing personal skill root that is not yet watched, and drop
   * watchers for roots that have disappeared. */
  private reconcileGlobalRoots(): void {
    const roots = new Set(globalPersonalSkillRoots());
    for (const root of roots) {
      if (this.globalWatchers.has(root)) continue;
      if (!existsSync(root)) continue; // created later — picked up next reconcile
      this.watchGlobalRoot(root);
    }
    for (const root of [...this.globalWatchers.keys()]) {
      if (!roots.has(root) || !existsSync(root)) {
        const w = this.globalWatchers.get(root);
        if (w) void w.close();
        this.globalWatchers.delete(root);
      }
    }
  }

  /** Read cached assets for a project (in-memory only, never hits disk). */
  getAssets(projectPath: string): AssetEntry[] {
    return this.cache.list(projectPath);
  }

  /** Subscribe to debounced change events. Returns an unsubscribe function. */
  subscribe(listener: (e: AssetChangeEvent) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  private watchProject(projectPath: string): void {
    if (!existsSync(projectPath)) return; // deleted on disk; skip until it reappears
    const project = this.projects.getByPath(projectPath);
    const projectName = project?.name ?? path.basename(projectPath);

    // chokidar v4 has no glob support: watch the project root and filter with
    // the ignore predicate. Note v4 invokes `ignored` with ABSOLUTE paths even
    // when `cwd` is set, while `add`/`change`/`unlink` report cwd-relative paths
    // — so we normalize to a project-relative posix path before classifying.
    const w = watch('.', {
      cwd: projectPath,
      ignored: (testPath: string) =>
        this.isIgnored(normalizeRelPath(path.relative(projectPath, testPath))),
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.watchers.set(projectPath, w);

    w.on('add', (p) => this.onFile(projectPath, projectName, p, 'add'));
    w.on('change', (p) => this.onFile(projectPath, projectName, p, 'change'));
    w.on('unlink', (p) => this.onFile(projectPath, projectName, p, 'unlink'));
    // Watch errors must never crash the daemon (EventEmitter throws on 'error'
    // with no listeners); route to a safe custom event.
    w.on('error', (err) => this.emitter.emit('watch-error', err));
  }

  private unwatchProject(projectPath: string): void {
    const w = this.watchers.get(projectPath);
    if (w) {
      void w.close();
      this.watchers.delete(projectPath);
    }
    const t = this.timers.get(projectPath);
    if (t) {
      clearTimeout(t);
      this.timers.delete(projectPath);
    }
    this.pending.delete(projectPath);
    this.cache.clear(projectPath);
  }

  /** Watch a personal skill root (`~/.claude/skills/`, `~/.agents/skills/`, or the
   * deprecated `~/.codex/skills/`).
   * `followSymlinks` (default) lets edits to a symlinked skill's original files
   * (the link target, e.g. a dev repo) surface as events on the link path,
   * matching the abs paths returned by `listGlobalSkillFiles`. `ignoreInitial`
   * avoids flooding with add-events for every existing file at startup. */
  private watchGlobalRoot(root: string): void {
    const w = watch('.', {
      cwd: root,
      ignored: (testPath: string) => path.basename(testPath).startsWith('.'),
      ignoreInitial: true,
      followSymlinks: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.globalWatchers.set(root, w);
    w.on('add', (p) => this.onGlobalFile(root, p, 'add'));
    w.on('change', (p) => this.onGlobalFile(root, p, 'change'));
    w.on('unlink', (p) => this.onGlobalFile(root, p, 'unlink'));
    w.on('error', (err) => this.emitter.emit('watch-error', err));
  }

  /** Handle a change inside a global personal skill root. Events carry the
   * GLOBAL_SENTINEL projectPath so App.tsx's project cache ignores them; the
   * open skill drawer subscribes to its own EventSource and re-fetches. The
   * agent is derived from the root (`.codex` path segment → Codex). */
  private onGlobalFile(root: string, rawPath: string, kind: AssetChangeKind): void {
    const relPath = normalizeRelPath(rawPath);
    const absPath = path.join(root, relPath);
    this.enqueueGlobal({
      projectPath: GLOBAL_SENTINEL,
      projectName: 'global',
      category: 'skill',
      agent: root.split(/[\\/]/).some((seg) => seg === '.codex' || seg === '.agents')
        ? 'codex'
        : 'claude',
      relPath,
      absPath,
      kind,
    });
  }

  /** Buffer a global event and coalesce per-file within the debounce window. */
  private enqueueGlobal(e: AssetChangeEvent): void {
    this.globalPending.set(e.absPath, e); // last write wins for this file
    if (this.globalTimer) clearTimeout(this.globalTimer);
    this.globalTimer = setTimeout(() => this.flushGlobal(), this.debounceMs);
  }

  private flushGlobal(): void {
    this.globalTimer = undefined;
    for (const e of this.globalPending.values()) this.emitter.emit('change', e);
    this.globalPending.clear();
  }

  private onFile(
    projectPath: string,
    projectName: string,
    rawPath: string,
    kind: AssetChangeKind,
  ): void {
    const relPath = normalizeRelPath(rawPath);
    const absPath = path.join(projectPath, relPath);
    const category = classifyAsset(relPath);
    const agent = classifyAgent(relPath);

    if (kind === 'unlink') {
      this.cache.remove(projectPath, relPath);
    } else {
      try {
        const stat = statSync(absPath);
        this.cache.upsert(projectPath, { absPath, relPath, category, agent, mtimeMs: stat.mtimeMs });
      } catch {
        // File vanished between event and stat — treat as removal.
        this.cache.remove(projectPath, relPath);
      }
    }

    this.enqueue(projectPath, { projectPath, projectName, category, agent, relPath, absPath, kind });
  }

  /** Buffer an event and coalesce per-file within the debounce window. */
  private enqueue(projectPath: string, e: AssetChangeEvent): void {
    let bucket = this.pending.get(projectPath);
    if (!bucket) {
      bucket = new Map();
      this.pending.set(projectPath, bucket);
    }
    bucket.set(e.relPath, e); // last write wins for this file

    const existing = this.timers.get(projectPath);
    if (existing) clearTimeout(existing);
    this.timers.set(
      projectPath,
      setTimeout(() => this.flush(projectPath), this.debounceMs),
    );
  }

  private flush(projectPath: string): void {
    this.timers.delete(projectPath);
    const bucket = this.pending.get(projectPath);
    this.pending.delete(projectPath);
    if (!bucket) return;
    for (const e of bucket.values()) this.emitter.emit('change', e);
  }
}
