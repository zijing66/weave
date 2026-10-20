import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository, type ProjectRow } from '../../repositories/projects.js';
import { LibraryRepository } from '../../repositories/libraries.js';
import { HookRuleRepository } from '../../repositories/hook-rules.js';
import { HookRuleRegistry } from '../registry.js';
import { PluginStateRepository } from '../../repositories/plugin-states.js';
import { ToolkitService, projectFileNamespaces } from '../toolkit.js';
import { loadAllPlugins } from '../plugin-loader.js';
import { marketLibraryRoots } from '../../market/resolve.js';

/**
 * M3 装载桥：managed 市场资源根纳入 toolkit 扫描源（provenance='market'）与
 * plugin-loader 装载源（默认停用待开关），同根归一只装一次。
 * dataDir 经 APPDATA/XDG_CONFIG_HOME 重定向到临时目录（同 toolkit-sources.test）。
 */

const MANIFEST = {
  manifestVersion: 1,
  id: 'market-sample',
  name: '市场示例',
  version: '1.0.0',
  rules: ['rules.json'],
};
const RULES = [
  {
    name: '市场示例规则',
    source: { kind: 'claude-event', event: 'Stop' },
    handler: { type: 'log' },
  },
];

async function writePack(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'weave-plugin.json'), JSON.stringify(MANIFEST, null, 2));
  await writeFile(path.join(dir, 'rules.json'), JSON.stringify(RULES, null, 2));
}

describe('市场根进 toolkit/loader 源（M3 装载桥）', () => {
  let base: string;
  let dataRoot: string;
  let marketRoot: string;
  let legacyRoot: string;
  let builtinRoot: string;
  let db: DatabaseSync;
  let projects: ProjectRepository;
  let libraries: LibraryRepository;
  let states: PluginStateRepository;
  let rules: HookRuleRepository;
  let registry: HookRuleRegistry;
  let project: ProjectRow;
  let savedAppdata: string | undefined;
  let savedXdg: string | undefined;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'weave-mkt-roots-'));
    savedAppdata = process.env.APPDATA;
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = base;
    process.env.XDG_CONFIG_HOME = base;
    dataRoot = path.join(base, 'weave', 'data');
    marketRoot = path.join(dataRoot, 'market', 'mkt-repo');
    legacyRoot = path.join(base, 'legacy-src');
    builtinRoot = path.join(base, 'builtin');
    await writePack(marketRoot);
    await writePack(path.join(legacyRoot, 'legacy-pack')); // market 外的库不入源
    await mkdir(builtinRoot, { recursive: true });

    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    libraries = new LibraryRepository(db); // 默认 dataRoot = getDataRoot()（已重定向）
    states = new PluginStateRepository(db);
    rules = new HookRuleRepository(db);
    registry = new HookRuleRegistry(rules);
    libraries.add({ path: marketRoot, kind: 'both' });
    libraries.add({ path: legacyRoot, kind: 'both' });
    project = projects.register({
      path: path.join(base, 'proj'),
      name: 'p',
      token: 't',
      source: 'init',
    });
    await mkdir(project.path, { recursive: true });
  });

  afterEach(async () => {
    if (savedAppdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppdata;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    db.close();
    await rm(base, { recursive: true, force: true });
  });

  it('marketLibraryRoots：仅返回市场内库根（legacy 外部源与 market 根自身排除）', () => {
    expect(marketLibraryRoots(libraries)).toEqual([path.resolve(marketRoot)]);
  });

  it('ToolkitService.list：市场包入扫描源且 provenance=market，legacy 源不入', async () => {
    const service = new ToolkitService({
      projects,
      states,
      builtinRoot,
      libraries,
      plugins: { list: () => [], setPluginEnabled: () => true },
    });
    const res = await service.list(project.id);
    const pack = res.packs.find((p) => p.id === 'market-sample');
    expect(pack).toMatchObject({
      provenance: 'market',
      sourceRoot: path.resolve(marketRoot),
      weavePack: true,
      // 一级折叠块的仓库名 = 市场身份（`marketIdOf(pack.dir)`）
      namespace: 'mkt-repo',
    });
    expect(res.packs.some((p) => p.id === 'legacy-pack')).toBe(false);
  });

  it('内置仓落地后的包 namespace = weave（与市场列表里的仓库行同名）', async () => {
    // 真实落地态：内置仓落在 `<dataRoot>/market/weave/`（ensureBuiltinMarket 的落点）
    const builtinPacks = path.join(dataRoot, 'market', 'weave', 'plugins');
    await writePack(path.join(builtinPacks, 'core-skills', 'builtin-sample'));
    const service = new ToolkitService({
      projects,
      states,
      builtinRoot: builtinPacks,
      libraries,
      plugins: { list: () => [], setPluginEnabled: () => true },
    });
    const res = await service.list(project.id);
    const pack = res.packs.find((p) => p.provenance === 'builtin' && p.scope === 'core-skills');
    expect(pack).toMatchObject({ namespace: 'weave', provenance: 'builtin' });
  });

  it('projectFileNamespaces：文件归哪个仓库按落盘记录反查（无来源的包与坏记录不打标）', async () => {
    const dir = path.join(project.path, '.weave', 'toolkit');
    await mkdir(dir, { recursive: true });
    const record = (packId: string, sourceDir: string, files: string[]) => ({
      packId,
      provenance: 'market',
      sourceRoot: sourceDir,
      sourceDir,
      enabledAt: '2026-01-01T00:00:00.000Z',
      files: Object.fromEntries(files.map((f) => [f, 'sha'])),
    });
    await writeFile(
      path.join(dir, 'mkt.json'),
      JSON.stringify(
        record('market-sample', marketRoot, [
          '.claude/rules/market-sample.md',
          '.weave/market-cache.json',
        ]),
      ),
    );
    await writeFile(
      path.join(dir, 'builtin.json'),
      JSON.stringify(
        record('builtin-sample', path.join(dataRoot, 'market', 'weave', 'plugins', 'core-skills'), [
          '.claude/rules/weave-stop-summary.md',
        ]),
      ),
    );
    // 手加目录（不在任何市场下）与损坏记录：无仓库可归
    await writeFile(
      path.join(dir, 'local.json'),
      JSON.stringify(record('hand-added', path.join(base, 'hand-added'), ['AGENTS.md'])),
    );
    await writeFile(path.join(dir, 'broken.json'), '{ not json');

    const namespaces = await projectFileNamespaces(project.path);
    expect(namespaces.get('.claude/rules/market-sample.md')).toBe('mkt-repo');
    expect(namespaces.get('.weave/market-cache.json')).toBe('mkt-repo');
    expect(namespaces.get('.claude/rules/weave-stop-summary.md')).toBe('weave');
    expect(namespaces.get('AGENTS.md')).toBeUndefined();
    expect(namespaces.size).toBe(3);
  });

  it('项目没启用过任何包（无记录目录）：空表，不抛', async () => {
    expect((await projectFileNamespaces(project.path)).size).toBe(0);
  });

  it('缺省 libraries（存量装配）：不扫市场，行为不变', async () => {
    const service = new ToolkitService({
      projects,
      states,
      builtinRoot,
      plugins: { list: () => [], setPluginEnabled: () => true },
    });
    const res = await service.list(project.id);
    expect(res.packs.find((p) => p.id === 'market-sample')).toBeUndefined();
  });

  it('loadAllPlugins：市场 weave 包装载、默认停用、enable 后 candidates 可见', async () => {
    const { loader, loaded } = await loadAllPlugins(
      { rules, registry, states, libraries },
      [],
    );
    expect(loaded.filter((p) => p.id === 'market-sample')).toHaveLength(1);
    expect(loader.list().some((p) => p.id === 'market-sample')).toBe(true);

    const pluginRules = rules.listByPlugin('market-sample');
    expect(pluginRules).toHaveLength(1);
    // toolkit 首见默认停用 → 无候选
    expect(registry.candidates('Stop').some((r) => r.pluginId === 'market-sample')).toBe(false);

    expect(loader.setPluginEnabled('market-sample', true)).toBe(true);
    expect(registry.candidates('Stop').some((r) => r.pluginId === 'market-sample')).toBe(true);
  });

  it('同根归一：内置根与市场根重合时扫描源去重、包只出一份', async () => {
    const service = new ToolkitService({
      projects,
      states,
      builtinRoot: marketRoot,
      libraries,
      plugins: { list: () => [], setPluginEnabled: () => true },
    });
    const res = await service.list(project.id);
    expect(res.packs.filter((p) => p.id === 'market-sample')).toHaveLength(1);
  });
});
