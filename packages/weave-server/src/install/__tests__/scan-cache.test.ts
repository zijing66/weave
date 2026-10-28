import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getLibraryScan, invalidateScan, scanLibrary, clearScanCache } from '../scan-cache.js';
import {
  scanLibraryFileAssets,
  scanLibraryMcp,
  scanLibraryPlugins,
  scanLibrarySkills,
} from '../scanner.js';

const dirs: string[] = [];

function makeLib(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weave-scan-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'alpha'), { recursive: true });
  writeFileSync(join(dir, 'alpha', 'SKILL.md'), '# alpha');
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'mcp', 'svc.json'), JSON.stringify({ command: 'node' }));
  return dir;
}

function cacheDirOf(libPath: string): string {
  return join(dirname(libPath), '.weave-scans', basename(libPath));
}

function readCacheFile(dir: string): { version?: number } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(cacheDirOf(dir), 'scans.json'), 'utf8'));
}

beforeEach(() => clearScanCache());
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
    rmSync(cacheDirOf(d), { recursive: true, force: true });
    rmSync(join(dirname(d), '.weave-scans'), { recursive: true, force: true });
  }
});

describe('scanLibrary', () => {
  it('与三扫描之和逐字段相等', async () => {
    const dir = makeLib();
    const scan = await scanLibrary(dir);
    const { plugins, packRoots } = await scanLibraryPlugins(dir);
    const [skills, mcp, files] = await Promise.all([
      scanLibrarySkills(dir, packRoots),
      scanLibraryMcp(dir, packRoots),
      scanLibraryFileAssets(dir, packRoots),
    ]);
    expect(scan.plugins).toEqual(plugins);
    expect(scan.packRoots).toEqual(packRoots);
    expect(scan.skills).toEqual(skills);
    expect(scan.mcp).toEqual(mcp);
    expect(scan.files).toEqual(files);
    expect(scan.skills.map((s) => s.name)).toEqual(['alpha']);
    expect(scan.mcp.map((m) => m.name)).toEqual(['svc']);
  });
});

describe('getLibraryScan', () => {
  it('miss→hit：首扫写旁挂 scans.json，二读同结果', async () => {
    const dir = makeLib();
    const first = await getLibraryScan(dir);
    const second = await getLibraryScan(dir);
    expect(second).toEqual(first);
    const file = readCacheFile(dir);
    expect(file.version).toBe(1);
    expect(file.skills).toEqual(first.skills);
    expect(file.mcp).toEqual(first.mcp);
  });

  it('缓存不落被扫目录内（不污染内容哈希与安装拷贝）', async () => {
    const dir = makeLib();
    await getLibraryScan(dir);
    expect(existsSync(join(dir, 'scans.json'))).toBe(false);
    expect(existsSync(join(cacheDirOf(dir), 'scans.json'))).toBe(true);
  });

  it('内存清空后（重启模拟）从 scans.json 命中，不再扫树', async () => {
    const dir = makeLib();
    await getLibraryScan(dir);
    clearScanCache();
    // 磁盘上加新 skill：若重扫必能看见，文件命中则仍返回旧结果
    mkdirSync(join(dir, 'beta'), { recursive: true });
    writeFileSync(join(dir, 'beta', 'SKILL.md'), '# beta');
    const hit = await getLibraryScan(dir);
    expect(hit.skills.map((s) => s.name)).toEqual(['alpha']);
  });

  it('库目录被外部删掉：不命中幽灵缓存，孤儿 scans.json 顺手清掉', async () => {
    const dir = makeLib();
    await getLibraryScan(dir);
    clearScanCache();
    rmSync(dir, { recursive: true, force: true });
    const scan = await getLibraryScan(dir);
    expect(scan.skills).toEqual([]); // 目录没了 = 空扫描，不是缓存里的旧资产
    expect(existsSync(cacheDirOf(dir))).toBe(false);
  });

  it('invalidate 后删缓存目录并重扫', async () => {
    const dir = makeLib();
    await getLibraryScan(dir);
    expect(existsSync(join(cacheDirOf(dir), 'scans.json'))).toBe(true);
    mkdirSync(join(dir, 'beta'), { recursive: true });
    writeFileSync(join(dir, 'beta', 'SKILL.md'), '# beta');
    await invalidateScan(dir);
    expect(existsSync(cacheDirOf(dir))).toBe(false);
    const fresh = await getLibraryScan(dir);
    expect(fresh.skills.map((s) => s.name)).toEqual(['alpha', 'beta']);
    expect(existsSync(join(cacheDirOf(dir), 'scans.json'))).toBe(true);
  });

  it('损坏 JSON = 该库 miss 自愈', async () => {
    const dir = makeLib();
    mkdirSync(cacheDirOf(dir), { recursive: true });
    writeFileSync(join(cacheDirOf(dir), 'scans.json'), '{ not json');
    const scan = await getLibraryScan(dir);
    expect(scan.skills.map((s) => s.name)).toEqual(['alpha']);
    expect(readCacheFile(dir).version).toBe(1);
  });

  it('version 不匹配 = 丢弃重扫', async () => {
    const dir = makeLib();
    mkdirSync(cacheDirOf(dir), { recursive: true });
    writeFileSync(join(cacheDirOf(dir), 'scans.json'), JSON.stringify({ version: 99, skills: [] }));
    const scan = await getLibraryScan(dir);
    expect(scan.skills.map((s) => s.name)).toEqual(['alpha']);
  });

  it('根对不上（库目录整体搬迁过）= 作废重扫，不沿用旧绝对路径', async () => {
    const dir = makeLib();
    mkdirSync(cacheDirOf(dir), { recursive: true });
    writeFileSync(
      join(cacheDirOf(dir), 'scans.json'),
      JSON.stringify({
        version: 1,
        root: join(dirname(dir), 'old-root'),
        plugins: [],
        packRoots: [],
        skills: [{ name: 'alpha', dirPath: join(dirname(dir), 'old-root', 'alpha'), relPath: 'alpha', group: 'skills' }],
        mcp: [],
        files: {},
      }),
    );
    const scan = await getLibraryScan(dir);
    expect(scan.skills.map((s) => s.dirPath)).toEqual([join(dir, 'alpha')]);
    expect(readCacheFile(dir).root).toBe(dir);
  });

  it('并发同路径共享一次加载（同引用）', async () => {
    const dir = makeLib();
    const [a, b] = await Promise.all([getLibraryScan(dir), getLibraryScan(dir)]);
    expect(a).toBe(b);
  });

  it('多目录分别管理：失效互不影响', async () => {
    const a = makeLib();
    const b = makeLib();
    await getLibraryScan(a);
    await getLibraryScan(b);
    await invalidateScan(a);
    expect(existsSync(join(cacheDirOf(a), 'scans.json'))).toBe(false);
    expect(existsSync(join(cacheDirOf(b), 'scans.json'))).toBe(true);
    // b 仍走缓存：磁盘加新 skill 不进结果
    mkdirSync(join(b, 'beta'), { recursive: true });
    writeFileSync(join(b, 'beta', 'SKILL.md'), '# beta');
    expect((await getLibraryScan(b)).skills.map((s) => s.name)).toEqual(['alpha']);
  });
});
