import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { builtinPacksRoot } from '@weavecode/templates';
import {
  discoverToolkitPacks,
  discoverWeavePackDirs,
  isToolkitPackDir,
  parseToolkitPack,
} from '../toolkit-scan.js';

/**
 * 批 10 扫描识别：三格式（CC 插件包 / weave 规则包 / 裸表面包）+ depth-3 树 +
 * 外置目录同构发现 + provenance 标注。内置真实树（harness-tools）冒烟见文末。
 */

const BUILTIN_ROOT = builtinPacksRoot();

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

describe('toolkit-scan 识别与发现', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'weave-tk-scan-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('三格式识别：CC 包 / weave 包 / 裸表面包', async () => {
    const ccDir = path.join(root, 'a/cc-pack');
    await writeJson(path.join(ccDir, '.claude-plugin/plugin.json'), {
      name: 'cc-pack',
      version: '1.0.0',
      description: 'x',
    });
    await mkdir(path.join(ccDir, 'skills', 's1'), { recursive: true });
    await writeFile(path.join(ccDir, 'skills', 's1', 'SKILL.md'), '# s1');

    const weaveDir = path.join(root, 'a/weave-pack');
    await writeJson(path.join(weaveDir, 'weave-plugin.json'), {
      manifestVersion: 1,
      id: 'weave-pack',
      name: 'W',
      version: '1.0.0',
      rules: [],
    });

    const bareDir = path.join(root, 'a/bare-pack');
    await mkdir(path.join(bareDir, 'skills', 'only'), { recursive: true });
    await writeFile(path.join(bareDir, 'skills', 'only', 'SKILL.md'), '# only');

    expect(await isToolkitPackDir(ccDir)).toBe(true);
    expect(await isToolkitPackDir(weaveDir)).toBe(true);
    expect(await isToolkitPackDir(bareDir)).toBe(true);
    expect(await isToolkitPackDir(root)).toBe(false);

    const packs = await discoverToolkitPacks({ root, provenance: 'builtin' });
    const byId = new Map(packs.map((p) => [p.id, p]));
    expect([...byId.keys()].sort()).toEqual(['bare-pack', 'cc-pack', 'weave-pack']);
    expect(byId.get('cc-pack')).toMatchObject({
      ccPack: true,
      weavePack: false,
      kind: 'skill',
      components: ['skill'],
      skills: ['s1'],
      provenance: 'builtin',
    });
    expect(byId.get('weave-pack')).toMatchObject({
      ccPack: false,
      weavePack: true,
      kind: 'rule',
      components: ['rule'],
    });
    expect(byId.get('bare-pack')).toMatchObject({ ccPack: false, weavePack: false, kind: 'skill' });
  });

  it('一包同时命中 ①②（CC manifest + weave manifest 并存）', async () => {
    const dir = path.join(root, 'mixed');
    await writeJson(path.join(dir, '.claude-plugin/plugin.json'), {
      name: 'mixed',
      version: '1.0.0',
    });
    await writeJson(path.join(dir, 'weave-plugin.json'), {
      manifestVersion: 1,
      id: 'mixed',
      name: '混合',
      version: '1.0.0',
      rules: [],
    });
    const packs = await discoverToolkitPacks({ root, provenance: 'builtin' });
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ id: 'mixed', ccPack: true, weavePack: true, components: ['rule'] });
  });

  it('depth-3 树：root/<scope>/<pack> 被发现，包不嵌套下钻', async () => {
    const pack = path.join(root, 'core-skills/code-review');
    await writeJson(path.join(pack, '.claude-plugin/plugin.json'), {
      name: 'code-review',
      version: '0.1.0',
    });
    await mkdir(path.join(pack, 'skills', 'code-review'), { recursive: true });
    await writeFile(path.join(pack, 'skills', 'code-review', 'SKILL.md'), '# x');
    // 包内再放一个「看似包位」的子目录（含 skills/），不应被当独立包
    await mkdir(path.join(pack, 'skills', 'inner'), { recursive: true });

    const packs = await discoverToolkitPacks({ root, provenance: 'builtin' });
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ id: 'code-review', scope: 'core-skills' });

    const weaveDirs = await discoverWeavePackDirs(root);
    expect(weaveDirs).toEqual([]);
  });

  it('discoverWeavePackDirs 深度发现 weave 包位（depth ≤ 3），跳过点目录', async () => {
    const pack = path.join(root, 'doc-hooks/md-lint');
    await writeJson(path.join(pack, 'weave-plugin.json'), {
      manifestVersion: 1,
      id: 'md-lint',
      name: 'lint',
      version: '1.0.0',
      rules: [],
    });
    await writeJson(path.join(root, 'doc-hooks/.hidden/weave-plugin.json'), {
      manifestVersion: 1,
      id: 'hidden',
      name: 'h',
      version: '1.0.0',
      rules: [],
    });
    const found = await discoverWeavePackDirs(root);
    expect(found).toEqual([path.resolve(pack)]);
  });

  it('weave.json 补充字段：targets / kind 生效，坏 JSON 回落默认', async () => {
    const dir = path.join(root, 'p');
    await mkdir(path.join(dir, 'skills', 's'), { recursive: true });
    await writeFile(path.join(dir, 'skills', 's', 'SKILL.md'), '# s');
    await writeFile(path.join(dir, 'weave.json'), JSON.stringify({ targets: ['codex'], kind: 'surface' }));
    let pack = await parseToolkitPack(dir, { root, provenance: 'builtin' }, '');
    expect(pack).toMatchObject({ targets: ['codex'], kind: 'surface' });

    await writeFile(path.join(dir, 'weave.json'), '{ not json');
    pack = await parseToolkitPack(dir, { root, provenance: 'builtin' }, '');
    expect(pack).toMatchObject({ targets: ['claude'] }); // 默认 ['claude']
  });

  it('mods-only 包（无 manifest 非空 modules）进 toolkit 列表（修：mods 无安装按钮）', async () => {
    const dir = path.join(root, 'm/mods-only');
    await writeJson(path.join(dir, 'hooks', 'hooks.json'), { modules: ['./register.tsx'] });
    // 空 modules 不算包（与市场窄谓词同口径）
    const empty = path.join(root, 'm/empty-hooks');
    await writeJson(path.join(empty, 'hooks', 'hooks.json'), { modules: [] });

    expect(await isToolkitPackDir(dir)).toBe(true);
    expect(await isToolkitPackDir(empty)).toBe(false);

    const packs = await discoverToolkitPacks({ root, provenance: 'builtin' });
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({
      kind: 'mod',
      components: ['mod'],
      ccPack: false,
      weavePack: false,
      // 无 manifest 包的 name/id 推导回落目录名
      id: 'mods-only',
      name: 'mods-only',
    });
  });

  it('market 源深度对齐市场扫描（depth>3 深包发现）；builtin 深度行为零变', async () => {
    const deep = path.join(root, 'a/b/c/deep-pack'); // root0→a1→b2→c3→pack4
    await writeJson(path.join(deep, '.claude-plugin/plugin.json'), { name: 'deep-pack', version: '1.0.0' });
    await mkdir(path.join(deep, 'skills', 's'), { recursive: true });
    await writeFile(path.join(deep, 'skills', 's', 'SKILL.md'), '# s');

    const market = await discoverToolkitPacks({ root, provenance: 'market' });
    expect(market.map((p) => p.id)).toContain('deep-pack');
    // builtin 维持 depth-3（level ≥ 2 截断）：深包不可见
    const ext = await discoverToolkitPacks({ root, provenance: 'builtin' });
    expect(ext).toHaveLength(0);
  });

  it('market 根层裸表面视为容器（不吞并）：嵌套 mods 包被发现；builtin/manifest 根即包零变', async () => {
    // 布局：库根带 skills/（skill 仓库常态）+ 嵌套 mods 包
    await mkdir(path.join(root, 'skills', 'top'), { recursive: true });
    await writeFile(path.join(root, 'skills', 'top', 'SKILL.md'), '# top');
    const mods = path.join(root, 'tools/mods-pkg');
    await writeJson(path.join(mods, 'hooks', 'hooks.json'), { modules: ['./register.tsx'] });

    // market 源：根仅裸表面命中 → 容器下钻，嵌套 mods 包发现（根不产出包）
    const market = await discoverToolkitPacks({ root, provenance: 'market' });
    expect(market.map((p) => p.id)).toEqual(['mods-pkg']);
    expect(market[0]).toMatchObject({ kind: 'mod', provenance: 'market' });

    // builtin 源同布局：根即包语义零变（吞并为单个裸表面包，嵌套不可见）
    const ext = await discoverToolkitPacks({ root, provenance: 'builtin' });
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({ components: ['skill'], dir: root });

    // market 根带 manifest → 仍当包（严格谓词命中不下钻）
    const root2 = await mkdtemp(path.join(tmpdir(), 'weave-tk-rootpack-'));
    try {
      await writeJson(path.join(root2, '.claude-plugin/plugin.json'), { name: 'root-cc', version: '1.0.0' });
      await mkdir(path.join(root2, 'skills', 's'), { recursive: true });
      await writeFile(path.join(root2, 'skills', 's', 'SKILL.md'), '# s');
      const m2 = await discoverToolkitPacks({ root: root2, provenance: 'market' });
      expect(m2).toHaveLength(1);
      // id 无 weave manifest 时回落目录名，name 取 CC manifest
      expect(m2[0]).toMatchObject({ name: 'root-cc', ccPack: true, dir: root2 });
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });

  it('内置真实树冒烟：5 个包、scope/类型齐全、md-lint 命中 weave 成分', async () => {
    const packs = await discoverToolkitPacks({ root: BUILTIN_ROOT, provenance: 'builtin' });
    const ids = packs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'file-guard',
      'md-lint',
      'mission-control',
      'weave-plugin-creator',
      'weave-user-guide',
    ]);
    const byId = new Map(packs.map((p) => [p.id, p]));
    expect(byId.get('weave-user-guide')).toMatchObject({
      scope: 'core-skills',
      kind: 'skill',
      targets: ['claude', 'codex'],
      ccPack: true,
      provenance: 'builtin',
    });
    expect(byId.get('weave-plugin-creator')).toMatchObject({
      scope: 'core-skills',
      kind: 'skill',
      ccPack: true,
      skills: ['weave-plugin-creator'],
    });
    expect(byId.get('md-lint')).toMatchObject({ weavePack: true, kind: 'rule' });
    expect(byId.get('mission-control')).toMatchObject({ kind: 'mod', components: ['mod'] });
    expect(byId.get('file-guard')).toMatchObject({ kind: 'mod', components: ['mod'] });
  });

  it('市场镜像内置结构时 scope/字段与内置一致（闸⑤ 扫描面）', async () => {
    const ext = path.join(root, 'ext');
    await cp(BUILTIN_ROOT, ext, { recursive: true });
    const builtin = await discoverToolkitPacks({ root: BUILTIN_ROOT, provenance: 'builtin' });
    const market = await discoverToolkitPacks({ root: ext, provenance: 'market' });
    const strip = (p: (typeof builtin)[0]) => {
      const { provenance: _p, sourceRoot: _s, dir: _d, ...rest } = p;
      return rest;
    };
    expect(market.map(strip).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      builtin.map(strip).sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
