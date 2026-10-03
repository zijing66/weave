import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const BUILTIN_ROOT = fileURLToPath(
  new URL('../presets/harness-tools/', import.meta.url),
);

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

    const packs = await discoverToolkitPacks({ root, provenance: 'external-dir' });
    const byId = new Map(packs.map((p) => [p.id, p]));
    expect([...byId.keys()].sort()).toEqual(['bare-pack', 'cc-pack', 'weave-pack']);
    expect(byId.get('cc-pack')).toMatchObject({
      ccPack: true,
      weavePack: false,
      kind: 'skill',
      components: ['skill'],
      skills: ['s1'],
      provenance: 'external-dir',
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

  it('内置真实树冒烟：8 个包、scope/类型齐全、md-lint 命中 weave 成分', async () => {
    const packs = await discoverToolkitPacks({ root: BUILTIN_ROOT, provenance: 'builtin' });
    const ids = packs.map((p) => p.id).sort();
    expect(ids).toEqual([
      'code-review',
      'docs-reminder',
      'file-guard',
      'md-lint',
      'mission-control',
      'project-navigation',
      'refactoring',
      'testing',
    ]);
    const byId = new Map(packs.map((p) => [p.id, p]));
    expect(byId.get('code-review')).toMatchObject({
      scope: 'core-skills',
      kind: 'skill',
      targets: ['claude', 'codex'],
      provenance: 'builtin',
    });
    expect(byId.get('md-lint')).toMatchObject({ weavePack: true, kind: 'rule' });
    expect(byId.get('docs-reminder')).toMatchObject({ ccPack: true, kind: 'hook' });
    expect(byId.get('mission-control')).toMatchObject({ kind: 'mod', components: ['mod'] });
    expect(byId.get('file-guard')).toMatchObject({ kind: 'mod', components: ['mod'] });
  });

  it('外置目录镜像内置结构时 scope/字段与内置一致（闸⑤ 扫描面）', async () => {
    const ext = path.join(root, 'ext');
    await cp(BUILTIN_ROOT, ext, { recursive: true });
    const builtin = await discoverToolkitPacks({ root: BUILTIN_ROOT, provenance: 'builtin' });
    const external = await discoverToolkitPacks({ root: ext, provenance: 'external-dir' });
    const strip = (p: (typeof builtin)[0]) => {
      const { provenance: _p, sourceRoot: _s, dir: _d, ...rest } = p;
      return rest;
    };
    expect(external.map(strip).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      builtin.map(strip).sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
