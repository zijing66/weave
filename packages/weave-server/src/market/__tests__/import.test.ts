import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { importFromDir, importLibraryIntoMarket, slugifyResourceId } from '../import.js';
import { marketDir, readManifest } from '../manifest.js';
import { isInsideDir } from '../resolve.js';
import { openDatabase } from '../../db/db.js';
import { LibraryRepository } from '../../repositories/libraries.js';
import type { DatabaseSync } from 'node:sqlite';

let dataDir: string;
let srcRoot: string;
let db: DatabaseSync;
let libs: LibraryRepository;
const tempDirs: string[] = [];

function makeSource(name: string): string {
  const src = path.join(srcRoot, name);
  mkdirSync(path.join(src, 'skills', `${name}-skill`), { recursive: true });
  writeFileSync(path.join(src, 'skills', `${name}-skill`, 'SKILL.md'), '# skill');
  return src;
}

beforeAll(() => {
  srcRoot = mkdtempSync(path.join(tmpdir(), 'weave-market-src-'));
});
afterAll(() => {
  rmSync(srcRoot, { recursive: true, force: true });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'weave-market-import-'));
  tempDirs.push(dataDir);
  db = openDatabase(':memory:');
  libs = new LibraryRepository(db, dataDir);
});

describe('importFromDir（本地目录 → 市场）', () => {
  it('复制目录 + 写清单 + 登记 libraries 行（相对 posix 形入库）', async () => {
    const src = makeSource('alpha');
    const res = await importFromDir(src, { libraries: libs, dataDir });

    // 复制（不是移动）：源仍在，市场内有完整副本
    expect(existsSync(path.join(src, 'skills', 'alpha-skill', 'SKILL.md'))).toBe(true);
    expect(
      readFileSync(path.join(res.dir, 'skills', 'alpha-skill', 'SKILL.md'), 'utf-8'),
    ).toBe('# skill');

    // 清单
    const manifest = await readManifest(res.dir);
    expect(manifest?.source).toBe('dir');
    expect(manifest?.origin).toBe(path.resolve(src));
    expect(manifest?.importedAt).toBeTruthy();

    // containment：目标落在 <dataDir>/market 内
    expect(isInsideDir(res.dir, marketDir(dataDir))).toBe(true);

    // libraries 行：读侧 resolve 为绝对路径，存储为相对 posix 形
    const row = libs.getById(res.libraryId)!;
    expect(row.path).toBe(path.join(dataDir, 'market', res.id));
    const stored = db.prepare('SELECT path FROM libraries WHERE id = ?').get(row.id) as {
      path: string;
    };
    expect(stored.path).toBe(`market/${res.id}`);
    expect(stored.path).not.toContain('\\');
  });

  it('同名目录冲突 → 追加 -2 后缀；同一来源重复导入 → 复用', async () => {
    const a = makeSource('same');
    const b = path.join(srcRoot, 'other', 'same');
    mkdirSync(b, { recursive: true });
    writeFileSync(path.join(b, 'README.md'), 'other');

    const first = await importFromDir(a, { libraries: libs, dataDir });
    const second = await importFromDir(b, { libraries: libs, dataDir });
    expect(first.id).toBe('same');
    expect(second.id).toBe('same-2');
    expect(second.reused).toBe(false);

    // 同一来源再次导入 = 覆盖刷新（M4 修订组：原断言「复用不重拷」已随
    // 覆盖重导语义改为「复用同一行 + 缓存内容更新」）
    writeFileSync(path.join(a, 'skills', 'same-skill', 'SKILL.md'), '# skill v2');
    const again = await importFromDir(a, { libraries: libs, dataDir });
    expect(again.reused).toBe(true);
    expect(again.refreshed).toBe(true);
    expect(again.id).toBe(first.id);
    expect(libs.list()).toHaveLength(2); // 不新增行
    expect(
      readFileSync(path.join(again.dir, 'skills', 'same-skill', 'SKILL.md'), 'utf-8'),
    ).toBe('# skill v2'); // 缓存被源内容覆盖
  });

  it('非目录 / 缺失路径直接拒绝', async () => {
    const file = path.join(srcRoot, 'plain.txt');
    writeFileSync(file, 'x');
    await expect(importFromDir(file, { libraries: libs, dataDir })).rejects.toThrow(
      /Not a directory/,
    );
    await expect(
      importFromDir(path.join(srcRoot, 'nope'), { libraries: libs, dataDir }),
    ).rejects.toThrow(/Not a directory/);
  });
});

describe('slug 白名单（防穿越）', () => {
  it('只产出 [a-z0-9-]，危险名回落 resource', () => {
    expect(slugifyResourceId('My Skills!')).toBe('my-skills');
    expect(slugifyResourceId('..')).toBe('resource');
    expect(slugifyResourceId('../..')).toBe('resource');
    expect(slugifyResourceId('..\\..\\evil')).toBe('evil');
    expect(slugifyResourceId('')).toBe('resource');
    expect(slugifyResourceId('---')).toBe('resource');
    for (const s of ['..', '../..', 'a b', '名字', '..\\..\\evil']) {
      expect(slugifyResourceId(s)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });
});

describe('importLibraryIntoMarket（legacy 外部源显式迁入）', () => {
  it('复制进市场 + 改写既有行（id 不变、源保留）', async () => {
    const external = makeSource('legacy-lib');
    const row = libs.add({ path: external, kind: 'skill' }); // 外部绝对路径原样入库
    const stored0 = db.prepare('SELECT path FROM libraries WHERE id = ?').get(row.id) as {
      path: string;
    };
    expect(stored0.path).toBe(path.resolve(external));

    const res = await importLibraryIntoMarket(libs.getById(row.id)!, {
      libraries: libs,
      dataDir,
    });
    expect(res.reused).toBe(false);
    expect(res.libraryId).toBe(row.id); // 不新增行
    expect(existsSync(path.join(external, 'skills', 'legacy-lib-skill', 'SKILL.md'))).toBe(true);

    const after = libs.getById(row.id)!;
    expect(after.path).toBe(path.join(dataDir, 'market', res.id));
    const stored = db.prepare('SELECT path FROM libraries WHERE id = ?').get(row.id) as {
      path: string;
    };
    expect(stored.path).toBe(`market/${res.id}`);
    const manifest = await readManifest(res.dir);
    expect(manifest?.origin).toBe(path.resolve(external));
  });

  it('已在市场内 → 幂等（不复制第二份）', async () => {
    const src = makeSource('idem');
    const imported = await importFromDir(src, { libraries: libs, dataDir });
    const res = await importLibraryIntoMarket(libs.getById(imported.libraryId)!, {
      libraries: libs,
      dataDir,
    });
    expect(res.reused).toBe(true);
    expect(res.dir).toBe(imported.dir);
    expect(libs.list()).toHaveLength(1);
  });

  it('源不存在 → 拒绝', async () => {
    const row = libs.add({ path: path.join(srcRoot, 'gone'), kind: 'skill' });
    await expect(
      importLibraryIntoMarket(libs.getById(row.id)!, { libraries: libs, dataDir }),
    ).rejects.toThrow(/not found/i);
  });
});
