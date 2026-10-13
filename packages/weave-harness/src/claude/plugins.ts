import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  GlobalInstallOptions,
  InstalledPluginRecord,
  MarketplaceRef,
  PluginInstallInfo,
  PluginSurface,
} from '../driver.js';
import { linkOrCopy, removeInstalled } from '../shared/install-link.js';
import { CLAUDE_ASSETS } from './assets.js';

/**
 * CC 插件安装面（批 3，H1-H5 实测结论落此，docs/plan/cc-plugin-verification.md）：
 * - 全局安装 = `claude plugin marketplace add <weave 目录源>` +
 *   `claude plugin install <name>@weave --scope user` 两步 CLI——install 按名字
 *   查已配置 marketplace，不接受本地路径；known_marketplaces /
 *   extraKnownMarketplaces 由 add 自动维护，Weave 不直改。
 * - weave marketplace = 自有目录源（`~/.claude/weave-marketplace`，包目录拷贝成
 *   `plugins/<name>` + 相对 source），键形自然为 `name@weave`（H5）。
 * - 项目启用 = 项目 `.claude/settings.json` 的 `enabledPlugins[name@weave]`
 *   （local > project > user 合并，项目 false 可关全局，H3）；local 档 =
 *   `.claude/settings.local.json`（个人本项目，gitignored）。
 * - 项目 `.claude/plugins/` 宿主从不扫描（H4）——只有存量副本清理语义消费。
 */
export const WEAVE_MARKETPLACE = 'weave';
const MARKETPLACE_DIRNAME = 'weave-marketplace';
/** 冷启动的 CLI（读 settings/插件索引）+ marketplace 落盘，30s 会误杀。 */
const CLI_TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 2_000;
const OUTPUT_KEEP = 64 * 1024;

export interface PluginExecResult {
  stdout: string;
  stderr: string;
}

/**
 * CLI 执行器：args 数组传参（默认实现 POSIX 直连；win32 上 `claude` 是 .cmd
 * shim、无 shell 会 EINVAL/ENOENT，经 ComSpec 转发并自行拼命令行）。失败 reject。
 */
export type PluginExecutor = (
  args: string[],
  opts: { timeoutMs: number },
) => Promise<PluginExecResult>;

/**
 * win32 命令行：`claude "plugin" "marketplace" "add" "D:\a\weave-marketplace"`。
 * 不用 `shell: true`——Node 对 shell 参数做二次转义会把路径里的反斜杠吃掉
 * （`D:\Users\x` 变成 `D:Usersx`，CLI 报 invalid marketplace source format）；
 * 改由本函数加引号，CmdSpec 侧不做转义（windowsVerbatimArguments）。引号内的
 * cmd 元字符不生效，只需转义参数字面量里的 `"`。
 */
export function claudeCommandLine(args: string[]): string {
  return ['claude', ...args.map((a) => `"${a.replace(/"/g, '\\"')}"`)].join(' ');
}

/**
 * win32 上杀进程只到得到 cmd.exe 外壳：孙进程 claude.exe 会吊住 stdout/stderr
 * 管道，close 事件永不触发（调用方看到的是一句空 stderr 的 Command failed）。
 */
function killTree(child: ChildProcess): void {
  // 外壳自身已退出（孙进程吊住管道）时它的 pid 可能已被系统复用——/t 杀树会误伤
  // 无关进程，这种情形宁可不杀。
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

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const execCli: PluginExecutor = (args, opts) =>
  new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    // stdin 关死：CLI 的交互式确认不该吊住调用方（weave 全程只走非交互参数）。
    const child = spawn(
      win ? process.env['ComSpec'] || 'cmd.exe' : 'claude',
      win ? ['/d', '/s', '/c', claudeCommandLine(args)] : args,
      {
        windowsHide: true,
        windowsVerbatimArguments: win,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const label = `claude ${args.join(' ')}`;
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

export function createClaudePluginSurface(deps: { exec?: PluginExecutor } = {}): PluginSurface {
  const exec = deps.exec ?? execCli;
  const run = (args: string[]): Promise<PluginExecResult> =>
    exec(args, { timeoutMs: CLI_TIMEOUT_MS });

  const globalSettingsFile = (): string => CLAUDE_ASSETS.userConfigFile(homedir());
  const installedFile = (): string =>
    path.join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const marketplaceRoot = (): string => path.join(homedir(), '.claude', MARKETPLACE_DIRNAME);
  const projectSettingsFile = (projectPath: string): string =>
    path.join(projectPath, '.claude', 'settings.json');
  /** local 档（个人本项目、gitignored）：`.claude/settings.local.json`。 */
  const localSettingsFile = (projectPath: string): string =>
    path.join(projectPath, '.claude', 'settings.local.json');
  /** 注册键：缺省 weave 自建市场；给出市场身份则用该市场（外部市场导入的包）。 */
  const pluginKey = (name: string, market?: string): string =>
    `${name}@${market ?? WEAVE_MARKETPLACE}`;

  /** JSON 读：缺失/损坏/非对象一律空对象（不写坏文件的读侧口径同 server）。 */
  const readJson = async (file: string): Promise<Record<string, unknown>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };

  const writeJson = async (file: string, value: Record<string, unknown>): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  };

  /** enabledPlugins 的布尔过滤读（读侧行为对齐原 readClaudePluginEnabled）。 */
  const enabledOf = (settings: Record<string, unknown>): Record<string, boolean> => {
    const ep = settings.enabledPlugins;
    if (!ep || typeof ep !== 'object' || Array.isArray(ep)) return {};
    return Object.fromEntries(
      Object.entries(ep as Record<string, unknown>).filter(
        ([, v]) => typeof v === 'boolean',
      ) as [string, boolean][],
    );
  };

  /** enabledPlugins 的原始 map（写侧保留非布尔既有值，对齐原 write 语义）。 */
  const rawEnabledOf = (settings: Record<string, unknown>): Record<string, unknown> => {
    const ep = settings.enabledPlugins;
    return ep && typeof ep === 'object' && !Array.isArray(ep)
      ? { ...(ep as Record<string, unknown>) }
      : {};
  };

  const readInstalled = async (): Promise<Record<string, InstalledPluginRecord[]>> => {
    const json = await readJson(installedFile());
    const plugins = json.plugins;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return {};
    const out: Record<string, InstalledPluginRecord[]> = {};
    for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
      if (Array.isArray(value)) out[key] = value as InstalledPluginRecord[];
    }
    return out;
  };

  const infoOf = (
    key: string,
    records: InstalledPluginRecord[] | undefined,
    alreadyInstalled: boolean,
  ): PluginInstallInfo => {
    const rec = records?.[records.length - 1];
    return {
      key,
      alreadyInstalled,
      ...(rec?.scope ? { scope: rec.scope } : {}),
      ...(rec?.installPath ? { installPath: rec.installPath } : {}),
      ...(rec?.version ? { version: rec.version } : {}),
    };
  };

  /** 同步 weave marketplace 目录源：包铺进 `plugins/<name>` + upsert 条目。
   *
   * 铺法**链接优先**（`linkOrCopy`，失败回退复制）——全局位置不再多存一份副本。
   * 两种情形必须走复制，否则会**穿过链接写进源目录**：
   *  ① 包缺 `.claude-plugin/plugin.json`：CC CLI install 必需，要就地合成最小
   *     manifest（mods-only 等无 manifest 包走此兜底）；
   *  ② 源里带 `node_modules` / `.git`：复制会按 filter 滤掉，链接会原样暴露出去。
   */
  const syncMarketplace = async (
    srcDir: string,
    name: string,
    opts: Pick<GlobalInstallOptions, 'version' | 'description'> = {},
  ): Promise<string> => {
    const root = marketplaceRoot();
    const target = path.join(root, 'plugins', name);
    // 目标可能是上一轮留下的链接：裸 rm 递归会删穿到链接目标，必须 lstat 判定后清。
    await removeInstalled(target);
    await mkdir(path.dirname(target), { recursive: true });

    const hasManifest = await readFile(
      path.join(srcDir, '.claude-plugin', 'plugin.json'),
      'utf8',
    ).then(
      () => true,
      () => false,
    );
    const sourceEntries = await readdir(srcDir).catch(() => [] as string[]);
    const linkable =
      hasManifest &&
      !sourceEntries.includes('node_modules') &&
      !sourceEntries.includes('.git');

    if (linkable) {
      await linkOrCopy(srcDir, target);
    } else {
      await cp(srcDir, target, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          return base !== 'node_modules' && base !== '.git';
        },
      });
      if (!hasManifest) {
        const manifestFile = path.join(target, '.claude-plugin', 'plugin.json');
        await mkdir(path.dirname(manifestFile), { recursive: true });
        await writeFile(
          manifestFile,
          JSON.stringify(
            {
              name,
              version: opts.version ?? '0.0.0',
              ...(opts.description ? { description: opts.description } : {}),
            },
            null,
            2,
          ) + '\n',
          'utf8',
        );
      }
    }
    const mktFile = path.join(root, '.claude-plugin', 'marketplace.json');
    const mkt = await readJson(mktFile);
    const plugins = Array.isArray(mkt.plugins)
      ? [...(mkt.plugins as Array<Record<string, unknown>>)]
      : [];
    const entry = { name, source: `./plugins/${name}` };
    const idx = plugins.findIndex((p) => p?.['name'] === name);
    if (idx >= 0) plugins[idx] = entry;
    else plugins.push(entry);
    mkt.name = WEAVE_MARKETPLACE;
    if (!mkt.owner) mkt.owner = { name: 'weave' };
    mkt.plugins = plugins;
    await writeJson(mktFile, mkt);
    return root;
  };

  /**
   * 外部市场包：市场目录（`<dataDir>/market/<id>`，包文件已由市场导入复制进来）
   * 就地维护一份 CC 市场清单——`plugins[]` upsert 该包、`source` 用市场内相对路径
   * （整目录搬走仍可解析 = 可整体迁移），`name` 强制归一为该市场 id（键形可预测）。
   */
  const ensureMarketManifest = async (
    market: MarketplaceRef,
    name: string,
    srcDir: string,
  ): Promise<void> => {
    if (!market.dir) throw new Error(`marketplace dir required for ${name}@${market.name}`);
    // 市场目录若是链接（内置仓落地即指向包内），就地维护清单会**穿过链接写进包内**
    // ——链接目标不是我们的数据。这类市场自带清单（随包发布），本就无需在此维护。
    if ((await lstat(market.dir)).isSymbolicLink()) return;
    const file = path.join(market.dir, '.claude-plugin', 'marketplace.json');
    const mkt = await readJson(file);
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
    await writeJson(file, mkt);
  };

  return {
    projectPluginDir: (projectPath) => path.join(projectPath, '.claude', 'plugins'),
    pluginKey,

    parsePluginKey(key: string) {
      // 键形由本文件的 pluginKey 拼，拆也只在这里拆。取 lastIndexOf：插件名本身
      // 可能含 `@`（scope 包名），市场名不会。无 `@`（理论外形态）→ 整体当名字、
      // 市场回落自建。
      const at = key.lastIndexOf('@');
      return at > 0
        ? { name: key.slice(0, at), market: key.slice(at + 1) }
        : { name: key, market: WEAVE_MARKETPLACE };
    },

    async globalInstall(srcDir: string, opts: GlobalInstallOptions = {}) {
      let name = opts.name;
      if (!name) {
        const manifest = await readJson(path.join(srcDir, '.claude-plugin', 'plugin.json'));
        name = typeof manifest.name === 'string' ? manifest.name : undefined;
      }
      if (!name) throw new Error(`plugin manifest missing name: ${srcDir}`);
      const market = opts.marketplace;
      const key = pluginKey(name, market?.name);

      const existing = (await readInstalled())[key];
      if (existing && existing.length > 0) return infoOf(key, existing, true);

      // 外部市场包：文件已在数据目录的市场副本里就地维护清单（不再拷进 weave 市场）；
      // weave 自己的包（内置 / SPI）：仍走自建市场的拷贝 + 合成清单。
      if (market) {
        await ensureMarketManifest(market, name, srcDir);
        await run(['plugin', 'marketplace', 'add', market.dir ?? '']);
      } else {
        const mktDir = await syncMarketplace(srcDir, name, opts);
        await run(['plugin', 'marketplace', 'add', mktDir]);
      }
      const { stdout } = await run(['plugin', 'install', key, '--scope', 'user', '--json']);
      const outcome = safeJson(stdout);
      if (outcome?.['outcome'] === 'failed') {
        throw new Error(truncate(String(outcome['message'] ?? 'plugin install failed')));
      }
      return infoOf(key, (await readInstalled())[key], false);
    },

    readInstalled,

    async isInstalled(name, market) {
      const records = (await readInstalled())[pluginKey(name, market)];
      return !!records && records.length > 0;
    },

    async uninstall(name, market) {
      const key = pluginKey(name, market);
      // 幂等：未安装直接返回（marketplace 源保留——卸载≠移除市场，可重装）
      const existing = (await readInstalled())[key];
      if (!existing || existing.length === 0) return;
      // 逐 scope 卸，每条记录按**它自己的** scope 删（全局记录 --scope user、项目
      // 记录 --scope project）：同一键可能同时挂两条（装过两次、scope 不同），漏删
      // 任何一条宿主都会继续把插件列为"已安装"。
      const scopes = [...new Set(existing.map((r) => r.scope ?? 'user'))];
      for (const scope of scopes) {
        const { stdout } = await run(['plugin', 'uninstall', key, '--scope', scope, '--json']);
        const outcome = safeJson(stdout);
        if (outcome?.['outcome'] === 'failed') {
          throw new Error(truncate(String(outcome['message'] ?? 'plugin uninstall failed')));
        }
      }
    },

    async removeMarketplace(marketDir) {
      // 注册名只存在于 known_marketplaces.json（目录名只是通常同名，不作依据）；
      // 按落点路径精确反查，查不到 = 未注册（或已注销）→ 幂等返回。
      const json = await readJson(
        path.join(homedir(), '.claude', 'plugins', 'known_marketplaces.json'),
      );
      const want = path.resolve(marketDir);
      const name = Object.entries(json).find(
        ([, v]) =>
          v &&
          typeof v === 'object' &&
          typeof (v as { installLocation?: unknown }).installLocation === 'string' &&
          path.resolve((v as { installLocation: string }).installLocation) === want,
      )?.[0];
      if (!name) return;
      // 宿主语义：连带级联卸载该市场的全部插件（含其数据），破坏性在调用方确认。
      await run(['plugin', 'marketplace', 'remove', name]);
    },

    async readProjectEnabled(projectPath, name, market) {
      const enabled = enabledOf(await readJson(projectSettingsFile(projectPath)));
      return enabled[pluginKey(name, market)] ?? false;
    },

    async setProjectEnabled(projectPath, name, enabled, market) {
      const file = projectSettingsFile(projectPath);
      const settings = await readJson(file);
      settings.enabledPlugins = {
        ...rawEnabledOf(settings),
        [pluginKey(name, market)]: enabled,
      };
      await writeJson(file, settings);
    },

    async readGlobalEnabled() {
      return enabledOf(await readJson(globalSettingsFile()));
    },

    async writeGlobalEnabled(key, enabled) {
      const file = globalSettingsFile();
      const settings = await readJson(file);
      settings.enabledPlugins = { ...rawEnabledOf(settings), [key]: enabled };
      await writeJson(file, settings);
    },

    pluginScopes: () => ['user', 'project', 'local'],

    async readEnabledOverrides(projectPath) {
      const [user, project, local] = await Promise.all([
        readJson(globalSettingsFile()).then(enabledOf),
        readJson(projectSettingsFile(projectPath)).then(enabledOf),
        readJson(localSettingsFile(projectPath)).then(enabledOf),
      ]);
      return { user, project, local };
    },

    async setEnabledOverride(projectPath, scope, key, state) {
      const file =
        scope === 'user'
          ? globalSettingsFile()
          : scope === 'project'
            ? projectSettingsFile(projectPath)
            : localSettingsFile(projectPath);
      const settings = await readJson(file);
      const raw = rawEnabledOf(settings);
      if (state === 'inherit') delete raw[key];
      else raw[key] = state === 'on';
      settings.enabledPlugins = raw;
      await writeJson(file, settings);
    },
  };
}

export const CLAUDE_PLUGINS: PluginSurface = createClaudePluginSurface();
