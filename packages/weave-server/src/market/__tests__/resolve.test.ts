import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isInsideDir, resolveLibraryPath, toRelPosix } from '../resolve.js';
import { openDatabase } from '../../db/db.js';
import { LibraryRepository } from '../../repositories/libraries.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'weave-market-resolve-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('resolveLibraryPath（R11 迁移边界）', () => {
  it('相对路径（posix 分隔符）→ join(dataDir, rel)', () => {
    const abs = resolveLibraryPath({ path: 'market/foo' }, dataDir);
    expect(abs).toBe(path.join(dataDir, 'market', 'foo'));
    expect(path.isAbsolute(abs)).toBe(true);
  });

  it('绝对且在 dataDir 内 → 返回解析值（调用方据此惰性改写）', () => {
    const abs = path.join(dataDir, 'market', 'legacy');
    expect(resolveLibraryPath({ path: abs }, dataDir)).toBe(abs);
    // 正斜杠旧写法也归一
    const fwd = abs.replace(/\\/g, '/');
    expect(resolveLibraryPath({ path: fwd }, dataDir)).toBe(abs);
  });

  it('绝对且在 dataDir 外 → 原样返回（legacy 外部源永不改写）', () => {
    const outside = path.join(tmpdir(), 'weave-external-lib');
    expect(resolveLibraryPath({ path: outside }, dataDir)).toBe(outside);
  });

  it('isInsideDir / toRelPosix 边界', () => {
    expect(isInsideDir(path.join(dataDir, 'a'), dataDir)).toBe(true);
    expect(isInsideDir(dataDir, dataDir)).toBe(true);
    expect(isInsideDir(path.join(dataDir, '..', 'escape'), dataDir)).toBe(false);
    expect(toRelPosix(path.join(dataDir, 'market', 'x'), dataDir)).toBe('market/x');
  });
});

describe('LibraryRepository 读侧 resolve（惰性改写）', () => {
  it('dataDir 内绝对路径：读一次后入库为相对 posix 形，返回仍是解析后的绝对路径', () => {
    const db = openDatabase(':memory:');
    const libs = new LibraryRepository(db, dataDir);
    const abs = path.join(dataDir, 'market', 'legacy-abs');
    mkdirSync(abs, { recursive: true });
    // 模拟 legacy 库直接写入的绝对路径（绕过 add 的写侧归一）
    db.prepare('INSERT INTO libraries (path, kind, added_at) VALUES (?, ?, ?)').run(
      abs,
      'skill',
      new Date().toISOString(),
    );

    const row = libs.list()[0];
    expect(row.path).toBe(abs); // 返回解析值
    const stored = db.prepare('SELECT path FROM libraries WHERE id = ?').get(row.id) as {
      path: string;
    };
    expect(stored.path).toBe('market/legacy-abs'); // 惰性 UPDATE 为相对 posix 形
    // 二次读取：相对形 → join 还原，幂等无再写
    expect(libs.getById(row.id)?.path).toBe(abs);
    expect(libs.list()).toHaveLength(1);
    db.close();
  });

  it('dataDir 外绝对路径：读取后存储形原样不动（外部源不迁移）', () => {
    const db = openDatabase(':memory:');
    const libs = new LibraryRepository(db, dataDir);
    const outside = path.join(tmpdir(), 'weave-external-row');
    db.prepare('INSERT INTO libraries (path, kind, added_at) VALUES (?, ?, ?)').run(
      outside,
      'skill',
      new Date().toISOString(),
    );
    expect(libs.list()[0].path).toBe(outside);
    const stored = db.prepare('SELECT path FROM libraries WHERE id = 1').get() as {
      path: string;
    };
    expect(stored.path).toBe(outside);
    db.close();
  });

  it('写侧幂等：绝对与相对两种写法指向同一行（data.test 幂等闸的迁移扩展）', () => {
    const db = openDatabase(':memory:');
    const libs = new LibraryRepository(db, dataDir);
    const abs = path.join(dataDir, 'market', 'dupe');
    libs.add({ path: abs, kind: 'skill' });
    libs.add({ path: 'market/dupe', kind: 'skill' });
    libs.add({ path: abs, kind: 'skill' });
    expect(libs.list()).toHaveLength(1);
    db.close();
  });

  it('dataDir 外路径 add 保持原行为（幂等按原始路径）', () => {
    const db = openDatabase(':memory:');
    const libs = new LibraryRepository(db, dataDir);
    const outside = path.join(tmpdir(), 'weave-external-add');
    libs.add({ path: outside, kind: 'skill' });
    libs.add({ path: outside, kind: 'skill' });
    expect(libs.list()).toHaveLength(1);
    expect(libs.getByPath(outside)?.path).toBe(outside);
    db.close();
  });
});
