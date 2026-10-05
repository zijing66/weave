import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanLibraryFileAssets, scanLibraryMcp, scanLibraryPlugins, scanLibrarySkills } from '../scanner.js';

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

    // CC 原生包 + 包内 skill（隶属包，见排除用例）
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

    // 普通 skill 仓库：裸表面 skills/（不算包）+ .claude 内嵌 skill + 深度 3 的包（递归应发现）
    await write(path.join(root, 'plain', 'skills', 'plain-skill', 'SKILL.md'), '# plain');
    await write(path.join(root, 'plain', '.claude', 'skills', 'inner', 'SKILL.md'), '# inner');
    await write(path.join(root, 'plain', 'a', 'b', 'deep-pack', '.claude-plugin', 'plugin.json'), CC_MANIFEST);
    await write(path.join(root, 'plain', 'a', 'b', 'deep-pack', 'skills', 'deep-skill', 'SKILL.md'), '# deep');
    await write(path.join(root, 'plain', 'a', 'b', 'deep-pack', 'commands', 'deepcmd.md'), '# deepcmd');
    // 包外的独立文件模板与 mcp 模板（排除后应照旧产出）
    await write(path.join(root, 'plain', 'commands', 'standalone.md'), '# cmd');
    await write(path.join(root, 'plain', 'helper.mcp.json'), JSON.stringify({ command: 'node', args: ['h.js'] }));
    // 包内的文件模板与 mcp 模板（排除后应被收归 plugin，不独立产出）
    await write(path.join(root, 'plain', 'a', 'b', 'deep-pack', 'server.mcp.json'), JSON.stringify({ command: 'node', args: ['s.js'] }));
    // manifest-only 空成分外壳（谓词命中但 parseToolkitPack=null → 不进 plugins，
    // 但必须进 packRoots——壳内嵌套 skill 不得从 skill 区泄漏）
    await write(path.join(root, 'plain', 'shell', '.claude-plugin', 'plugin.json'), CC_MANIFEST);
    await write(path.join(root, 'plain', 'shell', 'nested-skill', 'SKILL.md'), '# shell-nested');

    // 包内嵌套子包（停钻不重复产出）
    await write(path.join(root, 'nested', 'container', '.claude-plugin', 'plugin.json'), CC_MANIFEST);
    await write(path.join(root, 'nested', 'container', 'commands', 'hello.md'), '# hello');
    await write(path.join(root, 'nested', 'container', 'inner', 'weave-plugin.json'), WEAVE_MANIFEST);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('CC 包 → ccPack 且 skills 只收带 SKILL.md 的目录', async () => {
    const { plugins, packRoots } = await scanLibraryPlugins(path.join(root, 'cc'));
    expect(plugins).toHaveLength(1);
    expect(packRoots).toEqual(['']); // 根即包 → 空串排除根
    expect(plugins[0]).toMatchObject({
      name: 'CC Pack',
      version: '1.2.0',
      relPath: '',
      ccPack: true,
      weavePack: false,
      skills: ['foo'],
      targets: ['claude'],
    });
    expect(plugins[0]!.dirPath).toBe(path.join(root, 'cc'));
  });

  it('weave 包 → weavePack=true / kind=rule', async () => {
    const { plugins } = await scanLibraryPlugins(path.join(root, 'weave'));
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ ccPack: false, weavePack: true, kind: 'rule' });
  });

  it('双 manifest 包 → 两个 flag 皆 true', async () => {
    const { plugins } = await scanLibraryPlugins(path.join(root, 'dual'));
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ ccPack: true, weavePack: true });
  });

  it('mods-only（无 manifest 非空 modules）→ kind=mod，双 flag false', async () => {
    const { plugins } = await scanLibraryPlugins(path.join(root, 'mods'));
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ kind: 'mod', ccPack: false, weavePack: false });
    expect(plugins[0]!.components).toContain('mod');
  });

  it('裸表面 skills/（无 manifest）不产 plugin；深度 3+ 的包递归发现（修订：原深度上限 2）', async () => {
    const { plugins } = await scanLibraryPlugins(path.join(root, 'plain'));
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ relPath: 'a/b/deep-pack', ccPack: true, skills: ['deep-skill'] });
  });

  it('空成分外壳包：谓词命中 → packRoots，但 parse 为 null → 不进 plugins（堵 P1 泄漏）', async () => {
    const { plugins, packRoots } = await scanLibraryPlugins(path.join(root, 'plain'));
    expect(packRoots).toContain('shell'); // 排除根照收（修订：原仅收解析成功的包）
    expect(packRoots).toContain('a/b/deep-pack');
    expect(plugins.map((p) => p.relPath)).not.toContain('shell');
    // 外壳子树的 skill 被排除（修订：原停钻与排除解耦，壳内 skill 会泄漏）
    const names = (await scanLibrarySkills(path.join(root, 'plain'), packRoots)).map((s) => s.name);
    expect(names).toContain('plain-skill');
    expect(names).not.toContain('nested-skill');
  });

  it('包内 skill 隶属 plugin：排除根传入后不独立产出，包外 skill 照旧（修订：原「双身份」可独立安装）', async () => {
    const plain = path.join(root, 'plain');
    const { packRoots } = await scanLibraryPlugins(plain);
    const names = (await scanLibrarySkills(plain, packRoots)).map((s) => s.name);
    expect(names).toContain('plain-skill'); // 包外 skill 不受影响
    expect(names).not.toContain('deep-skill'); // 包内 skill 收归 plugin
    expect(names).not.toContain('inner'); // .claude 排除照旧
    // 缺省不排除 = 存量语义（签名加法，行为零变）
    const legacy = await scanLibrarySkills(plain);
    expect(legacy.map((s) => s.name)).toContain('deep-skill');
    // 根即包：空串排除根 → 整库资源全部隶属
    expect(await scanLibrarySkills(path.join(root, 'cc'), [''])).toHaveLength(0);
  });

  it('包内表面成分不产出独立文件模板；包外照旧', async () => {
    const plain = path.join(root, 'plain');
    const { packRoots } = await scanLibraryPlugins(plain);
    const commands = (await scanLibraryFileAssets(plain, packRoots)).command.map((f) => f.name);
    expect(commands).toContain('standalone'); // 包外 commands/ 照旧
    expect(commands).not.toContain('deepcmd'); // 包内 commands/ 收归 plugin
    // 缺省不排除 = 存量语义
    const legacy = (await scanLibraryFileAssets(plain)).command.map((f) => f.name);
    expect(legacy).toContain('deepcmd');
  });

  it('包内 mcp 模板收归 plugin；包外照旧', async () => {
    const plain = path.join(root, 'plain');
    const { packRoots } = await scanLibraryPlugins(plain);
    const names = (await scanLibraryMcp(plain, packRoots)).map((m) => m.name);
    expect(names).toContain('helper'); // 包外 *.mcp.json 照旧
    expect(names).not.toContain('server'); // 包内 *.mcp.json 收归 plugin
  });

  it('跳过 .claude：内嵌已安装 skill 不被扫出（钉死回归）', async () => {
    const skills = await scanLibrarySkills(path.join(root, 'plain'));
    const names = skills.map((s) => s.name);
    expect(names).toContain('plain-skill');
    expect(names).not.toContain('inner');
  });

  it('根目录自身即包 → 产出且 relPath 为空串', async () => {
    const { plugins, packRoots } = await scanLibraryPlugins(path.join(root, 'dual'));
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.relPath).toBe('');
    expect(packRoots).toEqual(['']);
  });

  it('包内嵌套子包停钻：只产出外层', async () => {
    const { plugins, packRoots } = await scanLibraryPlugins(path.join(root, 'nested'));
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.relPath).toBe('container');
    expect(plugins[0]!.weavePack).toBe(false);
    expect(packRoots).toEqual(['container']); // 停钻 → 内层不产出排除根
  });
});
