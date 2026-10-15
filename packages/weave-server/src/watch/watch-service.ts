import { EventEmitter } from 'node:events';
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  watch as fsWatch,
} from 'node:fs';
import type { FSWatcher as NodeFSWatcher } from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import type { FSWatcher } from 'chokidar';
import type { ProjectRepository } from '../repositories/projects.js';
import { WatchCache } from './cache.js';
import { classifyAgent, classifyAsset, normalizeRelPath } from './classifier.js';
import { PluginModsSniffer } from './plugin-mods.js';
import type { AssetChangeEvent, AssetChangeKind, AssetEntry, ProjectChangeEvent } from './types.js';
import { globalPersonalSkillRootsOwned } from '../install/global-config.js';
import { assetSurfaces } from '../surfaces.js';
import type { Harness } from '@weavecode/core';

/** Synthetic projectPath for global skill events. Personal skill roots
 * (`~/.claude/skills/`, `~/.agents/skills/`, and the deprecated
 * `~/.codex/skills/`) are watched so edits to a
 * symlinked skill's original files reach the dashboard. These events are not
 * tied to any registered project — App.tsx ignores them for its project asset
 * cache (projectPath mismatch) and the skill drawer listens on its own. */
const GLOBAL_SENTINEL = '<global>';

/** 模块级 sniff 缓存：watch 全生命周期共用（mtime 失效保证 hooks.json 改写可翻转）。 */
const pluginModsSniffer = new PluginModsSniffer();

/**
 * Decide whether a project-relative path (posix separators) should be ignored
 * by the watcher.
 *
 * chokidar v4 dropped glob support, so we watch the project root (`'.'` with
 * `cwd`) and filter with this function. 批 4a：`.claude/` / `.codex/` 观测集
 * （含 `node_modules` / `.git` / session-history 等噪音剔除）收敛进各
 * harness 的 AssetSurface（`ignore`，两面取 AND——任一 surface 观测即保留）；
 * 项目根与 `.weave` 是中立于 harness 的规则，留在此处。
 */
export function shouldIgnore(rel: string): boolean {
  if (rel === '' || rel === '.') return false; // project root itself
  if (rel === '.weave' || rel.startsWith('.weave/')) return false; // weave 自身面
  return assetSurfaces().every((s) => s.ignore(rel));
}

export interface WatchServiceOptions {
  /** Debounce window for batching change events, ms. Default 300. */
  debounceMs?: number;
  /** Interval to reconcile watchers against the projects table, ms. Default 5000. */
  reconcileMs?: number;
  /** Custom ignore predicate (project-relative posix path). Default: shouldIgnore. */
  isIgnored?: (rel: string) => boolean;
  /** 全局个人技能根来源（缺省 = 各 harness 在 `~` 下的根）；测试注入用。 */
  globalRootSource?: () => Array<{ harness: Harness; root: string }>;
}

/** 一个全局技能根的监听：根自身一条非递归（根级条目增删/直接落在根里的文件）
 *  + 每个可见目录条目一条递归（真身——Windows 的递归监听不穿软链）。 */
interface GlobalRootRecord {
  harness: Harness;
  root: NodeFSWatcher;
  entries: Map<string, { real: string; watcher: NodeFSWatcher }>;
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
  private readonly globalRootSource: () => Array<{ harness: Harness; root: string }>;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pending = new Map<string, Map<string, AssetChangeEvent>>();
  private reconcileTimer: NodeJS.Timeout | undefined;
  // Global personal skill roots (~/.claude/skills/, ~/.agents/skills/, and the
  // deprecated ~/.codex/skills/) watched
  // for live preview of symlinked skills. Keyed by absolute root path.
  private readonly globalRoots = new Map<string, GlobalRootRecord>();
  private readonly globalPending = new Map<string, AssetChangeEvent>();
  private globalTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly projects: ProjectRepository,
    options: WatchServiceOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 300;
    this.reconcileMs = options.reconcileMs ?? 5000;
    this.isIgnored = options.isIgnored ?? shouldIgnore;
    this.globalRootSource = options.globalRootSource ?? globalPersonalSkillRootsOwned;
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
    for (const root of [...this.globalRoots.keys()]) this.unwatchGlobalRoot(root);
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
   * (e.g. ~/.claude/skills/ appearing later) gets picked up.
   *
   * Registry diffs (another process ran `weave init`/`scan` against the shared
   * sqlite) are published as `project` events so SSE clients can refresh their
   * project list without a page reload. `added` only fires when a watcher was
   * actually created — a project whose directory vanished is retried silently
   * each cycle instead of spamming the frame. */
  reconcile(): void {
    const current = new Set(this.projects.list().map((p) => p.path));
    for (const projectPath of current) {
      if (!this.watchers.has(projectPath)) {
        this.watchProject(projectPath);
        // watchProject skips missing directories without registering a
        // watcher; only report rows that became observable right now.
        if (this.watchers.has(projectPath)) {
          this.emitter.emit('project', { action: 'added', projectPath });
        }
      }
    }
    for (const projectPath of [...this.watchers.keys()]) {
      if (!current.has(projectPath)) {
        this.unwatchProject(projectPath);
        this.emitter.emit('project', { action: 'removed', projectPath });
      }
    }
    this.reconcileGlobalRoots();
  }

  /** Watch any existing personal skill root that is not yet watched, and drop
   * watchers for roots that have disappeared. */
  private reconcileGlobalRoots(): void {
    const owned = this.globalRootSource();
    const roots = new Set(owned.map((o) => o.root));
    for (const { harness, root } of owned) {
      if (this.globalRoots.has(root)) {
        this.syncGlobalEntries(root); // 新装/卸载的条目即时挂上或摘掉
        continue;
      }
      if (!existsSync(root)) continue; // created later — picked up next reconcile
      this.watchGlobalRoot(root, harness);
    }
    for (const root of [...this.globalRoots.keys()]) {
      if (!roots.has(root) || !existsSync(root)) this.unwatchGlobalRoot(root);
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

  /** Subscribe to project registry changes (weave init/scan in other
   * processes). Returns an unsubscribe function. */
  subscribeProjects(listener: (e: ProjectChangeEvent) => void): () => void {
    this.emitter.on('project', listener);
    return () => this.emitter.off('project', listener);
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

  /**
   * Watch a personal skill root (`~/.claude/skills/`, `~/.agents/skills/`, or the
   * deprecated `~/.codex/skills/`).
   *
   * 目录级递归 `fs.watch`：根下每个可见目录条目一条（软链解到真身——Windows 的
   * 递归监听不穿软链），一个句柄覆盖整棵子树。chokidar 是逐实体 fs.watch：13k 文件
   * 的技能源仓库要开 13k 句柄、扫 20s、烧 24s CPU，单线程 daemon 启动后十几秒内
   * 端点全被拖慢；同一观测集换递归监听是 10 句柄、毫秒级就绪。事件按真身映回根内
   * 相对路径，与 `listGlobalSkillFiles` 给出的路径形一致。 */
  private watchGlobalRoot(root: string, harness: Harness): void {
    const watcher = fsWatch(root, (_ev, fname) => {
      // 根级条目增删/改指（新装、卸载技能）→ 重挂条目监听；直接落在根里的文件照常入队
      this.syncGlobalEntries(root);
      if (fname) this.emitGlobalPath(root, normalizeRelPath(String(fname)));
    });
    watcher.on('error', (err) => this.emitter.emit('watch-error', err));
    this.globalRoots.set(root, { harness, root: watcher, entries: new Map() });
    this.syncGlobalEntries(root);
  }

  /** 把根下每个可见目录条目挂上递归监听（解软链到真身）；移除或改指真身的摘掉。 */
  private syncGlobalEntries(root: string): void {
    const record = this.globalRoots.get(root);
    if (!record) return;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return; // 根暂不可读——下轮 reconcile 再看
    }
    const live = new Set<string>();
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const link = path.join(root, name);
      let real: string;
      try {
        if (!statSync(link).isDirectory()) continue; // 文件条目归根监听管
        real = realpathSync(link);
      } catch {
        continue; // 悬空软链 / 竞态删除
      }
      live.add(name);
      const cur = record.entries.get(name);
      if (cur?.real === real) continue;
      if (cur) {
        cur.watcher.close();
        record.entries.delete(name);
      }
      const watcher = fsWatch(real, { recursive: true }, (_ev, fname) => {
        if (fname) this.emitGlobalPath(root, normalizeRelPath(path.join(name, String(fname))));
      });
      // 真身目录被删/移走：句柄失效，摘掉交回 reconcile 重挂
      watcher.on('error', () => {
        watcher.close();
        record.entries.delete(name);
      });
      record.entries.set(name, { real, watcher });
    }
    for (const [name, entry] of record.entries) {
      if (live.has(name)) continue;
      entry.watcher.close();
      record.entries.delete(name);
    }
  }

  private unwatchGlobalRoot(root: string): void {
    const record = this.globalRoots.get(root);
    if (!record) return;
    record.root.close();
    for (const e of record.entries.values()) e.watcher.close();
    this.globalRoots.delete(root);
  }

  /** 根内相对路径 → 全局事件。Events carry the GLOBAL_SENTINEL projectPath so
   * App.tsx's project cache ignores them; the open skill drawer subscribes to its
   * own EventSource and re-fetches. agent 取该根的归属 harness（挂监听时记下，
   * 不解析路径段）；目录变动不产生文件事件（与旧实现只消费 add/change/unlink 同口径）。 */
  private emitGlobalPath(root: string, relPath: string): void {
    if (!relPath) return;
    // 任一段以 '.' 开头即不观测（旧谓词按 basename 逐条判，等价）
    if (relPath.split('/').some((seg) => seg.startsWith('.'))) return;
    const absPath = path.join(root, relPath);
    let kind: AssetChangeKind = 'unlink';
    try {
      if (!statSync(absPath).isFile()) return;
      kind = 'change';
    } catch {
      // 已消失 → unlink（保留初值）
    }
    this.enqueueGlobal({
      projectPath: GLOBAL_SENTINEL,
      projectName: 'global',
      category: 'skill',
      agent: this.globalRoots.get(root)?.harness ?? 'claude',
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
    let category = classifyAsset(relPath);
    if (kind !== 'unlink' && category === 'plugin') {
      category = pluginModsSniffer.refine(category, relPath, absPath);
    }
    const agent = classifyAgent(relPath);

    let isSymlink: boolean | undefined;
    if (kind === 'unlink') {
      this.cache.remove(projectPath, relPath);
    } else {
      try {
        // lstat first so symlinked files (e.g. the AGENTS.md -> CLAUDE.md
        // link weave creates) are flagged; the link's own mtime is NOT used —
        // target edits must keep bumping change events, so stat the target.
        const lst = lstatSync(absPath);
        isSymlink = lst.isSymbolicLink() || undefined;
        const mtimeMs = isSymlink ? statSync(absPath).mtimeMs : lst.mtimeMs;
        this.cache.upsert(projectPath, {
          absPath,
          relPath,
          category,
          agent,
          mtimeMs,
          ...(isSymlink ? { isSymlink: true } : {}),
        });
      } catch {
        // File vanished between event and stat — treat as removal.
        this.cache.remove(projectPath, relPath);
      }
    }

    this.enqueue(projectPath, {
      projectPath,
      projectName,
      category,
      agent,
      relPath,
      absPath,
      kind,
      ...(isSymlink ? { isSymlink: true } : {}),
    });
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
