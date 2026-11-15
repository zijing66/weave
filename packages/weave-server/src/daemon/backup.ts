import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import { getDataRoot, getUploadsDir } from '../db/paths.js';
import { SCHEMA_VERSION } from '../db/db.js';
import { marketDir } from '../market/manifest.js';
import { WEAVE_VERSION } from '../version.js';
import { defaultWorktreeGitExec, type WorktreeGitExec } from './worktree.js';

/**
 * 每日自动备份（配置面）：打包 = DB 白名单表（NDJSON）+ market 各仓的 git
 * 管理文件（`git ls-files`，未跟踪/被忽略的不进——保证干净仓）+ manifest。
 * 历史会话域（hook_events/sessions/side_questions/event_images + uploads 目录）
 * 勾了 includeHistory 才随包（气泡与图同进同退）。
 * 包落 `data/backups/weave-backup-<时刻>.tar.gz`，滚动保留 7 天。
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

    const backupsDir = path.join(dataRoot, 'backups');
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

/** 备份包文件名时刻戳（本地时刻 `YYYY-MM-DD-HHmmss`，与配置备份 id 同族）。 */
export function stampOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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
    const m = name.match(/^weave-backup-(\d{4}-\d{2}-\d{2}-\d{6})\.tar\.gz$/);
    if (!m) continue;
    const [, s] = m;
    const d = parseStamp(s);
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
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
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
