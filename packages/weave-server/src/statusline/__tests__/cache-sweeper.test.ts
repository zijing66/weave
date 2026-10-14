import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FILE_STALE_MS,
  LEGACY_STALE_MS,
  StatuslineCacheSweeper,
  TMP_STALE_MS,
} from '../cache-sweeper.js';

describe('StatuslineCacheSweeper', () => {
  let dir = '';
  let tmp = '';
  const now = Date.now();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-slc-dir-'));
    tmp = mkdtempSync(join(tmpdir(), 'weave-slc-tmp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  const sweeper = (): StatuslineCacheSweeper => new StatuslineCacheSweeper(dir, tmp, () => now);
  const age = (file: string, ms: number): void => {
    const t = new Date(now - ms);
    utimesSync(file, t, t);
  };

  it('过期的 git 条目被剔除，条目清空的文件整体删除，未过期的原样保留', () => {
    const live = join(dir, 'live.json');
    writeFileSync(
      live,
      JSON.stringify({
        git: { 'git_user:/p': { expires: now + 3600_000, value: { user: 'u' } } },
      }),
    );
    const dead = join(dir, 'dead.json');
    writeFileSync(dead, JSON.stringify({ git: { 'changes:/p': { expires: now - 1, value: null } } }));

    expect(sweeper().sweep()).toBe(1);
    expect(existsSync(dead)).toBe(false);
    const kept = JSON.parse(readFileSync(live, 'utf8')) as { git: Record<string, unknown> };
    expect(Object.keys(kept.git)).toEqual(['git_user:/p']);
  });

  it('转录已消失的 tokens 条目剔除（增量状态作废），混在活条目里的文件被改写而非删除', () => {
    const file = join(dir, 'mixed.json');
    writeFileSync(
      file,
      JSON.stringify({
        git: { 'git_user:/p': { expires: now + 3600_000, value: { user: 'u' } } },
        tokens: { [join(dir, 'gone.jsonl')]: { offset: 10, total: 5, ids: ['a'] } },
      }),
    );
    expect(sweeper().sweep()).toBe(0);
    const data = JSON.parse(readFileSync(file, 'utf8')) as { tokens: Record<string, unknown> };
    expect(data.tokens).toEqual({});
    expect(existsSync(file)).toBe(true);
  });

  it('转录还在（未超一天）的 tokens 条目保留', () => {
    const transcript = join(dir, 'alive.jsonl');
    writeFileSync(transcript, '{}\n');
    const file = join(dir, 's.json');
    writeFileSync(file, JSON.stringify({ tokens: { [transcript]: { offset: 3, total: 7, ids: [] } } }));
    expect(sweeper().sweep()).toBe(0);
    const data = JSON.parse(readFileSync(file, 'utf8')) as { tokens: Record<string, unknown> };
    expect(Object.keys(data.tokens)).toEqual([transcript]);
  });

  it('陈旧文件（一天没写过）直接删，不管内容；写盘孤儿 .tmp 超时回收', () => {
    const stale = join(dir, 'stale.json');
    writeFileSync(stale, JSON.stringify({ tokens: {} }));
    age(stale, FILE_STALE_MS + 1);
    const orphan = join(dir, 'x.json.4242.tmp');
    writeFileSync(orphan, '{}');
    age(orphan, TMP_STALE_MS + 1);

    expect(sweeper().sweep()).toBe(2);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
  });

  it('损坏的缓存文件直接删', () => {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{not json');
    expect(sweeper().sweep()).toBe(1);
    expect(existsSync(broken)).toBe(false);
  });

  it('旧版散在系统临时目录的缓存（超一小时没动）回收，新鲜的不动', () => {
    const oldSl = join(tmp, 'weave-sl-abc.json');
    const oldSlc = join(tmp, 'weave-slc-def.json');
    const freshLegacy = join(tmp, 'weave-slc-fresh.json');
    writeFileSync(oldSl, '{}');
    writeFileSync(oldSlc, '{}');
    writeFileSync(freshLegacy, '{}');
    age(oldSl, LEGACY_STALE_MS + 1);
    age(oldSlc, LEGACY_STALE_MS + 1);

    expect(sweeper().sweep()).toBe(2);
    expect(existsSync(oldSl)).toBe(false);
    expect(existsSync(oldSlc)).toBe(false);
    expect(existsSync(freshLegacy)).toBe(true);
  });

  it('目录不存在时 sweep 安静返回 0（幂等，可反复调用）', () => {
    const missing = new StatuslineCacheSweeper(join(dir, 'nope'), join(tmp, 'nope'), () => now);
    expect(missing.sweep()).toBe(0);
    expect(missing.sweep()).toBe(0);
  });
});
