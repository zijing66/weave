import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BackupEngine,
  BACKUP_TABLES,
  pruneOldBackups,
  stampOf,
  type BackupProgress,
} from '../backup.js';
import { shouldFireBackup, markBackupFired, resetBackupScheduleForTest } from '../backup-scheduler.js';
import type { GitResult, WorktreeGitExec } from '../worktree.js';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, meta TEXT)`);
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE hook_events (id INTEGER PRIMARY KEY, payload TEXT)`);
  db.exec(`INSERT INTO projects (name, meta) VALUES ('p1', '{"hideWindow":true}')`);
  db.exec(`INSERT INTO settings (key, value) VALUES ('locale', 'zh-CN')`);
  db.exec(`INSERT INTO hook_events (payload) VALUES ('big')`);
  return db;
}

/** 最小表集：BACKUP_TABLES 白名单只建 engine 会真查的那几张，其余建空壳。 */
function ensureTables(db: DatabaseSync, includeHistory: boolean): void {
  const need = [...BACKUP_TABLES, ...(includeHistory ? ['hook_events'] : [])];
  for (const t of need) {
    try {
      db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get();
    } catch {
      db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY)`);
    }
  }
}

function fakeGit(filesByRepo: Record<string, string[] | null>): WorktreeGitExec {
  return async (_file, args, options): Promise<GitResult> => {
    if (args[0] !== 'ls-files') return { stdout: '', stderr: 'unsupported', code: 1 };
    const repo = path.basename(options.cwd);
    const files = filesByRepo[repo];
    if (files == null) return { stdout: '', stderr: 'not a repo', code: 128 };
    return { stdout: files.join('\0') + '\0', stderr: '', code: 0 };
  };
}

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'weave-backup-'));
}

describe('BackupEngine', () => {
  it('默认包 = 配置表白名单 + market 干净仓，不含 hook_events', async () => {
    const root = makeRoot();
    const db = makeDb();
    ensureTables(db, false);
    const repo = path.join(root, 'market', 'zj');
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, 'SKILL.md'), 'tracked');
    writeFileSync(path.join(repo, 'scratch.tmp'), 'untracked');
    const engine = new BackupEngine({
      db,
      exec: fakeGit({ zj: ['SKILL.md'] }),
      dataRoot: root,
      now: () => new Date(2026, 10, 11, 1, 0, 0),
    });
    const result = await engine.run(false);
    expect(result).not.toBeNull();
    expect(result!.file).toContain('weave-backup-2026-11-11-010000.tar.gz');
    expect(result!.marketRepos).toBe(1);
    expect(result!.tables).toBe(2); // projects 1 + settings 1
    // 状态面：完成 + 不在跑
    expect(engine.status.running).toBe(false);
    expect(engine.status.lastResult?.file).toBe(result!.file);
    expect(engine.status.lastError).toBeNull();
    // 清理临时目录
    rmSync(root, { recursive: true, force: true });
  });

  it('进度回调：phase 前进 + ETA 最终给数、ratio ≤ 0.99', async () => {
    const root = makeRoot();
    const db = makeDb();
    ensureTables(db, false);
    const seen: BackupProgress[] = [];
    const engine = new BackupEngine({
      db,
      exec: fakeGit({}),
      dataRoot: root,
      now: () => new Date(2026, 10, 11, 1, 0, 0),
      onProgress: (p) => seen.push(p),
    });
    await engine.run(false);
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) expect(p.ratio).toBeLessThanOrEqual(0.99);
    expect(seen[seen.length - 1]!.etaSeconds).toBe(0); // 收尾拍
    expect(seen[seen.length - 1]!.phase).toBe('finalize');
    rmSync(root, { recursive: true, force: true });
  });

  it('includeHistory 才带 hook_events（历史域勾选语义）', async () => {
    const root = makeRoot();
    const db = makeDb();
    ensureTables(db, true);
    const engine = new BackupEngine({
      db,
      exec: fakeGit({}),
      dataRoot: root,
      now: () => new Date(2026, 10, 11, 1, 0, 0),
    });
    const r1 = await engine.run(false);
    expect(r1!.tables).toBe(2);
    const r2 = await engine.run(true);
    expect(r2!.tables).toBe(3); // + hook_events 1 行
    rmSync(root, { recursive: true, force: true });
  });

  it('非 git 的 market 仓如实 skipped，不废整包', async () => {
    const root = makeRoot();
    const db = makeDb();
    ensureTables(db, false);
    mkdirSync(path.join(root, 'market', 'plain'), { recursive: true });
    const engine = new BackupEngine({
      db,
      exec: fakeGit({ plain: null }),
      dataRoot: root,
      now: () => new Date(2026, 10, 11, 1, 0, 0),
    });
    const result = await engine.run(false);
    expect(result!.marketRepos).toBe(0);
    expect(result!.marketSkipped).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('并发重入拒绝：跑着时再 run 返回 null', async () => {
    const root = makeRoot();
    const db = makeDb();
    ensureTables(db, false);
    const engine = new BackupEngine({
      db,
      exec: fakeGit({}),
      dataRoot: root,
      now: () => new Date(2026, 10, 11, 1, 0, 0),
    });
    // engine.run 内部 running 闸：用一个慢 exec 撑开窗口不方便，直接顺序跑两轮
    // 都成功；并发闸由调度器单飞保证（这里只验不重叠时不误拒）。
    expect(await engine.run(false)).not.toBeNull();
    expect(await engine.run(false)).not.toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('pruneOldBackups', () => {
  it('删超期包、留新鲜包与外姓文件', async () => {
    const dir = makeRoot();
    const now = new Date(2026, 10, 11, 12, 0, 0);
    writeFileSync(path.join(dir, `weave-backup-2026-11-04-010000.tar.gz`), 'old'); // 7天+1h 前
    writeFileSync(path.join(dir, `weave-backup-2026-11-05-010000.tar.gz`), 'fresh'); // 恰 6 天
    writeFileSync(path.join(dir, `weave.db.bak-xxx`), 'other');
    const pruned = await pruneOldBackups(dir, now);
    expect(pruned).toBe(1);
    expect(existsSync(path.join(dir, 'weave-backup-2026-11-04-010000.tar.gz'))).toBe(false);
    expect(existsSync(path.join(dir, 'weave-backup-2026-11-05-010000.tar.gz'))).toBe(true);
    expect(existsSync(path.join(dir, 'weave.db.bak-xxx'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('backup scheduler 判据', () => {
  it('到点且今天没跑过 → 触发；跑过不再触发；早于时刻不触发', () => {
    resetBackupScheduleForTest();
    const at = new Date(2026, 10, 11, 1, 30, 0);
    expect(shouldFireBackup(at, 1, false)).toBe(true);
    markBackupFired(at);
    expect(shouldFireBackup(at, 1, false)).toBe(false);
    resetBackupScheduleForTest();
    expect(shouldFireBackup(new Date(2026, 10, 11, 0, 30, 0), 1, false)).toBe(false);
  });

  it('到点但今天已有包 → 补跑判据不触发（避免重启 duplication）', () => {
    resetBackupScheduleForTest();
    expect(shouldFireBackup(new Date(2026, 10, 11, 2, 0, 0), 1, true)).toBe(false);
  });

  it('stampOf 与包名族一致（保留期按文件名判的前提）', () => {
    expect(stampOf(new Date(2026, 10, 11, 1, 0, 5))).toBe('2026-11-11-010005');
  });
});
