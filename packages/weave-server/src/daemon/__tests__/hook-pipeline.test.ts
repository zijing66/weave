import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { hookShardId } from '../../hooks/mirror.js';
import { purgeOrphanPipelineFiles, purgeProjectPipeline } from '../hook-pipeline.js';

const LIVE = 'tok-live';
const GONE = 'tok-gone';

describe('管道文件回收', () => {
  let db: DatabaseSync;
  let projects: ProjectRepository;
  let hooksDir: string;

  const shard = (t: string) => hookShardId(t);
  const allForms = (sh: string) => [
    path.join(hooksDir, 'inbox', `${sh}.jsonl`),
    path.join(hooksDir, 'inbox', `${sh}.claim.jsonl`),
    path.join(hooksDir, 'inbox', `${sh}.failed.jsonl`),
    path.join(hooksDir, 'mirror', `${sh}.json`),
    path.join(hooksDir, 'outbox', `${sh}.jsonl`),
  ];
  const write = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'x\n');
  };

  beforeEach(async () => {
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    projects.register({ path: '/live', name: 'live', token: LIVE, source: 'init' });
    hooksDir = await mkdtemp(path.join(tmpdir(), 'weave-purge-'));
  });

  afterEach(async () => {
    db.close();
    await rm(hooksDir, { recursive: true, force: true });
  });

  it('孤儿 shard 的五种文件形态全清，已注册项目的一个不动', () => {
    for (const f of allForms(shard(LIVE))) write(f);
    const orphans = allForms(shard(GONE));
    for (const f of orphans) write(f);
    write(path.join(hooksDir, 'mirror', `${shard(GONE)}.json.tmp`)); // 原子重写中间产物

    const removed = purgeOrphanPipelineFiles({ projects, hooksDir });
    expect(removed).toBe(6);
    for (const f of orphans) expect(existsSync(f)).toBe(false);
    expect(existsSync(path.join(hooksDir, 'mirror', `${shard(GONE)}.json.tmp`))).toBe(false);
    for (const f of allForms(shard(LIVE))) expect(existsSync(f)).toBe(true);
  });

  it('不误删目录里的其他文件；目录不存在也不抛', () => {
    write(path.join(hooksDir, 'mirror', 'notes.txt'));
    write(path.join(hooksDir, 'mirror', 'README.md'));
    expect(purgeOrphanPipelineFiles({ projects, hooksDir })).toBe(0);
    expect(existsSync(path.join(hooksDir, 'mirror', 'notes.txt'))).toBe(true);

    const empty = path.join(hooksDir, 'no-such-dir');
    expect(purgeOrphanPipelineFiles({ projects, hooksDir: empty })).toBe(0);
  });

  it('purgeProjectPipeline(token)：只清该项目的文件（删项目路由可一行调用）', () => {
    const mine = allForms(shard(LIVE));
    const other = allForms(shard(GONE));
    for (const f of [...mine, ...other]) write(f);

    purgeProjectPipeline(hooksDir, LIVE);
    for (const f of mine) expect(existsSync(f)).toBe(false);
    for (const f of other) expect(existsSync(f)).toBe(true);
  });
});
