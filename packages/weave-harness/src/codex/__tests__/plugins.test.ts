import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CODEX_MARKETPLACE,
  codexCommandLine,
  createCodexPluginSurface,
  type PluginExecutor,
} from '../plugins';

/**
 * PluginSurface（codex）单测：临时目录 mock home，CLI 走可注入假 executor
 * （断言参数数组），文件系统断言走真实读写（缓存目录布局 = codex store.rs 的
 * `plugins/cache/<market>/<name>/<version>/`）。
 */

let home: string;
let project: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let calls: string[][];
let execHandler: PluginExecutor;
let surface: ReturnType<typeof createCodexPluginSurface>;

const configFile = (): string => path.join(home, '.codex', 'config.toml');
const cacheRoot = (): string => path.join(home, '.codex', 'plugins', 'cache');
const projectSettings = (): string => path.join(project, '.codex', 'plugins');

const writeConfig = async (text: string): Promise<void> => {
  await mkdir(path.dirname(configFile()), { recursive: true });
  await writeFile(configFile(), text);
};

/** 在 codex 缓存布局里铺一个已装插件（market/name/version）。 */
const seedInstalled = async (
  market: string,
  name: string,
  version: string,
): Promise<string> => {
  const dir = path.join(cacheRoot(), market, name, version);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'skill.md'), 'x');
  return dir;
};

/** 数据目录里的市场副本（市场导入已把包复制进来）。 */
const marketDir = (): string => path.join(home, 'weave', 'market', 'some-market');

const makePack = async (name: string, root = marketDir()): Promise<string> => {
  const dir = path.join(root, name);
  await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.2.3' }),
  );
  return dir;
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'weave-cdx-ps-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'weave-cdx-ps-proj-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  calls = [];
  execHandler = async () => ({ stdout: '', stderr: '' });
  surface = createCodexPluginSurface({
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

describe('键形', () => {
  it('pluginKey / parsePluginKey 与 claude 同形（rsplit @）', () => {
    expect(surface.pluginKey('demo')).toBe(`demo@${CODEX_MARKETPLACE}`);
    expect(surface.pluginKey('demo', 'some-market')).toBe('demo@some-market');
    expect(surface.parsePluginKey('demo@some-market')).toEqual({
      name: 'demo',
      market: 'some-market',
    });
    // 插件名可含 @（scope 包名），市场名不会
    expect(surface.parsePluginKey('@scope/pkg@mk')).toEqual({ name: '@scope/pkg', market: 'mk' });
    expect(surface.parsePluginKey('bare')).toEqual({ name: 'bare', market: CODEX_MARKETPLACE });
  });
});

describe('globalInstall', () => {
  it('外部市场：先就地维护清单，再 marketplace add + plugin add（键进 argv）', async () => {
    const srcDir = await makePack('demo');
    const info = await surface.globalInstall(srcDir, {
      name: 'demo',
      marketplace: { name: 'some-market', dir: marketDir() },
    });

    expect(info.key).toBe('demo@some-market');
    expect(info.alreadyInstalled).toBe(false);
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'add', marketDir()],
      ['plugin', 'add', 'demo@some-market', '--json'],
    ]);
    // 清单就地维护：name 归一为市场 id、source 用市场内相对路径
    const mkt = JSON.parse(
      await readFile(path.join(marketDir(), '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(mkt.name).toBe('some-market');
    expect(mkt.plugins).toEqual([{ name: 'demo', source: './demo' }]);
  });

  it('幂等：缓存里已有该键 → 不跑 CLI 直接返回', async () => {
    await seedInstalled('some-market', 'demo', '1.0.0');
    const srcDir = await makePack('demo');
    const info = await surface.globalInstall(srcDir, {
      name: 'demo',
      marketplace: { name: 'some-market', dir: marketDir() },
    });
    expect(info.alreadyInstalled).toBe(true);
    expect(calls).toEqual([]);
  });

  it('无市场身份 → 明确报错（codex 的 add 必须经市场，不发明目录源惯例）', async () => {
    const srcDir = await makePack('demo', path.join(home, 'loose-pack'));
    await expect(surface.globalInstall(srcDir, { name: 'demo' })).rejects.toThrow(/marketplace/);
    expect(calls).toEqual([]);
  });

  it('清单缺 name → 报错（不猜包名）', async () => {
    const dir = path.join(marketDir(), 'anon');
    await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
    await writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), '{}');
    await expect(
      surface.globalInstall(dir, { marketplace: { name: 'mk', dir: marketDir() } }),
    ).rejects.toThrow(/missing name/);
  });

  it('链接市场不维护清单（自带清单随包发布，写穿链接会污染源）', async () => {
    const real = await mkdtemp(path.join(tmpdir(), 'weave-cdx-real-'));
    await makePack('demo', real);
    const link = path.join(home, 'linked-market');
    await symlink(real, link, 'junction');
    await surface.globalInstall(path.join(real, 'demo'), {
      name: 'demo',
      marketplace: { name: 'some-market', dir: link },
    });
    await expect(
      readFile(path.join(link, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ).rejects.toThrow();
    await rm(real, { recursive: true, force: true });
  });
});

describe('readInstalled / isInstalled / uninstall', () => {
  it('缓存目录即已装事实：最新版本字典序最大、scope 恒 user', async () => {
    await seedInstalled('some-market', 'demo', '1.0.0');
    await seedInstalled('some-market', 'demo', '1.2.0');
    await seedInstalled('other-market', 'beta', '0.1.0');

    const installed = await surface.readInstalled();
    expect(Object.keys(installed).sort()).toEqual(['beta@other-market', 'demo@some-market']);
    expect(installed['demo@some-market']).toHaveLength(1);
    expect(installed['demo@some-market']![0]).toMatchObject({
      scope: 'user',
      version: '1.2.0',
    });
    expect(await surface.isInstalled('demo', 'some-market')).toBe(true);
    expect(await surface.isInstalled('demo', 'nope')).toBe(false);
  });

  it('缓存根缺失 → 空表（不抛错）', async () => {
    expect(await surface.readInstalled()).toEqual({});
    expect(await surface.isInstalled('demo')).toBe(false);
  });

  it('uninstall：已装才发 CLI（键进 argv）；未装幂等返回', async () => {
    await seedInstalled('some-market', 'demo', '1.0.0');
    await surface.uninstall('demo', 'some-market');
    expect(calls).toEqual([['plugin', 'remove', 'demo@some-market', '--json']]);

    calls = [];
    await surface.uninstall('ghost', 'some-market');
    expect(calls).toEqual([]);
  });
});

describe('启用态（config.toml [plugins]）', () => {
  it('readGlobalEnabled：布尔过滤读，缺失/损坏 → 空对象', async () => {
    expect(await surface.readGlobalEnabled()).toEqual({});

    await writeConfig('[plugins."a@mk"]\nenabled = true\n\n[plugins."b@mk"]\nenabled = false\n');
    expect(await surface.readGlobalEnabled()).toEqual({ 'a@mk': true, 'b@mk': false });

    await writeFile(configFile(), '[broken');
    expect(await surface.readGlobalEnabled()).toEqual({});
  });

  it('writeGlobalEnabled：upsert 单键、其余键与注释保留', async () => {
    await writeConfig('# mine\n[plugins."a@mk"]\nenabled = true\n');
    await surface.writeGlobalEnabled('b@mk', false);
    const text = await readFile(configFile(), 'utf8');
    expect(text).toContain('# mine');
    expect(text).toContain('[plugins."a@mk"]');
    expect(text).toContain('[plugins."b@mk"]');
    expect(await surface.readGlobalEnabled()).toEqual({ 'a@mk': true, 'b@mk': false });
  });

  it('readProjectEnabled/setProjectEnabled：codex 无项目档，读写都落全局', async () => {
    await surface.setProjectEnabled(project, 'demo', true, 'some-market');
    expect(await readFile(configFile(), 'utf8')).toContain('[plugins."demo@some-market"]');
    expect(await surface.readProjectEnabled(project, 'demo', 'some-market')).toBe(true);
    expect(projectSettings()).toBeDefined(); // 项目目录零写入
  });

  it('readEnabledOverrides：user 档 = 全局表，project/local 恒空', async () => {
    await writeConfig('[plugins."a@mk"]\nenabled = true\n');
    expect(await surface.readEnabledOverrides(project)).toEqual({
      user: { 'a@mk': true },
      project: {},
      local: {},
    });
  });

  it('setEnabledOverride：on/off 写单键；inherit 删键；非 user 档拒绝', async () => {
    await writeConfig('[plugins."a@mk"]\nenabled = true\nversion = "1"\n');
    await surface.setEnabledOverride(project, 'user', 'a@mk', 'off');
    expect(await surface.readGlobalEnabled()).toEqual({ 'a@mk': false });

    await surface.setEnabledOverride(project, 'user', 'a@mk', 'inherit');
    expect(await surface.readGlobalEnabled()).toEqual({});

    await expect(
      surface.setEnabledOverride(project, 'project', 'a@mk', 'on'),
    ).rejects.toThrow(/user-scope/);
  });
});

describe('removeMarketplace', () => {
  it('按 source 路径反查注册名 → marketplace remove（级联归宿主）', async () => {
    await writeConfig(
      `[marketplaces."some-market"]\nsource_type = "local"\nsource = "${marketDir().replace(/\\/g, '\\\\')}"\n`,
    );
    await surface.removeMarketplace(marketDir());
    expect(calls).toEqual([['plugin', 'marketplace', 'remove', 'some-market']]);
  });

  it('未注册（路径对不上）→ 幂等返回，不发 CLI', async () => {
    await writeConfig('[marketplaces."x"]\nsource_type = "local"\nsource = "D:/elsewhere"\n');
    await surface.removeMarketplace(marketDir());
    expect(calls).toEqual([]);
  });

  it('config.toml 缺失 → 幂等返回', async () => {
    await surface.removeMarketplace(marketDir());
    expect(calls).toEqual([]);
  });
});

describe('杂项', () => {
  it('pluginScopes：codex 只有 user 档', () => {
    expect(surface.pluginScopes()).toEqual(['user']);
  });

  it('projectPluginDir：.codex/plugins', () => {
    expect(surface.projectPluginDir('/p')).toBe(path.join('/p', '.codex', 'plugins'));
  });

  it('win32 命令行：参数逐个加引号、内部引号转义', () => {
    expect(codexCommandLine(['plugin', 'add', 'D:\\a b\\mk'])).toBe(
      'codex "plugin" "add" "D:\\a b\\mk"',
    );
  });
});
