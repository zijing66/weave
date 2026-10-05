import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { LibraryRepository } from '../repositories/libraries.js';
import { ProjectRepository } from '../repositories/projects.js';
import { importFromDir } from '../market/import.js';
import { createWeaveServer } from '../daemon/server.js';

const DAEMON_TOKEN = 'daemon-token';

describe('daemon server — /market/check-updates + /market/refresh', () => {
  let server: Server;
  let db: DatabaseSync;
  let port: number;
  let dataDir: string;
  let src: string;
  let libId: number;
  let cacheDir: string;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'weave-mkt-route-'));
    src = mkdtempSync(path.join(tmpdir(), 'weave-mkt-route-src-'));
    tempDirs.push(dataDir, src);
    mkdirSync(path.join(src, 'skills', 's1'), { recursive: true });
    writeFileSync(path.join(src, 'skills', 's1', 'SKILL.md'), '# v1');

    db = openDatabase(':memory:');
    const libraries = new LibraryRepository(db, dataDir);
    const imported = await importFromDir(src, { libraries, dataDir });
    libId = imported.libraryId;
    cacheDir = imported.dir;

    server = createWeaveServer({
      projects: new ProjectRepository(db),
      daemonToken: DAEMON_TOKEN,
      port: 0,
      libraries,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json' };
  const post = (p: string, body?: unknown, headers: Record<string, string> = auth) =>
    fetch(`http://127.0.0.1:${port}/api${p}`, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = (p: string) => fetch(`http://127.0.0.1:${port}/api${p}`, { headers: auth });

  it('无 token 401', async () => {
    expect((await post('/market/check-updates', {}, {})).status).toBe(401);
    expect((await post('/market/refresh', {}, {})).status).toBe(401);
  });

  it('check-updates：空 body = 全量，源未变 → uptodate；源变更 → update-available', async () => {
    const res = await post('/market/check-updates');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { results: Array<{ id: number; status: string }> };
    expect(data.results.find((r) => r.id === libId)?.status).toBe('uptodate');

    writeFileSync(path.join(src, 'skills', 's1', 'SKILL.md'), '# v2');
    const res2 = await post('/market/check-updates', { ids: [libId] });
    const data2 = (await res2.json()) as { results: Array<{ id: number; status: string }> };
    expect(data2.results).toHaveLength(1);
    expect(data2.results[0]!.status).toBe('update-available');
  });

  it('refresh：覆盖刷新缓存，随后 check → uptodate', async () => {
    const res = await post('/market/refresh', { ids: [libId] });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { results: Array<{ id: number; status: string }> };
    expect(data.results[0]!.status).toBe('refreshed');
    expect(readFileSync(path.join(cacheDir, 'skills', 's1', 'SKILL.md'), 'utf-8')).toBe('# v2');

    const after = await post('/market/check-updates', { ids: [libId] });
    const afterData = (await after.json()) as { results: Array<{ status: string }> };
    expect(afterData.results[0]!.status).toBe('uptodate');
  });

  it('非法 JSON body → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/market/check-updates`, {
      method: 'POST',
      headers: auth,
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('GET /market：tags 资产类型计数 + refresh 后缓存失效重算', async () => {
    interface MarketItemsJson {
      items: Array<{ id: number; tags: Record<string, number> | null }>;
    }
    const pick = (json: MarketItemsJson) => json.items.find((i) => i.id === libId)?.tags;
    // 初始：fixture 只有 skills/s1 → 只有 skill tag（0 计数 key 不出现）
    const r1 = await get('/market');
    expect(r1.status).toBe(200);
    const t1 = pick((await r1.json()) as MarketItemsJson)!;
    expect(t1.skill).toBe(1);
    expect(t1.plugin).toBeUndefined();

    // 源新增可装载包 → refresh 覆盖缓存 → clearAssetTagsCache 后重算
    mkdirSync(path.join(src, 'pkg', '.claude-plugin'), { recursive: true });
    writeFileSync(
      path.join(src, 'pkg', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'pkg', version: '1.0.0' }),
    );
    mkdirSync(path.join(src, 'pkg', 'commands'), { recursive: true });
    writeFileSync(path.join(src, 'pkg', 'commands', 'c.md'), '# c');
    const r2 = await post('/market/refresh', { ids: [libId] });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { results: Array<{ status: string }> }).results[0]!.status).toBe(
      'refreshed',
    );

    const r3 = await get('/market');
    const t3 = pick((await r3.json()) as MarketItemsJson)!;
    expect(t3.plugin).toBe(1);
    expect(t3.skill).toBe(1); // 包内 commands 归 plugin，不产独立 tag；包外 skill 不受影响
    expect(t3.command).toBeUndefined(); // 包子树被 packRoots 排除
  });
});
