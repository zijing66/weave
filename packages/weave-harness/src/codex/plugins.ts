import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  GlobalInstallOptions,
  InstalledPluginRecord,
  MarketplaceRef,
  PluginInstallInfo,
  PluginSurface,
} from '../driver.js';
import { CODEX_ASSETS } from './assets.js';
import {
  parseSectionEntries,
  removeTomlSection,
  splitTomlSections,
  upsertCodexPluginEnabledInText,
} from './toml.js';

/**
 * Codex 插件安装与市场面（0.163 实测 + 源码核对，docs/DECISIONS.md 2026-10-21）：
 * - 安装 = `codex plugin add <name>@<market>`（CLI 内部：按名查已配置市场 → 整目录
 *   复制进 `~/.codex/plugins/cache/<market>/<name>/<version>/` → 自动写
 *   `[plugins."<key>"] enabled = true`）；卸载 = `codex plugin remove <key>`
 *   （删缓存目录，**不级联**、不动市场注册）。
 * - 市场注册 = `codex plugin marketplace add <本地目录>`：本地源**不复制**，config.toml
 *   记 `[marketplaces."<name>"] source_type="local" source=<目录>`，根 = 目录本身；
 *   市场名取自清单 `name` 字段（weave 的 `ensureMarketManifest` 已把 name 写成市场
 *   id，恰好对上）。注销 = `marketplace remove <name>`（删 config 条目 + `.tmp/
 *   marketplaces/<name>` 安装根；本地源无安装根）。
 * - 清单落点 codex 认 `.claude-plugin/marketplace.json`（与 claude 同一份，零额外
 *   维护）；插件清单认 `.claude-plugin/plugin.json`（`DISCOVERABLE_PLUGIN_MANIFEST_
 *   PATHS` 第二项）。
 * - 键形 `<name>@<marketplace>` 与 claude 的 `pluginKey` 同形（`PluginId::parse`
 *   = `rsplit_once('@')`），直接复用同一拼装/拆解规则。
 * - 读侧不走 CLI（`plugin list --json` 会拉远端目录、慢且可能联网）：已装 = 缓存
 *   目录 `<market>/<name>/<version>/` 存在；启用态 = config.toml `[plugins]`（与
 *   pluginState 槽同一份事实）。
 */
export const CODEX_MARKETPLACE = 'weave';
const CLI_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 2_000;
const OUTPUT_KEEP = 64 * 1024;

export interface PluginExecResult {
  stdout: string;
  stderr: string;
}

/** CLI 执行器（可注入测试）；失败 reject。 */
export type PluginExecutor = (
  args: string[],
  opts: { timeoutMs: number },
) => Promise<PluginExecResult>;

/**
 * codex CLI 的可直接 spawn 入口。win32 的 `codex` 是 npm `.cmd` 垫片
 * （CreateProcess 不认），经 ComSpec 转发并自行拼命令行（与 claude/plugins.ts
 * 同一手艺：不用 `shell: true`，Node 的二次转义会吃掉路径反斜杠）。
 */
export function codexCommandLine(args: string[]): string {
  return ['codex', ...args.map((a) => `"${a.replace(/"/g, '\\"')}"`)].join(' ');
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  child.kill('SIGKILL');
}

function truncate(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}…` : text;
}

const execCli: PluginExecutor = (args, opts) =>
  new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const child = spawn(
      win ? process.env['ComSpec'] || 'cmd.exe' : 'codex',
      win ? ['/d', '/s', '/c', codexCommandLine(args)] : args,
      {
        windowsHide: true,
        windowsVerbatimArguments: win,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const label = `codex ${args.join(' ')}`;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(truncate(message)));
    };
    const timer = setTimeout(() => {
      killTree(child);
      fail(`${label}: timed out after ${opts.timeoutMs}ms`);
    }, opts.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_KEEP) stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < OUTPUT_KEEP) stderr += chunk;
    });
    child.on('error', (err) => fail(`${label}: ${err.message}`));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = [stderr, stdout].filter(Boolean).join('\n').trim() || `exit ${code}`;
      reject(new Error(truncate(`${label}: ${detail}`)));
    });
  });

export function createCodexPluginSurface(deps: { exec?: PluginExecutor } = {}): PluginSurface {
  const exec = deps.exec ?? execCli;
  const run = (args: string[]): Promise<PluginExecResult> =>
    exec(args, { timeoutMs: CLI_TIMEOUT_MS });

  const configFile = (): string => CODEX_ASSETS.userConfigFile(homedir());
  const cacheRoot = (): string => path.join(homedir(), '.codex', 'plugins', 'cache');
  const pluginKey = (name: string, market?: string): string =>
    `${name}@${market ?? CODEX_MARKETPLACE}`;

  /** config.toml 读：缺失 → null；存在但不可解析 → 抛错（写侧同判据，不盲写）。 */
  const readConfigText = async (): Promise<string | null> => {
    try {
      return await readFile(configFile(), 'utf8');
    } catch {
      return null;
    }
  };

  /** `[plugins."<key>"]` 段的布尔 enabled 过滤读（缺失/损坏 → 空对象）。 */
  const readEnabledMap = (text: string | null): Record<string, boolean> => {
    if (!text) return {};
    const sections = splitTomlSections(text);
    const out: Record<string, boolean> = {};
    for (const section of sections) {
      if (!section.key || section.key.length !== 2 || section.key[0] !== 'plugins') continue;
      for (const [k, rawLine] of parseSectionEntries(section.lines.slice(1))) {
        if (k !== 'enabled') continue;
        const v = rawLine.split('=')[1]?.trim();
        if (v === 'true' || v === 'false') out[section.key[1]!] = v === 'true';
      }
    }
    return out;
  };

  /** 已装插件：缓存目录 `<market>/<name>/<version>/` 存在即一条记录（scope 恒 user）。 */
  const readInstalled = async (): Promise<Record<string, InstalledPluginRecord[]>> => {
    const root = cacheRoot();
    const out: Record<string, InstalledPluginRecord[]> = {};
    let markets;
    try {
      markets = await readdir(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const market of markets) {
      if (!market.isDirectory() && !market.isSymbolicLink()) continue;
      const marketDir = path.join(root, market.name);
      let plugins;
      try {
        plugins = await readdir(marketDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const plugin of plugins) {
        if (!plugin.isDirectory() && !plugin.isSymbolicLink()) continue;
        const pluginDir = path.join(marketDir, plugin.name);
        let versions;
        try {
          versions = await readdir(pluginDir, { withFileTypes: true });
        } catch {
          continue;
        }
        const versionDirs = versions.filter((v) => v.isDirectory() || v.isSymbolicLink());
        if (versionDirs.length === 0) continue;
        // 最新版本 = 字典序最大（semver-ish，与 server 的 readCodexPluginSkills 同口径）
        const newest = versionDirs.map((v) => v.name).sort().pop()!;
        const key = `${plugin.name}@${market.name}`;
        out[key] = [{ scope: 'user', installPath: path.join(pluginDir, newest), version: newest }];
      }
    }
    return out;
  };

  const infoOf = (key: string, records: InstalledPluginRecord[] | undefined, alreadyInstalled: boolean): PluginInstallInfo => {
    const rec = records?.[records.length - 1];
    return {
      key,
      alreadyInstalled,
      ...(rec?.scope ? { scope: rec.scope } : {}),
      ...(rec?.installPath ? { installPath: rec.installPath } : {}),
      ...(rec?.version ? { version: rec.version } : {}),
    };
  };

  /**
   * 外部市场包：市场目录（`<dataDir>/market/<id>`）就地维护一份 codex 认的清单
   * （`.claude-plugin/marketplace.json`，与 claude 共用同一份文件——codex 的
   * `MARKETPLACE_MANIFEST_RELATIVE_PATHS` 第三项就是它）。链接市场自带清单，不动。
   */
  const ensureMarketManifest = async (
    market: MarketplaceRef,
    name: string,
    srcDir: string,
  ): Promise<void> => {
    if (!market.dir) throw new Error(`marketplace dir required for ${name}@${market.name}`);
    if ((await lstat(market.dir)).isSymbolicLink()) return;
    const file = path.join(market.dir, '.claude-plugin', 'marketplace.json');
    let mkt: Record<string, unknown> = {};
    try {
      mkt = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      mkt = {};
    }
    const plugins = Array.isArray(mkt.plugins)
      ? [...(mkt.plugins as Array<Record<string, unknown>>)]
      : [];
    const source = `./${path.relative(market.dir, srcDir).split(path.sep).join('/')}`;
    const entry = { name, source };
    const idx = plugins.findIndex((p) => p?.['name'] === name);
    if (idx >= 0) plugins[idx] = entry;
    else plugins.push(entry);
    mkt.name = market.name;
    if (!mkt.owner) mkt.owner = { name: 'weave' };
    mkt.plugins = plugins;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(mkt, null, 2)}\n`, 'utf8');
  };

  return {
    projectPluginDir: (projectPath) => path.join(projectPath, '.codex', 'plugins'),
    pluginKey,

    parsePluginKey(key: string) {
      // 与 claude 同规则：lastIndexOf('@')，插件名可含 `@`、市场名不会。
      const at = key.lastIndexOf('@');
      return at > 0
        ? { name: key.slice(0, at), market: key.slice(at + 1) }
        : { name: key, market: CODEX_MARKETPLACE };
    },

    async globalInstall(srcDir: string, opts: GlobalInstallOptions = {}) {
      let name = opts.name;
      if (!name) {
        try {
          const manifest = JSON.parse(
            await readFile(path.join(srcDir, '.claude-plugin', 'plugin.json'), 'utf8'),
          ) as Record<string, unknown>;
          name = typeof manifest.name === 'string' ? manifest.name : undefined;
        } catch {
          name = undefined;
        }
      }
      if (!name) throw new Error(`plugin manifest missing name: ${srcDir}`);
      const market = opts.marketplace;
      const key = pluginKey(name, market?.name);

      const existing = (await readInstalled())[key];
      if (existing && existing.length > 0) return infoOf(key, existing, true);

      if (market) {
        await ensureMarketManifest(market, name, srcDir);
        await run(['plugin', 'marketplace', 'add', market.dir ?? '']);
      } else {
        // weave 自建市场：codex 没有目录源惯例，包目录就地当市场注册
        // （清单由 ensureMarketManifest 维护在包上层——这里没有上层，退化为
        // 直接注册包目录所在的市场副本；无市场身份的包走 server 的内置市场）。
        throw new Error(
          `codex plugin install requires a marketplace (got none for ${key}); ` +
            'weave-managed packs must come from a market directory',
        );
      }
      await run(['plugin', 'add', key, '--json']);
      return infoOf(key, (await readInstalled())[key], false);
    },

    readInstalled,

    async isInstalled(name, market) {
      const records = (await readInstalled())[pluginKey(name, market)];
      return !!records && records.length > 0;
    },

    async uninstall(name, market) {
      const key = pluginKey(name, market);
      const existing = (await readInstalled())[key];
      if (!existing || existing.length === 0) return;
      // codex 无 scope：单条 CLI 卸载（删缓存目录；市场注册保留可重装）
      await run(['plugin', 'remove', key, '--json']);
    },

    async removeMarketplace(marketDirPath) {
      // 注册名只存在于 config.toml 的 `[marketplaces]`（目录名不作依据）；
      // 按落点路径精确反查，查不到 = 未注册 → 幂等返回。
      const text = await readConfigText();
      if (!text) return;
      const want = path.resolve(marketDirPath);
      const sections = splitTomlSections(text);
      let name: string | undefined;
      for (const section of sections) {
        if (!section.key || section.key.length !== 2 || section.key[0] !== 'marketplaces') continue;
        for (const [k, rawLine] of parseSectionEntries(section.lines.slice(1))) {
          if (k !== 'source') continue;
          const v = rawLine.split('=').slice(1).join('=').trim();
          const unquoted = v.replace(/^"(.*)"$/, '$1');
          if (path.resolve(unquoted) === want) {
            name = section.key[1];
            break;
          }
        }
        if (name) break;
      }
      if (!name) return;
      // 宿主语义：连带级联卸载该市场的全部插件（含其数据），破坏性在调用方确认。
      await run(['plugin', 'marketplace', 'remove', name]);
    },

    async readProjectEnabled(_projectPath, name, market) {
      // codex 无项目档启用面（config.toml 只有用户级）——项目启用 = 全局启用。
      const enabled = readEnabledMap(await readConfigText());
      return enabled[pluginKey(name, market)] ?? false;
    },

    async setProjectEnabled(_projectPath, name, enabled, market) {
      // 同上：写全局档（codex 的启用粒度只有 user）。
      const key = pluginKey(name, market);
      const text = (await readConfigText()) ?? '';
      await mkdir(path.dirname(configFile()), { recursive: true });
      await writeFile(configFile(), upsertCodexPluginEnabledInText(text, key, enabled), 'utf8');
    },

    async readGlobalEnabled() {
      return readEnabledMap(await readConfigText());
    },

    async writeGlobalEnabled(key, enabled) {
      const text = (await readConfigText()) ?? '';
      await mkdir(path.dirname(configFile()), { recursive: true });
      await writeFile(configFile(), upsertCodexPluginEnabledInText(text, key, enabled), 'utf8');
    },

    pluginScopes: () => ['user'],

    async readEnabledOverrides(_projectPath) {
      const enabled = await this.readGlobalEnabled();
      return { user: enabled, project: {}, local: {} };
    },

    async setEnabledOverride(_projectPath, scope, key, state) {
      if (scope !== 'user') {
        throw new Error(`codex plugins only support user-scope overrides (got ${scope})`);
      }
      const text = (await readConfigText()) ?? '';
      if (state === 'inherit') {
        // inherit = 删该档键 = 回落下一档；codex 只有 user 档，删键 = 未启用。
        const { text: next, removed } = removeTomlSection(text, ['plugins', key]);
        if (!removed) return;
        await mkdir(path.dirname(configFile()), { recursive: true });
        await writeFile(configFile(), next, 'utf8');
        return;
      }
      await mkdir(path.dirname(configFile()), { recursive: true });
      await writeFile(
        configFile(),
        upsertCodexPluginEnabledInText(text, key, state === 'on'),
        'utf8',
      );
    },
  };
}

export const CODEX_PLUGINS: PluginSurface = createCodexPluginSurface();
