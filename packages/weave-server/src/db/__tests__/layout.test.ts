import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dataRoots } from '../paths.js';
import { liveDaemonPid, migrateDataLayout } from '../layout.js';

/** 旧版顶层散放 → 三档（data / local / cache）搬迁：只 rename、幂等、有活 daemon 就整个不动。 */

let root: string;

const touch = (p: string, body = 'x'): void => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'weave-layout-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('migrateDataLayout', () => {
  it('① 各归各档：实体数据 / 本机身份 / 可弃产物，库文件一族按前缀认', () => {
    touch(path.join(root, 'market', 'weave', 'plugins', 'p.json'));
    touch(path.join(root, 'uploads', 'a.png'));
    touch(path.join(root, 'plugins', 'installed', 'x.js'));
    touch(path.join(root, 'weave.db'));
    touch(path.join(root, 'weave.db-wal'));
    touch(path.join(root, 'weave.db.bak-2026'));
    touch(path.join(root, 'auth.json'));
    touch(path.join(root, 'certs', 'cert.pem'));
    touch(path.join(root, 'weave-autostart.vbs'));
    touch(path.join(root, 'logs', 'api', 'a.jsonl'));
    touch(path.join(root, 'tmp', 'install-1'));
    touch(path.join(root, 'daemon.json'), JSON.stringify({ pid: 999_999_999 }));

    const r = migrateDataLayout(root);
    const roots = dataRoots(root);

    expect(r.busyPid).toBeNull();
    expect(r.moved.sort()).toEqual(
      [
        'auth.json',
        'certs',
        'daemon.json',
        'logs',
        'market',
        'plugins',
        'tmp',
        'uploads',
        'weave-autostart.vbs',
        'weave.db',
        'weave.db-wal',
        'weave.db.bak-2026',
      ].sort(),
    );
    expect(readdirSync(roots.data).sort()).toEqual([
      'market',
      'plugins',
      'uploads',
      'weave.db',
      'weave.db-wal',
      'weave.db.bak-2026',
    ]);
    expect(existsSync(path.join(roots.local, 'certs', 'cert.pem'))).toBe(true);
    expect(existsSync(path.join(roots.cache, 'logs', 'api', 'a.jsonl'))).toBe(true);
    // 顶层只剩三档（外加 hooks/statusline 两条链接由下一个用例覆盖）
    expect(readdirSync(root).sort()).toEqual(['cache', 'data', 'local']);
  });

  it('② 幂等：搬完再调一次什么都不动', () => {
    touch(path.join(root, 'market', 'x.json'));
    touch(path.join(root, 'auth.json'));
    migrateDataLayout(root);

    const again = migrateDataLayout(root);
    expect(again).toEqual({ moved: [], kept: [], bridged: [], busyPid: null });
  });

  it('③ 目标已存在（脚本又往老位置写了）→ 不搬、旧的留着供人核对', () => {
    touch(path.join(root, 'market', 'old.json'));
    touch(path.join(dataRoots(root).data, 'market', 'new.json'));

    const r = migrateDataLayout(root);
    expect(r.moved).toEqual([]);
    expect(r.kept).toEqual(['market']);
    expect(existsSync(path.join(root, 'market', 'old.json'))).toBe(true);
    expect(existsSync(path.join(dataRoots(root).data, 'market', 'new.json'))).toBe(true);
  });

  it('④ 有活着的 daemon 占着数据目录 → 一个都不搬（搬走库会把它拆散）', () => {
    touch(path.join(root, 'market', 'x.json'));
    touch(path.join(root, 'daemon.json'), JSON.stringify({ pid: process.pid }));

    expect(liveDaemonPid(root)).toBe(process.pid);
    const r = migrateDataLayout(root);
    expect(r).toEqual({ moved: [], kept: [], bridged: [], busyPid: process.pid });
    expect(existsSync(path.join(root, 'market', 'x.json'))).toBe(true);
  });

  it('⑤ 旧位置留目录链接：存量采集脚本照旧往那儿写，实际落进 cache/', () => {
    touch(path.join(root, 'hooks', 'inbox', 'abc.jsonl'), '{"e":1}\n');
    touch(path.join(root, 'statusline', 'render.json'), '{}');

    const r = migrateDataLayout(root);
    expect(r.bridged.sort()).toEqual(['hooks', 'statusline']);
    const link = path.join(root, 'hooks');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // 老路径写进去的那份就在新位置读得到
    expect(readFileSync(path.join(link, 'inbox', 'abc.jsonl'), 'utf8')).toBe('{"e":1}\n');
    expect(readFileSync(path.join(dataRoots(root).cache, 'hooks', 'inbox', 'abc.jsonl'), 'utf8')).toBe(
      '{"e":1}\n',
    );
  });

  it('⑥ 搬完老位置又长出同名目录 → 合并进去（不覆盖同名文件、清空空壳）', () => {
    touch(path.join(root, 'hooks', 'inbox', 'old.jsonl'), 'old');
    migrateDataLayout(root);

    // 存量脚本不认链接被换掉之前的窗口：新目录 + 一份新分片
    const cacheHooks = path.join(dataRoots(root).cache, 'hooks');
    rmSync(path.join(root, 'hooks'), { force: true, recursive: true });
    touch(path.join(cacheHooks, 'inbox', 'new.jsonl'), 'new');
    touch(path.join(root, 'hooks', 'inbox', 'new.jsonl'), 'should-not-overwrite');
    touch(path.join(root, 'hooks', 'inbox', 'fresh.jsonl'), 'fresh');

    const r = migrateDataLayout(root);
    expect(r.moved).toEqual(['hooks']);
    expect(r.bridged).toEqual(['hooks']);
    expect(readFileSync(path.join(cacheHooks, 'inbox', 'new.jsonl'), 'utf8')).toBe('new');
    expect(readFileSync(path.join(cacheHooks, 'inbox', 'fresh.jsonl'), 'utf8')).toBe('fresh');
    expect(readFileSync(path.join(cacheHooks, 'inbox', 'old.jsonl'), 'utf8')).toBe('old');
    // 老位置又变回链接（不是残留目录）
    expect(lstatSync(path.join(root, 'hooks')).isSymbolicLink()).toBe(true);
  });

  it('⑦ 数据目录还没建（全新安装）→ 空转', () => {
    rmSync(root, { recursive: true, force: true });
    expect(migrateDataLayout(root)).toEqual({ moved: [], kept: [], bridged: [], busyPid: null });
  });
});
