import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClaudePluginSurface, type PluginExecutor } from '@weavecode/harness';
import { openDatabase } from '../db/db.js';
import { LibraryRepository } from '../repositories/libraries.js';
import { ProjectRepository } from '../repositories/projects.js';
import { importFromDir } from '../market/import.js';
import { createWeaveServer } from '../daemon/server.js';

/**
 * 层 1 反向收口：DELETE /market/:id 除删市场目录与行外，还经 PluginSurface
 * 注销宿主市场（known_marketplaces 反查 + `claude plugin marketplace remove`）。
 * 注销 best-effort：失败不拦删，warning 带回。surface 注入假 exec，不 spawn claude。
 */

describe('daemon DELETE /market/:id — 宿主市场注销', () => {
  let server: Server;
  let db: DatabaseSync;
  let port: number;
  let base: string;
  let dataDir: string;
  let libA: number;
  let libB: number;
  let dirA: string;
  let dirB: string;
  let failMarketRemove = false;
  let calls: string[][];
  const tempDirs: string[] = [];

  const importMarket = async (tag: string): Promise<{ id: number; dir: string }> => {
    const src = mkdtempSync(path.join(tmpdir(), `weave-mkt-rm-${tag}-`));
    tempDirs.push(src);
    mkdirSync(path.join(src, 'skills', 's1'), { recursive: true });
    writeFileSync(path.join(src, 'skills', 's1', 'SKILL.md'), '# v1');
    const imported = await importFromDir(src, { libraries, dataDir });
    return { id: imported.libraryId, dir: imported.dir };
  };

  let libraries: LibraryRepository;

  beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'weave-mkt-rm-home-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'weave-mkt-rm-data-'));
    tempDirs.push(base, dataDir);
    process.env.HOME = base;
    process.env.USERPROFILE = base;
    calls = [];
    const exec: PluginExecutor = async (args) => {
      calls.push([...args]);
      if (failMarketRemove && args[1] === 'marketplace' && args[2] === 'remove') {
        throw new Error('cli boom');
      }
      return { stdout: '', stderr: '' };
    };
    db = openDatabase(':memory:');
    libraries = new LibraryRepository(db, dataDir);
    const a = await importMarket('a');
    const b = await importMarket('b');
    libA = a.id;
    libB = b.id;
    dirA = a.dir;
    dirB = b.dir;
    // 宿主注册表：注册名 ≠ 目录名，证明按落点反查（而非拿 basename 当注册名）。
    await mkdirSync(path.join(base, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      path.join(base, '.claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        'ccp-market': { source: { source: 'directory', path: dirA }, installLocation: dirA },
        'b-market': { source: { source: 'directory', path: dirB }, installLocation: dirB },
      }),
    );
    server = createWeaveServer({
      projects: new ProjectRepository(db),
      port: 0,
      libraries,
      pluginSurface: createClaudePluginSurface({ exec }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  const del = (id: number): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/api/market/${id}`, { method: 'DELETE' });

  it('删市场副本 + 按落点反查注销宿主市场（注册名≠目录名）+ 行消失', async () => {
    const res = await del(libA);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; warning?: string };
    expect(data.ok).toBe(true);
    expect(data.warning).toBeUndefined();
    expect(calls).toEqual([['plugin', 'marketplace', 'remove', 'ccp-market']]);
    expect(existsSync(dirA)).toBe(false);
    const list = (await (
      await fetch(`http://127.0.0.1:${port}/api/market`)
    ).json()) as { items: Array<{ id: number }> };
    expect(list.items.some((i) => i.id === libA)).toBe(false);
  });

  it('注销失败 → best-effort：目录与行照删，warning 带回', async () => {
    failMarketRemove = true;
    const res = await del(libB);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; warning?: string };
    expect(data.ok).toBe(true);
    expect(data.warning).toContain('cli boom');
    expect(existsSync(dirB)).toBe(false);
  });

  it('行已不存在 → 404', async () => {
    expect((await del(libA)).status).toBe(404);
  });
});
