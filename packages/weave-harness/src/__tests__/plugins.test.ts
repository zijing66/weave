import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createClaudePluginSurface,
  WEAVE_MARKETPLACE,
  type PluginExecutor,
} from '../claude/plugins';

/**
 * 批 3：PluginSurface 单测——临时目录 mock home/env，CLI 走可注入假 executor
 * （断言参数数组），文件系统断言走真实读写。
 */

let home: string;
let project: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let calls: string[][];
let execHandler: PluginExecutor;
let surface: ReturnType<typeof createClaudePluginSurface>;

const installedFile = (): string => path.join(home, '.claude', 'plugins', 'installed_plugins.json');
const settingsFile = (): string => path.join(home, '.claude', 'settings.json');
const mktRoot = (): string => path.join(home, '.claude', 'weave-marketplace');
const projectSettings = (): string => path.join(project, '.claude', 'settings.json');

const writeInstalled = async (plugins: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(installedFile()), { recursive: true });
  await writeFile(installedFile(), JSON.stringify({ version: 2, plugins }, null, 2));
};

const makePack = async (name: string): Promise<string> => {
  const dir = path.join(home, 'packs', name);
  await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.2.3' }),
  );
  await mkdir(path.join(dir, 'hooks'), { recursive: true });
  await writeFile(path.join(dir, 'hooks', 'h.js'), '// hook\n');
  return dir;
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'weave-ps-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'weave-ps-proj-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  calls = [];
  execHandler = async () => ({ stdout: '', stderr: '' });
  surface = createClaudePluginSurface({
    exec: (args, opts) => {
      calls.push(args);
      return execHandler(args, opts);
    },
  });
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

describe('路径与 installed 判定', () => {
  it('projectPluginDir 落 <project>/.claude/plugins（绝对路径）', () => {
    expect(surface.projectPluginDir(project)).toBe(path.join(project, '.claude', 'plugins'));
  });

  it('readInstalled 缺失文件 → 空对象；isInstalled 全 false', async () => {
    expect(await surface.readInstalled()).toEqual({});
    expect(await surface.isInstalled('demo')).toBe(false);
  });

  it('isInstalled 只认 name@weave 键（H5 key 形态）', async () => {
    await writeInstalled({
      'demo@weave': [{ scope: 'user', installPath: '/cache/demo/1.2.3', version: '1.2.3' }],
      'other@elsewhere': [{ scope: 'user', version: '9.9.9' }],
    });
    expect(await surface.isInstalled('demo')).toBe(true);
    expect(await surface.isInstalled('other')).toBe(false);
    expect(await surface.isInstalled('nope')).toBe(false);
    const all = await surface.readInstalled();
    expect(all['demo@weave']?.[0]).toMatchObject({ version: '1.2.3' });
  });
});

describe('enabledPlugins 读写（项目 + 全局）', () => {
  it('setProjectEnabled 保留其余键、逐键 merge，缺省 false', async () => {
    await mkdir(path.dirname(projectSettings()), { recursive: true });
    await writeFile(
      projectSettings(),
      JSON.stringify({ model: 'sonnet', hooks: { Stop: [] }, enabledPlugins: { 'x@mk': true } }),
    );
    await surface.setProjectEnabled(project, 'demo', true);
    await surface.setProjectEnabled(project, 'other', false);

    const json = JSON.parse(await readFile(projectSettings(), 'utf8'));
    expect(json.model).toBe('sonnet');
    expect(json.hooks).toEqual({ Stop: [] });
    expect(json.enabledPlugins).toEqual({ 'x@mk': true, 'demo@weave': true, 'other@weave': false });

    expect(await surface.readProjectEnabled(project, 'demo')).toBe(true);
    expect(await surface.readProjectEnabled(project, 'other')).toBe(false);
    expect(await surface.readProjectEnabled(project, 'x')).toBe(false);
  });

  it('项目无 .claude 目录时创建', async () => {
    await surface.setProjectEnabled(project, 'demo', true);
    expect(await surface.readProjectEnabled(project, 'demo')).toBe(true);
  });

  it('readGlobalEnabled 过滤非布尔，writeGlobalEnabled 保留其余键（迁移行为）', async () => {
    await mkdir(path.dirname(settingsFile()), { recursive: true });
    await writeFile(
      settingsFile(),
      JSON.stringify({ model: 'sonnet', enabledPlugins: { 'a@mk': true, 'bad@mk': 'x' } }),
    );
    expect(await surface.readGlobalEnabled()).toEqual({ 'a@mk': true });
    await surface.writeGlobalEnabled('b@mk', false);
    const json = JSON.parse(await readFile(settingsFile(), 'utf8'));
    expect(json.model).toBe('sonnet');
    expect(json.enabledPlugins).toEqual({ 'a@mk': true, 'bad@mk': 'x', 'b@mk': false });
  });
});

describe('globalInstall（两步 CLI 链，幂等）', () => {
  it('未装：同步 weave marketplace → marketplace add → install name@weave --scope user', async () => {
    const pack = await makePack('demo');
    const info = await surface.globalInstall(pack);

    expect(info).toEqual({ key: `demo@${WEAVE_MARKETPLACE}`, alreadyInstalled: false });
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'add', mktRoot()],
      ['plugin', 'install', `demo@${WEAVE_MARKETPLACE}`, '--scope', 'user', '--json'],
    ]);
    expect(calls.every((args) => args.length > 0)).toBe(true);

    const mkt = JSON.parse(
      await readFile(path.join(mktRoot(), '.claude-plugin', 'marketplace.json'), 'utf8'),
    );
    expect(mkt.name).toBe(WEAVE_MARKETPLACE);
    expect(mkt.owner).toBeTruthy();
    expect(mkt.plugins).toEqual([{ name: 'demo', source: './plugins/demo' }]);
    // 包拷贝进目录源（相对 source 可解析）
    const copied = JSON.parse(
      await readFile(path.join(mktRoot(), 'plugins', 'demo', '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    expect(copied.name).toBe('demo');
  });

  it('第二个包 upsert 同一 marketplace（保留已有条目）', async () => {
    await surface.globalInstall(await makePack('demo'));
    await surface.globalInstall(await makePack('second'));
    const mkt = JSON.parse(
      await readFile(path.join(mktRoot(), '.claude-plugin', 'marketplace.json'), 'utf8'),
    );
    expect(mkt.plugins).toEqual([
      { name: 'demo', source: './plugins/demo' },
      { name: 'second', source: './plugins/second' },
    ]);
    expect(calls.filter((args) => args[1] === 'install')).toHaveLength(2);
  });

  it('无 manifest 包（opts.name）：marketplace 目标副本合成最小 plugin.json，不写源目录；有 manifest 不覆盖', async () => {
    const src = path.join(home, 'packs', 'bare-mod');
    await mkdir(path.join(src, 'hooks'), { recursive: true });
    await writeFile(path.join(src, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.tsx'] }, null, 2));

    const info = await surface.globalInstall(src, { name: 'bare-mod', version: '1.4.0', description: 'desc' });
    expect(info.key).toBe(`bare-mod@${WEAVE_MARKETPLACE}`);
    const synthesized = JSON.parse(
      await readFile(path.join(mktRoot(), 'plugins', 'bare-mod', '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(synthesized).toEqual({ name: 'bare-mod', version: '1.4.0', description: 'desc' });
    // 源目录保持无 manifest（只写目标副本）
    await expect(readFile(path.join(src, '.claude-plugin', 'plugin.json'), 'utf8')).rejects.toThrow();

    // 缺省 version → '0.0.0'
    const src2 = path.join(home, 'packs', 'bare-two');
    await mkdir(path.join(src2, 'hooks'), { recursive: true });
    await writeFile(path.join(src2, 'hooks', 'hooks.json'), JSON.stringify({ modules: [] }, null, 2));
    await surface.globalInstall(src2, { name: 'bare-two' });
    const two = JSON.parse(
      await readFile(path.join(mktRoot(), 'plugins', 'bare-two', '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(two).toEqual({ name: 'bare-two', version: '0.0.0' });

    // 有 manifest 的包零行为变化：原 manifest 保留（opts.version 不覆盖）
    await surface.globalInstall(await makePack('demo'), { name: 'demo', version: '9.9.9' });
    const demo = JSON.parse(
      await readFile(path.join(mktRoot(), 'plugins', 'demo', '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { version?: string };
    expect(demo.version).toBe('1.2.3');
  });

  it('已装幂等：直接返回安装信息，不 spawn CLI', async () => {
    await writeInstalled({
      'demo@weave': [
        { scope: 'user', installPath: '/cache/demo/1.2.3', version: '1.2.3' },
      ],
    });
    const info = await surface.globalInstall(await makePack('demo'));
    expect(info).toEqual({
      key: 'demo@weave',
      alreadyInstalled: true,
      scope: 'user',
      installPath: '/cache/demo/1.2.3',
      version: '1.2.3',
    });
    expect(calls).toEqual([]);
  });

  it('install 输出 outcome=failed → 抛 message；超长输出截断', async () => {
    const pack = await makePack('demo');
    execHandler = async (args) =>
      args[1] === 'install'
        ? { stdout: JSON.stringify({ outcome: 'failed', message: 'x'.repeat(5000) }), stderr: '' }
        : { stdout: '', stderr: '' };
    await expect(surface.globalInstall(pack)).rejects.toThrow(/xxxxx/);
    const err = await surface.globalInstall(pack).catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThanOrEqual(2100);
  });

  it('CLI 执行失败向上传播，且 timeoutMs 注入到 executor', async () => {
    const pack = await makePack('demo');
    let seenTimeout = 0;
    execHandler = async (_args, opts) => {
      seenTimeout = opts.timeoutMs;
      throw new Error('spawn ENOENT');
    };
    await expect(surface.globalInstall(pack)).rejects.toThrow('spawn ENOENT');
    expect(seenTimeout).toBeGreaterThan(0);
  });

  it('manifest 缺 name → 拒绝', async () => {
    const dir = path.join(home, 'broken');
    await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
    await writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), '{}');
    await expect(surface.globalInstall(dir)).rejects.toThrow(/missing name/);
    expect(calls).toEqual([]);
  });
});
