import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { builtinPacksRoot } from '@weavecode/templates';
import { openDatabase } from '../../db/db.js';
import { LibraryRepository } from '../../repositories/libraries.js';
import { marketLibraryRoots } from '../resolve.js';
import { discoverToolkitPacks } from '../../hooks/toolkit-scan.js';
import {
  BUILTIN_MARKET_ID,
  builtinMarketDir,
  builtinPacksDir,
  builtinRulesDir,
  ensureBuiltinMarket,
  isBuiltinMarketDir,
} from '../builtin.js';

/**
 * 内置仓落地：`<dataDir>/market/weave/` 是指向包内仓的链接（失败回退复制）
 * ——「公共全局位置优先链接」的落实。落点里**不得**写入任何东西（它是包内容）。
 */
describe('内置仓落地（market/builtin）', () => {
  let db: DatabaseSync;
  let libraries: LibraryRepository;
  let dataDir: string;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    dataDir = await mkdtemp(path.join(tmpdir(), 'weave-builtin-'));
    libraries = new LibraryRepository(db, dataDir);
  });

  afterEach(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('落地 + 登记 libraries 行（路径相对 posix），仓内容可读', async () => {
    const r = await ensureBuiltinMarket({ libraries });
    expect(r.error).toBeUndefined();
    expect(r.changed).toBe(true);
    expect(r.form === 'link' || r.form === 'copy').toBe(true);

    const dir = builtinMarketDir(dataDir);
    const row = libraries.list().find((x) => isBuiltinMarketDir(x.path, dataDir));
    expect(row).toBeDefined();
    expect(row!.kind).toBe('both');
    expect(libraries.getByPath(dir)?.id).toBe(row!.id); // 相对/绝对两种写法同判
    // 清单与三个区都在（点在 .claude-plugin）
    expect((await readdir(dir)).sort()).toEqual(['.claude-plugin', 'init', 'plugins', 'rules']);
    expect(await readdir(builtinRulesDir(dataDir))).toHaveLength(3);
  });

  it('9 个内置工具包仍从落地仓发现，scope 不变', async () => {
    await ensureBuiltinMarket({ libraries });
    const packs = await discoverToolkitPacks({
      root: builtinPacksDir(dataDir),
      provenance: 'builtin',
    });
    expect(packs.map((p) => p.id).sort()).toEqual([
      'code-review',
      'docs-reminder',
      'file-guard',
      'md-lint',
      'mission-control',
      'project-navigation',
      'refactoring',
      'testing',
      'weave-plugin-creator',
    ]);
    expect([...new Set(packs.map((p) => p.scope))].sort()).toEqual([
      'core-skills',
      'doc-hooks',
      'session-mods',
    ]);
  });

  it('幂等：落点已指向当前源则不动盘（changed=false、form=link）', async () => {
    const first = await ensureBuiltinMarket({ libraries });
    const again = await ensureBuiltinMarket({ libraries });
    expect(again.changed).toBe(false);
    if (first.form === 'link') {
      expect(again.form).toBe('link');
      expect((await lstat(builtinMarketDir(dataDir))).isSymbolicLink()).toBe(true);
    }
    // 重复登记不产生第二行
    expect(libraries.list().filter((x) => isBuiltinMarketDir(x.path, dataDir))).toHaveLength(1);
  });

  it('落点是陈旧副本/普通目录 → 重铺并改回链接（不删穿源）', async () => {
    await ensureBuiltinMarket({ libraries });
    // 模拟「当时无法建链接、回退成复制」的落点
    await rm(builtinMarketDir(dataDir), { recursive: true, force: true });
    await mkdir(builtinPacksDir(dataDir), { recursive: true });
    await writeFile(path.join(builtinMarketDir(dataDir), 'stale.txt'), 'stale\n');

    const again = await ensureBuiltinMarket({ libraries });
    expect(again.changed).toBe(true);
    expect(await readdir(builtinMarketDir(dataDir)).then((e) => e.includes('stale.txt'))).toBe(false);
    expect(await readdir(builtinPacksDir(dataDir))).toContain('core-skills');
    // 包内源目录毫发无损：重铺走 removeInstalled 的 lstat 判定（链接 unlink、
    // 副本 rm），绝不解引用连源一起删。
    expect(await readdir(builtinPacksRoot())).toEqual(
      expect.arrayContaining(['core-skills', 'doc-hooks', 'session-mods']),
    );
  });

  it('marketLibraryRoots 排除内置仓，但照常收其它市场根', async () => {
    await ensureBuiltinMarket({ libraries });
    const other = path.join(dataDir, 'market', 'claude-code-playground');
    await mkdir(other, { recursive: true });
    libraries.add({ path: other, kind: 'both' });

    const roots = marketLibraryRoots(libraries, dataDir);
    expect(roots).not.toContain(builtinMarketDir(dataDir));
    expect(roots).toContain(other);
  });

  it('id 常量与 harness 的注册键缺省市场同名（两边同名才对得上键）', () => {
    expect(BUILTIN_MARKET_ID).toBe('weave');
  });
});
