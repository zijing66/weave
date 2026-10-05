import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanLibraryPlugins, scanLibrarySkills } from '../scanner.js';

const CC_MANIFEST = JSON.stringify({ name: 'CC Pack', version: '1.2.0' });
const WEAVE_MANIFEST = JSON.stringify({
  manifestVersion: 1,
  id: 'weave-pack',
  name: 'Weave Pack',
  version: '0.1.0',
});

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content);
}

describe('scanLibraryPlugins', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'weave-scanner-plugin-'));

    // CC 原生包 + 包内 skill（双身份）
    await write(path.join(root, 'cc', '.claude-plugin', 'plugin.json'), CC_MANIFEST);
    await write(path.join(root, 'cc', 'skills', 'foo', 'SKILL.md'), '# foo');

    // weave 规则包
    await write(path.join(root, 'weave', 'weave-plugin.json'), WEAVE_MANIFEST);

    // 双 manifest 包
    await write(path.join(root, 'dual', '.claude-plugin', 'plugin.json'), CC_MANIFEST);
    await write(path.join(root, 'dual', 'weave-plugin.json'), WEAVE_MANIFEST);

    // mods-only（无 manifest，仅非空 modules）
    await write(
      path.join(root, 'mods', 'hooks', 'hooks.json'),
      JSON.stringify({ modules: ['./register.tsx'] }),
    );

    // 普通 skill 仓库：裸表面 skills/（不算包）+ .claude 内嵌 skill + 深度超限包
    await write(path.join(root, 'plain', 'skills', 'plain-skill', 'SKILL.md'), '# plain');
    await write(path.join(root, 'plain', '.claude', 'skills', 'inner', 'SKILL.md'), '# inner');
    await write(path.join(root, 'plain', 'a', 'b', 'deep-pack', '.claude-plugin', 'plugin.json'), CC_MANIFEST);

    // 包内嵌套子包（停钻不重复产出）
    await write(path.join(root, 'nested', 'container', '.claude-plugin', 'plugin.json'), CC_MANIFEST);
    await write(path.join(root, 'nested', 'container', 'commands', 'hello.md'), '# hello');
    await write(path.join(root, 'nested', 'container', 'inner', 'weave-plugin.json'), WEAVE_MANIFEST);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('CC 包 → ccPack 且 skills 只收带 SKILL.md 的目录', async () => {
    const packs = await scanLibraryPlugins(path.join(root, 'cc'));
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({
      name: 'CC Pack',
      version: '1.2.0',
      relPath: '',
      ccPack: true,
      weavePack: false,
      skills: ['foo'],
      targets: ['claude'],
    });
    expect(packs[0]!.dirPath).toBe(path.join(root, 'cc'));
  });

  it('weave 包 → weavePack=true / kind=rule', async () => {
    const packs = await scanLibraryPlugins(path.join(root, 'weave'));
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ ccPack: false, weavePack: true, kind: 'rule' });
  });

  it('双 manifest 包 → 两个 flag 皆 true', async () => {
    const packs = await scanLibraryPlugins(path.join(root, 'dual'));
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ ccPack: true, weavePack: true });
  });

  it('mods-only（无 manifest 非空 modules）→ kind=mod，双 flag false', async () => {
    const packs = await scanLibraryPlugins(path.join(root, 'mods'));
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ kind: 'mod', ccPack: false, weavePack: false });
    expect(packs[0]!.components).toContain('mod');
  });

  it('普通仓库（裸表面 skills/、无 manifest）→ 不产 plugin；深度超限包也不产出', async () => {
    const packs = await scanLibraryPlugins(path.join(root, 'plain'));
    expect(packs).toHaveLength(0);
  });

  it('双身份：包内 skill 同时出现在 scanLibrarySkills', async () => {
    const skills = await scanLibrarySkills(path.join(root, 'cc'));
    expect(skills.map((s) => s.name)).toContain('foo');
  });

  it('跳过 .claude：内嵌已安装 skill 不被扫出（钉死回归）', async () => {
    const skills = await scanLibrarySkills(path.join(root, 'plain'));
    const names = skills.map((s) => s.name);
    expect(names).toContain('plain-skill');
    expect(names).not.toContain('inner');
  });

  it('根目录自身即包 → 产出且 relPath 为空串', async () => {
    const packs = await scanLibraryPlugins(path.join(root, 'dual'));
    expect(packs).toHaveLength(1);
    expect(packs[0]!.relPath).toBe('');
  });

  it('包内嵌套子包停钻：只产出外层', async () => {
    const packs = await scanLibraryPlugins(path.join(root, 'nested'));
    expect(packs).toHaveLength(1);
    expect(packs[0]!.relPath).toBe('container');
    expect(packs[0]!.weavePack).toBe(false);
  });
});
