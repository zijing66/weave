import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { templateRegistry } from '@weavecode/templates';
import { registerPluginTemplates, collectPluginMcpServers } from '../init/plugin-templates.js';

// templateRegistry 是模块级单例：用唯一 id 避免跨用例同名冲突。
let root: string;
let projectDir: string;
let uid: number;

async function writePlugin(id: string, templates: Record<string, string[]>): Promise<void> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'weave-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      templates,
    }),
  );
  if (templates.skills?.length) {
    const skillDir = path.join(dir, templates.skills[0]);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');
  }
  if (templates.commands?.length) {
    await mkdir(path.dirname(path.join(dir, templates.commands[0])), { recursive: true });
    await writeFile(path.join(dir, templates.commands[0]), '# Cmd');
  }
}

describe('registerPluginTemplates（扩展点③发现面）', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'weave-pt-'));
    projectDir = await mkdtemp(path.join(tmpdir(), 'weave-proj-'));
    uid = Date.now();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('扫描 manifest.templates 并注册（name = pluginId:模板名，绝对 sourcePath）', async () => {
    const id = `pt-a-${uid}`;
    await writePlugin(id, { skills: ['skills/my-skill'], commands: ['commands/my-cmd.md'] });

    const { registered, skipped } = await registerPluginTemplates(projectDir, root);
    expect(skipped).toHaveLength(0);
    expect(registered.map((e) => e.name).sort()).toEqual([`${id}:my-cmd`, `${id}:my-skill`]);

    const skill = templateRegistry.getByName(`${id}:my-skill`);
    expect(skill).toMatchObject({ category: 'skill' });
    expect(path.isAbsolute(skill!.sourcePath)).toBe(true);
    expect(templateRegistry.resolvePath(skill!)).toBe(skill!.sourcePath);

    const cmd = templateRegistry.getByName(`${id}:my-cmd`);
    expect(cmd).toMatchObject({ category: 'command' });
  });

  it('路径越界的模板被跳过；同名二次注册被拒绝', async () => {
    const id = `pt-b-${uid}`;
    await writePlugin(id, { commands: ['commands/ok.md'] });
    // 手工加一条越界引用
    const manifestPath = path.join(root, id, 'weave-plugin.json');
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
    manifest.templates.commands.push('../../../evil.md');
    await writeFile(manifestPath, JSON.stringify(manifest));

    const first = await registerPluginTemplates(projectDir, root);
    expect(first.registered.map((e) => e.name)).toEqual([`${id}:ok`]);
    expect(first.skipped.some((s) => s.includes('evil'))).toBe(true);

    // 二次调用（幂等场景）：同名已注册 → 进 skipped
    const second = await registerPluginTemplates(projectDir, root);
    expect(second.registered).toHaveLength(0);
    expect(second.skipped).toContain(`${id}:ok`);
  });

  it('非插件目录（无 manifest）与坏 manifest 静默跳过', async () => {
    await mkdir(path.join(root, 'not-a-plugin'), { recursive: true });
    await mkdir(path.join(root, 'broken'), { recursive: true });
    await writeFile(path.join(root, 'broken', 'weave-plugin.json'), '{ bad json');

    const { registered, skipped } = await registerPluginTemplates(projectDir, root);
    expect(registered).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });
});

describe('collectPluginMcpServers（扩展点④发现面）', () => {
  let root: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'weave-mcp-'));
    projectDir = await mkdtemp(path.join(tmpdir(), 'weave-mcp-proj-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('收集插件 mcpServers；与核心( existing )或插件间同名时 namespace 化', async () => {
    const write = async (id: string, servers: Record<string, unknown>): Promise<void> => {
      const dir = path.join(root, id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'weave-plugin.json'),
        JSON.stringify({ manifestVersion: 1, id, name: id, version: '1.0.0', mcpServers: servers }),
      );
    };
    await write('mcp-a', { 'my-server': { command: 'node', args: ['a.js'] } });
    await write('mcp-b', { 'my-server': { command: 'node', args: ['b.js'] } });

    // existing = 核心已生成的 server 名（同名绝不覆盖核心）
    const { servers, renamed } = await collectPluginMcpServers(projectDir, root, ['my-server']);
    expect(Object.keys(servers).sort()).toEqual(['mcp-a-my-server', 'mcp-b-my-server']);
    expect(renamed).toEqual([
      'my-server → mcp-a-my-server',
      'my-server → mcp-b-my-server',
    ]);
    expect(servers['mcp-a-my-server']).toEqual({ command: 'node', args: ['a.js'] });
    expect(servers['mcp-b-my-server']).toEqual({ command: 'node', args: ['b.js'] });

    // 无冲突时不改名（字典序：mcp-b-my-server < my-server）
    const clean = await collectPluginMcpServers(projectDir, root, []);
    expect(Object.keys(clean.servers).sort()).toEqual(['mcp-b-my-server', 'my-server']);
    expect(clean.renamed).toEqual(['my-server → mcp-b-my-server']);
  });

  it('无 mcpServers / 非法 manifest 的插件被跳过', async () => {
    const dir = path.join(root, 'plain');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'weave-plugin.json'),
      JSON.stringify({ manifestVersion: 1, id: 'plain', name: 'p', version: '1.0.0' }),
    );
    const { servers, renamed } = await collectPluginMcpServers(projectDir, root);
    expect(servers).toEqual({});
    expect(renamed).toEqual([]);
  });
});
