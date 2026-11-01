import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db.js';

/** 损坏自愈 / 迁移备份：升级期最容易出岔子的两条路径。 */
describe('openDatabase 的自我保护', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-db-recovery-'));
    dbPath = join(dir, 'weave.db');
    // 这些用例故意走异常路径，控制台噪音不该淹没别的用例
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('新库建好即写入 user_version', () => {
    const db = openDatabase(dbPath);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    db.close();
  });

  it('版本落后才备份：首次升级生成一份，再打开不重复生成', () => {
    const db = openDatabase(dbPath);
    // 模拟「旧版本写的库」：版本退回 0
    db.exec('PRAGMA user_version = 0');
    db.close();

    const again = openDatabase(dbPath);
    again.close();
    const backups = readdirSync(join(dir, 'backups'));
    expect(backups.filter((n) => n.endsWith('.db'))).toHaveLength(1);
    expect((openDatabase(dbPath).prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);

    // 已经是最新版本：再打开不该再备份
    openDatabase(dbPath).close();
    expect(readdirSync(join(dir, 'backups')).filter((n) => n.endsWith('.db'))).toHaveLength(1);
  });

  it('备份只留最近 3 份', () => {
    const backupsDir = join(dir, 'backups');
    mkdirSync(backupsDir, { recursive: true });
    for (const stamp of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
      writeFileSync(join(backupsDir, `weave-v0-${stamp}.db`), 'x');
    }

    const db = openDatabase(dbPath);
    db.exec('PRAGMA user_version = 0');
    db.close();
    openDatabase(dbPath).close();

    expect(readdirSync(backupsDir).filter((n) => n.endsWith('.db'))).toHaveLength(3);
  });

  it('文件不是数据库：隔离到 .corrupt-* 后重建可用空库', () => {
    writeFileSync(dbPath, 'this is definitely not a sqlite database');

    const db = openDatabase(dbPath);
    // 隔离文件还在（不删用户数据），新库能正常建表
    const quarantined = readdirSync(dir).filter((n) => n.includes('.corrupt-'));
    expect(quarantined.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dir, quarantined[0]!))).toBe(true);
    expect((db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('schema 坏掉（malformed）：同样隔离重建', () => {
    const bad = new DatabaseSync(dbPath);
    bad.exec('CREATE TABLE keep(a INTEGER)');
    // 往 sqlite_master 塞一条无法解析的建表语句，重开时 SQLite 解析 schema 即失败。
    // node:sqlite 默认 defensive 模式会拦这种写，测试里显式关掉。
    bad.enableDefensive(false);
    bad.exec('PRAGMA writable_schema = ON');
    bad.exec(
      "INSERT INTO sqlite_master(type,name,tbl_name,rootpage,sql) VALUES('table','broken','broken',0,'CREATE TABLE broken(')",
    );
    bad.close();

    const db = openDatabase(dbPath);
    expect(readdirSync(dir).some((n) => n.includes('.corrupt-'))).toBe(true);
    expect((db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
    db.close();
  });
});
