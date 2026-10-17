import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { registerProject } from '../registry.js';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';

describe('registerProject', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-registry-'));
    dbPath = join(dir, 'test.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers a project and writes its token file', () => {
    const target = join(dir, 'project');
    mkdirSync(target, { recursive: true });

    const result = registerProject(target, 'init', dbPath);
    expect(result.token).toBeTruthy();
    expect(existsSync(join(target, '.weave', 'token'))).toBe(true);
    expect(readFileSync(join(target, '.weave', 'token'), 'utf-8').trim()).toBe(result.token);
  });

  it('is idempotent — re-registering preserves the original token', () => {
    const target = join(dir, 'project');
    mkdirSync(target, { recursive: true });

    const first = registerProject(target, 'init', dbPath);
    const second = registerProject(target, 'scan', dbPath);
    expect(second.token).toBe(first.token);
  });

  it('records the project source in the registry', () => {
    const target = join(dir, 'project');
    mkdirSync(target, { recursive: true });

    registerProject(target, 'init', dbPath);

    const db = openDatabase(dbPath);
    const projects = new ProjectRepository(db);
    expect(projects.getByPath(target)?.source).toBe('init');
    db.close();
  });

  it('同一目录的不同写法命中同一行——不重复登记、不换 token', () => {
    const target = join(dir, 'project');
    mkdirSync(target, { recursive: true });

    const first = registerProject(target, 'init', dbPath);
    // 正斜杠写法：Windows 下 `process.cwd()` 与 `--dir` 常给出两种拼法
    const slashy = target.split(sep).join('/');
    const second = registerProject(slashy, 'init', dbPath);
    const trailing = registerProject(target + sep, 'init', dbPath);

    expect(second.id).toBe(first.id);
    expect(second.token).toBe(first.token);
    expect(trailing.id).toBe(first.id);
    expect(trailing.token).toBe(first.token);

    const db = openDatabase(dbPath);
    expect(new ProjectRepository(db).list()).toHaveLength(1);
    db.close();
  });
});
