import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MoveEngine, MoveValidationError } from '../move.js';
import { ProjectRepository, type ProjectRow } from '../../repositories/projects.js';
import { openDatabase } from '../../db/db.js';
import type { DatabaseSync } from 'node:sqlite';

/** 迁移引擎（复制语义）：validate 拒绝分支、复制完整性、取消清理、setPath 落定。 */
function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'weave-move-'));
}

function makeDb(): DatabaseSync {
  return openDatabase(':memory:');
}

function makeRepo(): { repo: ProjectRepository; row: ProjectRow; dir: string } {
  const dir = tmp();
  const repo = new ProjectRepository(makeDb());
  const row = repo.register({ path: dir, name: 'proj', token: 'tok', source: 'init' });
  return { repo, row, dir };
}

function engine(repo: ProjectRepository, over: Partial<ConstructorParameters<typeof MoveEngine>[0]> = {}): MoveEngine {
  return new MoveEngine({
    projects: repo,
    setPath: (id, p) => repo.setPath(id, p),
    ...over,
  });
}

afterAllCleanup();

const dirs: string[] = [];
function tmpTracked(): string {
  const d = tmp();
  dirs.push(d);
  return d;
}
function afterAllCleanup(): void {
  process.on('exit', () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
}

function seedProject(dir: string): void {
  mkdirSync(path.join(dir, '.weave'), { recursive: true });
  mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  writeFileSync(path.join(dir, '.weave', 'token'), 'tok-123\n', { mode: 0o600 });
  writeFileSync(path.join(dir, 'README.md'), 'hello');
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export {};');
  writeFileSync(path.join(dir, 'src', 'deep', 'b.ts'), 'export const b = 1;');
}

describe('MoveEngine validate', () => {
  it('目标 = 源 / 源的子目录 / 源的父目录 → MoveValidationError', async () => {
    const { repo, row, dir } = { ...makeRepo(), dir: tmpTracked() };
    void repo;
    const eng = engine(new ProjectRepository(makeDb()));
    const fakeRow = { ...row, path: dir } as ProjectRow;
    await expect(eng.run(fakeRow, dir)).rejects.toBeInstanceOf(MoveValidationError);
    await expect(eng.run(fakeRow, path.join(dir, 'sub'))).rejects.toBeInstanceOf(MoveValidationError);
    await expect(eng.run(fakeRow, path.dirname(dir))).rejects.toBeInstanceOf(MoveValidationError);
  });

  it('目标与既有项目嵌套 → 拒绝', async () => {
    const repo = new ProjectRepository(makeDb());
    const other = tmpTracked();
    const inner = path.join(other, 'nested-target');
    repo.register({ path: other, name: 'other', token: 't2', source: 'init' });
    const mine = tmpTracked();
    const row = repo.register({ path: mine, name: 'mine', token: 't3', source: 'init' });
    const eng = engine(repo);
    await expect(eng.run({ ...row, path: mine }, inner)).rejects.toThrow(/overlaps/);
    await expect(eng.run({ ...row, path: mine }, other)).rejects.toThrow(/registered/);
  });

  it('目标已存在且非空 → 拒绝；目标不存在 → 创建并迁移成功', async () => {
    const repo = new ProjectRepository(makeDb());
    const mine = tmpTracked();
    seedProject(mine);
    const row = repo.register({ path: mine, name: 'mine', token: 't3', source: 'init' });
    const eng = engine(repo);

    const full = tmpTracked();
    const fullTarget = path.join(full, 'occupied');
    mkdirSync(fullTarget);
    writeFileSync(path.join(fullTarget, 'x.txt'), 'x');
    await expect(eng.run({ ...row, path: mine }, fullTarget)).rejects.toThrow(/not empty/);

    const target = path.join(tmpTracked(), 'new-home', 'proj');
    await eng.run({ ...row, path: mine }, target);
    expect(repo.getById(row.id)?.path).toBe(path.resolve(target));
    expect(repo.getById(row.id)?.name).toBe('proj');
    expect(existsSync(path.join(target, '.weave', 'token'))).toBe(true);
    expect(existsSync(path.join(target, 'src', 'deep', 'b.ts'))).toBe(true);
  });
});

describe('MoveEngine copy + finalize', () => {
  it('token 文件内容与权限随迁；旧目录原样保留；progress 走完三段', async () => {
    const repo = new ProjectRepository(makeDb());
    const mine = tmpTracked();
    seedProject(mine);
    const row = repo.register({ path: mine, name: 'mine', token: 't3', source: 'init' });
    let reconciled = 0;
    const eng = engine(repo, {
      reconcile: () => reconciled++,
      emitProjects: () => reconciled += 10,
    });
    const target = path.join(tmpTracked(), 'moved');
    await eng.run({ ...row, path: mine }, target);

    expect(await import('node:fs/promises').then((m) => m.readFile(path.join(target, '.weave', 'token'), 'utf-8'))).toBe('tok-123\n');
    // POSIX 位；Windows ACL 语义不同，只验内容
    if (process.platform !== 'win32') {
      expect(statSync(path.join(target, '.weave', 'token')).mode & 0o777).toBe(0o600);
    }
    // 旧目录原样
    expect(existsSync(path.join(mine, 'README.md'))).toBe(true);
    expect(existsSync(path.join(mine, '.weave', 'token'))).toBe(true);
    // 状态面
    const st = eng.status;
    expect(st.running).toBe(false);
    expect(st.done).toBe(true);
    expect(st.lastError).toBeNull();
    expect(reconciled).toBe(11);
  });

  it('setPath 失败 → 清理半成品（createdTarget 整删），DB 未动', async () => {
    const repo = new ProjectRepository(makeDb());
    const mine = tmpTracked();
    seedProject(mine);
    const row = repo.register({ path: mine, name: 'mine', token: 't3', source: 'init' });
    const eng = new MoveEngine({
      projects: repo,
      setPath: () => undefined, // 模拟行消失
    });
    const target = path.join(tmpTracked(), 'half');
    await eng.run({ ...row, path: mine }, target);
    expect(eng.status.done).toBe(false);
    expect(eng.status.lastError).toContain('disappeared');
    expect(existsSync(target)).toBe(false);
    expect(repo.getById(row.id)?.path).toBe(path.resolve(mine));
  });

  it('目标是借用的空目录：取消后只清复制进去的条目，空目录归还', async () => {
    const repo = new ProjectRepository(makeDb());
    const mine = tmpTracked();
    seedProject(mine);
    const row = repo.register({ path: mine, name: 'mine', token: 't3', source: 'init' });
    const eng = engine(repo);
    const borrowed = path.join(tmpTracked(), 'borrowed');
    mkdirSync(borrowed);
    eng.requestCancel(); // 起跑前就取消：第一个文件回调即中断
    await eng.run({ ...row, path: mine }, borrowed);
    expect(eng.status.lastError).toBe('cancelled');
    expect(eng.status.done).toBe(false);
    // 目录还在（借用的不整删），里面的复制产物被清
    expect(existsSync(borrowed)).toBe(true);
    expect(readdirSync(borrowed)).toEqual([]);
    expect(repo.getById(row.id)?.path).toBe(path.resolve(mine));
  });

  it('runInit 失败 → initError 记账，迁移 done 不受影响', async () => {
    const repo = new ProjectRepository(makeDb());
    const mine = tmpTracked();
    seedProject(mine);
    const row = repo.register({ path: mine, name: 'mine', token: 't3', source: 'init' });
    const eng = engine(repo, { runInit: async () => { throw new Error('init boom'); } });
    const target = path.join(tmpTracked(), 'with-init');
    await eng.run({ ...row, path: mine }, target);
    expect(eng.status.done).toBe(true);
    expect(eng.status.initError).toBe('init boom');
  });
});
