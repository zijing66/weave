import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { getBackupsDir, getDataRoot, getUploadsDir, getTmpDir, getDbPath } from '../db/paths.js';
import { SCHEMA_VERSION, SCHEMA } from '../db/db.js';
import { marketDir } from '../market/manifest.js';
import { WEAVE_VERSION } from '../version.js';
import { defaultWorktreeGitExec, type WorktreeGitExec } from './worktree.js';

/**
 * 每日自动备份（配置面）：打包 = DB 白名单表（NDJSON）+ market 各仓的 git
 * 管理文件（`git ls-files`，未跟踪/被忽略的不进——保证干净仓）+ manifest。
 * 历史会话域（hook_events/sessions/side_questions/event_images + uploads 目录）
 * 勾了 includeHistory 才随包（气泡与图同进同退）。
 * 包落 `<cache>/backups/weave-backup-<时刻>.tar.gz`（getBackupsDir，可弃语义），滚动保留 7 天。
 *
 * 不新增依赖：tar 头手写（ustar），gzip 用 node:zlib 一次缓冲——默认包
 * （配置面 + market 干净仓）量级在几十 MB 内；includeHistory 的 DB 行与
 * uploads 图在收集阶段就是分条目缓冲，整包明文峰值 ≈ 包内容量。
 */

/** 备份保留天数（滚动删除更旧的包）。 */
export const BACKUP_RETENTION_DAYS = 7;

/** 默认随包的表（配置面：项目配置 + 已装清单 + RPG 运行态）。 */
export const BACKUP_TABLES = [
  'projects',
  'settings',
  'hook_rules',
  'plugin_states',
  'libraries',
  'orchestrations',
  'extension_bindings',
  'notify_channels',
  'session_watches',
  'peers',
  'rpg_roles',
  'rpg_teams',
  'rpg_growth',
  'rpg_hexagram',
  'rpg_scores',
  'rpg_achievements',
  'rpg_xp',
  'rpg_houses',
  'rpg_house_members',
  'rpg_expeditions',
  'rpg_crops',
  'rpg_merge_ladder',
  'rpg_invitations',
  'rpg_routing_decisions',
  'rpg_goals',
  'rpg_profile_versions',
] as const;

/** 历史会话域（includeHistory 才随包；uploads 目录与 event_images 同进同退）。 */
export const HISTORY_TABLES = [
  'hook_events',
  'sessions',
  'side_questions',
  'event_images',
] as const;

export interface BackupProgress {
  /** 当前阶段。 */
  phase: 'tables' | 'market' | 'uploads' | 'finalize';
  /** 0-1 总进度（按字节估）。 */
  ratio: number;
  /** 预计剩余秒数（前几拍样本不足为 null）。 */
  etaSeconds: number | null;
}

export interface BackupResult {
  file: string;
  bytes: number;
  durationMs: number;
  tables: number;
  marketRepos: number;
  marketSkipped: number;
}

/** 备份运行态（GET /backup/status 与全屏 loading 的数据源）。 */
export interface BackupStatus {
  running: boolean;
  startedAt: string | null;
  progress: BackupProgress | null;
  lastResult: BackupResult | null;
  lastError: string | null;
}

// --- tar（ustar）最小写侧 ---------------------------------------------------

interface TarEntry {
  name: string;
  data: Buffer;
  mtime: Date;
}

const TAR_BLOCK = 512;

function octal(value: number, len: number): string {
  return value.toString(8).padStart(len - 1, '0') + '\0';
}

/** ustar 头：超长路径按 name/prefix 拆（≤100/155）；拆不开截尾（包面不会出现）。 */
function tarHeader(entry: TarEntry): Buffer {
  const head = Buffer.alloc(TAR_BLOCK);
  let name = entry.name;
  let prefix = '';
  if (Buffer.byteLength(name, 'utf8') > 100) {
    const cut = name.length - 100;
    const slash = name.indexOf('/', Math.max(0, cut - 1));
    if (slash > 0 && slash <= 155) {
      prefix = name.slice(0, slash);
      name = name.slice(slash + 1);
    } else {
      name = name.slice(-100);
    }
  }
  head.write(name, 0, 100, 'utf8');
  head.write(octal(0o644, 8), 100);
  head.write(octal(0, 8), 108);
  head.write(octal(0, 8), 116);
  head.write(octal(entry.data.length, 12), 124);
  head.write(octal(Math.floor(entry.mtime.getTime() / 1000), 12), 136);
  head.write('0', 156);
  head.write('ustar\0', 257);
  head.write('00', 263);
  head.write(prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of head) checksum += byte;
  head.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return head;
}

/** 打包全部条目为 gzip（一次缓冲；收集完才调用，峰值 = 包明文量）。 */
function tarGzip(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry), entry.data);
    const pad = TAR_BLOCK - (entry.data.length % TAR_BLOCK);
    if (pad < TAR_BLOCK) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

export interface BackupManifest {
  kind: string;
  version: string;
  schemaVersion: number;
  createdAt: string;
  includeHistory: boolean;
  tables: Record<string, number>;
  market: { repos: number; skipped: number };
}

/** ustar 最小读侧（gunzip + 逐头解析）：还原面只取包内条目，零新依赖。 */
export function untarEntries(buf: Buffer): TarEntry[] {
  const raw = gunzipSync(buf);
  const out: TarEntry[] = [];
  for (let off = 0; off + TAR_BLOCK <= raw.length; ) {
    const name = raw.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    const prefix = raw.toString('utf8', off + 345, off + 500).replace(/\0.*$/, '');
    if (name.length === 0) break;
    const size = parseInt(raw.toString('utf8', off + 124, off + 136).replace(/[\0 ]/g, ''), 8) || 0;
    off += TAR_BLOCK;
    if (size > 0) {
      out.push({ name: prefix ? `${prefix}/${name}` : name, data: raw.subarray(off, off + size), mtime: new Date() });
      const pad = TAR_BLOCK - (size % TAR_BLOCK);
      off += size + (pad < TAR_BLOCK ? pad : 0);
    }
  }
  return out;
}

// --- 进度估算 ----------------------------------------------------------------

/**
 * 字节权重进度表：总字节先按各阶段体量预丈量（表行数×均行宽 + market 仓
 * HEAD 树大小 + uploads 目录和），收集时按已收字节推进；ETA 用滑动窗口
 * 速率外推，样本 <2 拍为 null。**只求量级正确**（全屏 loading 显示「约剩
 * N 秒」），不做精确计量。
 */
class ProgressEstimator {
  private totalBytes = 1;
  private doneBytes = 0;
  private readonly samples: Array<{ at: number; done: number }> = [];

  constructor(
    private readonly onProgress: (p: BackupProgress) => void,
    private readonly phase: BackupProgress['phase'] = 'tables',
  ) {}

  planTotal(bytes: number): void {
    this.totalBytes = Math.max(1, bytes);
  }

  add(bytes: number): void {
    this.doneBytes += bytes;
    const now = Date.now();
    this.samples.push({ at: now, done: this.doneBytes });
    if (this.samples.length > 20) this.samples.shift();
    const ratio = Math.min(0.99, this.doneBytes / this.totalBytes);
    let etaSeconds: number | null = null;
    if (this.samples.length >= 2) {
      const first = this.samples[0]!;
      const rate = (this.doneBytes - first.done) / Math.max(1, now - first.at); // bytes/ms
      if (rate > 0) etaSeconds = Math.round(((this.totalBytes - this.doneBytes) / rate) / 1000);
    }
    this.onProgress({ phase: this.phase, ratio, etaSeconds });
  }
}

// --- 引擎 --------------------------------------------------------------------

export interface BackupDeps {
  db: DatabaseSync;
  /** git 调用缝（测试注入）；缺省与 worktree 同一默认实现。 */
  exec?: WorktreeGitExec;
  /** 数据根覆盖（测试）；缺省 getDataRoot()。 */
  dataRoot?: string;
  now?: () => Date;
  /** 进度回调（引擎在阶段推进与字节进账时调用）。 */
  onProgress?: (p: BackupProgress) => void;
}

export class BackupEngine {
  private running = false;
  private startedAt: string | null = null;
  private progress: BackupProgress | null = null;
  private lastResult: BackupResult | null = null;
  private lastError: string | null = null;
  private readonly exec: WorktreeGitExec;
  private readonly now: () => Date;

  constructor(private readonly deps: BackupDeps) {
    this.exec = deps.exec ?? defaultWorktreeGitExec;
    this.now = deps.now ?? (() => new Date());
  }

  get status(): BackupStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      progress: this.progress,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
  }

  /** 跑一轮备份；并发重入直接拒绝（返回 null，调度器不会重叠触发）。 */
  async run(includeHistory: boolean): Promise<BackupResult | null> {
    if (this.running) return null;
    this.running = true;
    this.lastError = null;
    this.startedAt = this.now().toISOString();
    try {
      const result = await this.pack(includeHistory);
      this.lastResult = result;
      return result;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      this.running = false;
      this.progress = null;
    }
  }

  /** 读包的 manifest（无效包返回 null——还原前先验，不盲覆）。 */
  async readManifest(file: string): Promise<BackupManifest | null> {
    try {
      const buf = await readFile(file);
      for (const entry of untarEntries(buf)) {
        if (entry.name === 'manifest.json') {
          const m = JSON.parse(entry.data.toString('utf8')) as BackupManifest;
          return m.kind === 'weave-backup' ? m : null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private report(p: BackupProgress): void {
    this.progress = p;
    this.deps.onProgress?.(p);
  }

  private async pack(includeHistory: boolean): Promise<BackupResult> {
    const started = Date.now();
    const dataRoot = this.deps.dataRoot ?? getDataRoot();
    const tables = includeHistory ? [...BACKUP_TABLES, ...HISTORY_TABLES] : [...BACKUP_TABLES];
    const entries: TarEntry[] = [];
    const mtime = this.now();

    // ① 丈量总量（表行数×均宽 + market 仓大小 + uploads 和）——只求量级
    const estimator = new ProgressEstimator((p) => this.report(p));
    let planned = 0;
    for (const table of tables) {
      if (tableExists(this.deps.db, table)) planned += rowBytesOf(this.deps.db, table);
    }
    const marketRepos = await listMarketRepos(dataRoot);
    for (const repo of marketRepos) planned += await dirBytes(repo.dir);
    if (includeHistory) planned += await dirBytes(getUploadsDir(dataRoot));
    estimator.planTotal(planned);

    // ② DB 表 → NDJSON 条目（表不存在=旧库未建，如实缺席不废整包——manifest 不记它）
    let tableRows = 0;
    for (const table of tables) {
      if (!tableExists(this.deps.db, table)) continue;
      const rows = this.deps.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      const ndjson = rows.map((r) => JSON.stringify(r)).join('\n');
      if (ndjson.length > 0) entries.push({ name: `db/${table}.ndjson`, data: Buffer.from(ndjson, 'utf8'), mtime });
      tableRows += rows.length;
      estimator.add(rowBytesOf(this.deps.db, table));
    }

    // ③ market 仓：只收 git 管理的文件（`git ls-files`；非 git 仓如实记 skipped）
    let marketCount = 0;
    let marketSkipped = 0;
    for (const repo of marketRepos) {
      const files = await gitTrackedFiles(repo.dir, this.exec);
      if (files == null) {
        marketSkipped++;
        continue;
      }
      marketCount++;
      for (const rel of files) {
        try {
          const data = await readFile(path.join(repo.dir, rel));
          entries.push({ name: `market/${repo.id}/${rel.replaceAll('\\', '/')}`, data, mtime });
          estimator.add(data.length);
        } catch {
          // ls-files 给了但读不到（rm 后未 commit）：跳过单文件，不废整包
        }
      }
    }

    // ④ uploads（includeHistory 才有；与气泡同进同退）
    if (includeHistory) {
      const uploadsDir = getUploadsDir(dataRoot);
      let files: string[] = [];
      try {
        files = await readdir(uploadsDir);
      } catch {
        // 目录还没有 = 没传过图
      }
      for (const name of files) {
        try {
          const data = await readFile(path.join(uploadsDir, name));
          entries.push({ name: `uploads/${name}`, data, mtime });
          estimator.add(data.length);
        } catch {
          // 读不到跳过
        }
      }
    }

    // ⑤ manifest + 收尾
    this.report({ phase: 'finalize', ratio: 0.99, etaSeconds: 0 });
    const manifest = {
      kind: 'weave-backup',
      version: WEAVE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      createdAt: mtime.toISOString(),
      includeHistory,
      tables: Object.fromEntries(
        tables.filter((t) => tableExists(this.deps.db, t)).map((t) => [t, countRows(this.deps.db, t)]),
      ),
      market: { repos: marketCount, skipped: marketSkipped },
    };
    entries.push({
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      mtime,
    });

    // 无参 = 全局 cache 根（<configDir>/weave/cache/backups）——传 dataRoot 会
    // 再拼一层落 <data>/cache/backups，与包清单的读取目录（getBackupsDir()）错开。
    const backupsDir = getBackupsDir();
    await mkdir(backupsDir, { recursive: true });
    const stamp = stampOf(mtime);
    const file = path.join(backupsDir, `weave-backup-${stamp}.tar.gz`);
    await writeFile(file, tarGzip(entries));
    const bytes = (await stat(file)).size;
    await pruneOldBackups(backupsDir, this.now());
    return {
      file,
      bytes,
      durationMs: Date.now() - started,
      tables: tableRows,
      marketRepos: marketCount,
      marketSkipped,
    };
  }
}

// --- 辅助 --------------------------------------------------------------------

/**
 * 备份包文件名时刻戳：本地时刻 `YYYY-MM-DD-HH-MM-SS`（全连字符分段，ISO 风、
 * 段位自明——旧无连字符的 HHmmss 尾段要靠位置数）。包名正则（prune/清单/前端
 * 标签）都吃这个形；旧形包在保留期内仍被 prune 的双形正则认到、过期自然滚掉。
 */
export function stampOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** 表总字节估算（dbstat 精确值代价高，配置面量级用 COUNT×均宽足够）。 */
function rowBytesOf(db: DatabaseSync, table: string): number {
  const n = countRows(db, table);
  return n * 256; // 均行宽经验值（config 行多在 100B~1KB）
}

function countRows(db: DatabaseSync, table: string): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return r?.n ?? 0;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const r = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name?: string } | undefined;
  return r?.name === table;
}

interface MarketRepo {
  id: string;
  dir: string;
}

/** market 根下的仓目录（一层；`.weave-scans` 等点开头的工作目录跳过）。 */
async function listMarketRepos(dataRoot: string): Promise<MarketRepo[]> {
  const root = marketDir(dataRoot);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.'))
    .map((id) => ({ id, dir: path.join(root, id) }));
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let list: import('node:fs').Dirent[] = [];
  try {
    list = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(p);
    else {
      try {
        total += (await stat(p)).size;
      } catch {
        // 读不到不计
      }
    }
  }
  return total;
}

/** 滚动保留：删除超过保留期的旧备份包（按文件名时刻戳判，不靠 mtime）。 */
export async function pruneOldBackups(backupsDir: string, now: Date): Promise<number> {
  let names: string[] = [];
  try {
    names = await readdir(backupsDir);
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - BACKUP_RETENTION_DAYS * 86400_000;
  let pruned = 0;
  for (const name of names) {
    // 双形兼容：现行 `...-HH-MM-SS` 与旧 `...-HHmmss`（改形前的存量包，期内认到、过期自然滚掉）
    const m = name.match(/^weave-backup-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}-\d{6})\.tar\.gz$/);
    if (!m) continue;
    const d = parseStamp(m[1]!);
    if (d && d.getTime() < cutoff) {
      try {
        await (await import('node:fs/promises')).rm(path.join(backupsDir, name));
        pruned++;
      } catch {
        // 删不掉下次再来
      }
    }
  }
  return pruned;
}

function parseStamp(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-?(\d{2})-?(\d{2})$/);
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}

/** market 仓的 git 管理文件清单；仓不在 git 下返回 null（文件不进包）。 */
async function gitTrackedFiles(repo: string, exec: WorktreeGitExec): Promise<string[] | null> {
  const r = await exec('git', ['ls-files', '-z'], { cwd: repo });
  if (r.code !== 0) return null;
  return r.stdout.split('\0').filter((s) => s.length > 0);
}

// --- 还原（pending 文件 + 启动闸）---------------------------------------------
//
// 活 daemon 开着 weave.db（Windows 文件锁），不能原地覆写——还原面走「先约后办」：
// 路由校验 + 安全备份 + 落 pending 文件 → 触发优雅停机（WAL 并回）；下一次启动
// 在 openDatabase 之前吞掉 pending（applyPendingRestore），换上包里的库再开。

/** pending 文件落 `<cache>/tmp/restore-pending.json`。 */
function pendingRestorePath(): string {
  return path.join(getTmpDir(), 'restore-pending.json');
}

export interface PendingRestore {
  file: string;
  at: string;
}

/** 落待还原单（启动闸读它）；写不进 = 还原约不上，路由层要如实报错。 */
export async function writePendingRestore(pending: PendingRestore): Promise<void> {
  const file = pendingRestorePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(pending), 'utf8');
}

export function readPendingRestore(): PendingRestore | null {
  try {
    const p = JSON.parse(readFileSync(pendingRestorePath(), 'utf8')) as PendingRestore;
    return typeof p.file === 'string' && path.isAbsolute(p.file) ? p : null;
  } catch {
    return null; // 本就不在 / 半截文件 = 没有还原约单
  }
}

export function clearPendingRestore(): void {
  try {
    rmSync(pendingRestorePath());
  } catch {
    /* 本就不在 */
  }
}

/**
 * 启动闸（openDatabase 之前调用）：有 pending 就解包覆写——weave.db（含 -wal/-shm
 * 先摘掉）、market/（整目录换）、uploads/（includeHistory 才有，缺目录即跳过）。
 * 原库改名 `.pre-restore-<时刻>` 留档不删；失败时 pending 清掉、异常上抛（daemon
 * 起不来比带着旧库静默继续诚实）。返回 true = 应用了一次还原（调用方打启动日志）。
 */
export function applyPendingRestore(): boolean {
  const pending = readPendingRestore();
  if (!pending) return false;
  try {
    const buf = readFileSync(pending.file);
    const entries = untarEntries(buf);
    const byPrefix = (prefix: string): TarEntry[] => entries.filter((e) => e.name.startsWith(prefix));
    const dataRoot = getDataRoot();
    const dbPath = getDbPath();

    // 活库让位：改名留档（-wal/-shm 一并摘——它们属于旧库的半截事务）
    const keep = `${dbPath}.pre-restore-${stampOf(new Date())}`;
    renameSync(dbPath, keep);
    for (const suffix of ['-wal', '-shm']) {
      try {
        rmSync(dbPath + suffix);
      } catch {
        /* 本就不在 */
      }
    }

    // DB 表 → 新库：建库 + 逐表回灌（NDJSON 一行一 row；建表走真 SCHEMA 才有索引）
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(SCHEMA);
      for (const entry of byPrefix('db/')) {
        const table = path.basename(entry.name, '.ndjson');
        if (!/^[a-z_]+$/.test(table)) continue; // 包内表名白名单形
        const rows = entry.data.toString('utf8').split('\n').filter((s) => s.length > 0);
        for (const line of rows) {
          const row = JSON.parse(line) as Record<string, unknown>;
          const cols = Object.keys(row);
          db.prepare(
            `INSERT OR REPLACE INTO ${table} (${cols.map((c) => `"${c}"`).join(',')})
             VALUES (${cols.map(() => '?').join(',')})`,
          ).run(...cols.map((c) => row[c] as import('node:sqlite').SQLInputValue));
        }
      }
    } finally {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    }

    // market/：整目录换（先搬走旧的再解新）
    const marketRoot = marketDir(dataRoot);
    try {
      renameSync(marketRoot, `${marketRoot}.pre-restore`);
    } catch {
      /* 本就没有 */
    }
    for (const entry of byPrefix('market/')) {
      const rel = entry.name.slice('market/'.length);
      const file = path.join(marketRoot, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, entry.data);
    }

    // uploads/：同样整目录换；包里没有（includeHistory 没勾）就不动现目录
    const uploadsRoot = getUploadsDir(dataRoot);
    const uploadEntries = byPrefix('uploads/');
    if (uploadEntries.length > 0) {
      try {
        renameSync(uploadsRoot, `${uploadsRoot}.pre-restore`);
      } catch {
        /* 本就没有 */
      }
      for (const entry of uploadEntries) {
        const file = path.join(uploadsRoot, entry.name.slice('uploads/'.length));
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, entry.data);
      }
    }
    return true;
  } finally {
    clearPendingRestore();
  }
}
