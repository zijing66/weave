import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { registerProject, unregisterProject } from '../registry.js';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { SessionRepository } from '../repositories/sessions.js';
import { SessionWatchRepository } from '../repositories/session-watches.js';
import { SideQuestionRepository } from '../repositories/side-questions.js';

describe('unregisterProject', () => {
  let dir: string;
  let dbPath: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-registry-'));
    dbPath = join(dir, 'test.db');
    target = join(dir, 'project');
    mkdirSync(target, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('注销把会话的附属行一并带走（订阅 / 旁路会话）', () => {
    const { id } = registerProject(target, 'init', dbPath);
    const db = openDatabase(dbPath);
    new SessionRepository(db).touch('sess-1', id);
    new SessionWatchRepository(db).insert({
      watcherSessionId: null,
      targetSessionId: 'sess-1',
      notify: null,
      onEvents: ['idle'],
      times: null,
    });
    new SideQuestionRepository(db).insert({ sessionId: 'sess-1', projectId: id, question: 'btw' });
    db.close();

    expect(unregisterProject(target, dbPath)).not.toBeNull();

    const after = openDatabase(dbPath);
    expect(new SessionRepository(after).list(id)).toHaveLength(0);
    expect(new SessionWatchRepository(after).listPending()).toHaveLength(0);
    expect(new SideQuestionRepository(after).list('sess-1', { limit: 10 })).toHaveLength(0);
    after.close();
  });
});

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

  it('打开存量库即把 path 折叠到注册键——旧写法仍查得中、不产生第二行', () => {
    const canonical = join(dir, 'legacy', 'proj');
    // 裸 SQL 写一行「未折叠」的 path，模拟升级前的存量数据
    let db = openDatabase(dbPath);
    db.prepare(
      'INSERT INTO projects (path, name, token, source, registered_at) VALUES (?, ?, ?, ?, ?)',
    ).run(canonical + sep, 'proj', 'legacy-token', 'init', new Date().toISOString());
    db.close();

    db = openDatabase(dbPath); // 重开触发 migrateProjectPaths
    const projects = new ProjectRepository(db);
    expect(projects.getByPath(canonical)?.token).toBe('legacy-token');
    expect(projects.getByPath(canonical + sep)?.token).toBe('legacy-token');
    expect(projects.getByPath(canonical)?.path).toBe(resolve(canonical));
    expect(projects.list()).toHaveLength(1);
    db.close();
  });
});
