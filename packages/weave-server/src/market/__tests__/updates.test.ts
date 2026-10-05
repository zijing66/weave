import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { importFromDir, importFromGit, type GitExec } from '../import.js';
import { checkMarketUpdates } from '../updates.js';
import { openDatabase } from '../../db/db.js';
import { LibraryRepository } from '../../repositories/libraries.js';
import type { DatabaseSync } from 'node:sqlite';

let dataDir: string;
let srcRoot: string;
let db: DatabaseSync;
let libs: LibraryRepository;
const tempDirs: string[] = [];

beforeAll(() => {
  srcRoot = mkdtempSync(path.join(tmpdir(), 'weave-mkt-upd-src-'));
});
afterAll(() => {
  rmSync(srcRoot, { recursive: true, force: true });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'weave-mkt-upd-'));
  tempDirs.push(dataDir);
  db = openDatabase(':memory:');
  libs = new LibraryRepository(db, dataDir);
});

async function importDir(name: string): Promise<{ id: number; dir: string; src: string }> {
  const src = path.join(srcRoot, name);
  mkdirSync(path.join(src, 'skills', `${name}-skill`), { recursive: true });
  writeFileSync(path.join(src, 'skills', `${name}-skill`, 'SKILL.md'), '# v1');
  const res = await importFromDir(src, { libraries: libs, dataDir });
  return { id: res.libraryId, dir: res.dir, src };
}

describe('checkMarketUpdates — dir 源', () => {
  it('内容一致 → uptodate；源改一字节 → update-available', async () => {
    const t = await importDir('d1');
    const [first] = await checkMarketUpdates([{ id: t.id, dir: t.dir }]);
    expect(first!.status).toBe('uptodate');

    writeFileSync(path.join(t.src, 'skills', 'd1-skill', 'SKILL.md'), '# v2');
    const [second] = await checkMarketUpdates([{ id: t.id, dir: t.dir }]);
    expect(second!.status).toBe('update-available');
    expect(second!.id).toBe(t.id);
    expect(second!.checkedAt).toBeTruthy();
  });

  it('origin 目录被删 → origin-missing（不炸批量）', async () => {
    const t = await importDir('d2');
    rmSync(t.src, { recursive: true, force: true });
    const [r] = await checkMarketUpdates([{ id: t.id, dir: t.dir }]);
    expect(r!.status).toBe('origin-missing');
  });

  it('无 manifest 的 legacy 目录 → unknown', async () => {
    const legacy = path.join(dataDir, 'legacy-lib');
    mkdirSync(legacy, { recursive: true });
    const row = libs.add({ path: legacy, kind: 'skill' });
    const [r] = await checkMarketUpdates([{ id: row.id, dir: row.path }]);
    expect(r!.status).toBe('unknown');
  });

  it('skipNames 生效：只改 .weave-market.json 不算更新', async () => {
    const t = await importDir('d3');
    // 清单文件在 origin 侧不存在、缓存侧必然不同——必须被跳过，否则恒有更新。
    // 注意保留 origin 字段（改掉会让 origin 校验先失败）。
    writeFileSync(
      path.join(t.dir, '.weave-market.json'),
      JSON.stringify({ source: 'dir', origin: t.src, importedAt: 'other-timestamp' }),
    );
    const [r] = await checkMarketUpdates([{ id: t.id, dir: t.dir }]);
    expect(r!.status).toBe('uptodate');
  });
});

describe('checkMarketUpdates — git 源（假 exec，不真联网）', () => {
  const url = 'https://github.com/acme/g1.git';

  async function importGit(): Promise<{ id: number; dir: string }> {
    const execGit: GitExec = async (_file, args) => {
      mkdirSync(args[4], { recursive: true });
      return { stdout: '', stderr: '' };
    };
    const r = await importFromGit(url, { libraries: libs, dataDir, execGit });
    return { id: r.libraryId, dir: r.dir };
  }

  it('execFile 参数数组断言：rev-parse 与 ls-remote；同 SHA → uptodate', async () => {
    const t = await importGit();
    const calls: { file: string; args: string[] }[] = [];
    const execGit: GitExec = async (file, args) => {
      calls.push({ file, args });
      if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '' };
      return { stdout: `abc123\tHEAD\n`, stderr: '' };
    };
    const [r] = await checkMarketUpdates([{ id: t.id, dir: t.dir }], { execGit });
    expect(r!.status).toBe('uptodate');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ file: 'git', args: ['-C', t.dir, 'rev-parse', 'HEAD'] });
    expect(calls[1]).toEqual({ file: 'git', args: ['ls-remote', url, 'HEAD'] });
  });

  it('远端 SHA 不同 → update-available', async () => {
    const t = await importGit();
    const execGit: GitExec = async (_file, args) =>
      args.includes('rev-parse')
        ? { stdout: 'aaa\n', stderr: '' }
        : { stdout: 'bbb\tHEAD\n', stderr: '' };
    const [r] = await checkMarketUpdates([{ id: t.id, dir: t.dir }], { execGit });
    expect(r!.status).toBe('update-available');
  });

  it('git 失败（网络不通）→ unknown，不抛错', async () => {
    const t = await importGit();
    const execGit: GitExec = async () => {
      throw new Error('git exited 128');
    };
    const [r] = await checkMarketUpdates([{ id: t.id, dir: t.dir }], { execGit });
    expect(r!.status).toBe('unknown');
  });
});
