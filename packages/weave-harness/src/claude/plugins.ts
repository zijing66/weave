import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  GlobalInstallOptions,
  InstalledPluginRecord,
  PluginInstallInfo,
  PluginSurface,
} from '../driver.js';
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
 *   （local > project > user 合并，项目 false 可关全局，H3）。
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
  const pluginKey = (name: string): string => `${name}@${WEAVE_MARKETPLACE}`;

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

  /** 同步 weave marketplace 目录源：包拷贝进 `plugins/<name>` + upsert 条目；
   * 目标副本缺 `.claude-plugin/plugin.json` 时就地合成最小 manifest（CC CLI
   * install 必需；mods-only 等无 manifest 包走此兜底，绝不回写源目录）。 */
  const syncMarketplace = async (
    srcDir: string,
    name: string,
    opts: Pick<GlobalInstallOptions, 'version' | 'description'> = {},
  ): Promise<string> => {
    const root = marketplaceRoot();
    const target = path.join(root, 'plugins', name);
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(srcDir, target, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return base !== 'node_modules' && base !== '.git';
      },
    });
    const manifestFile = path.join(target, '.claude-plugin', 'plugin.json');
    let hasManifest = true;
    try {
      await readFile(manifestFile, 'utf8');
    } catch {
      hasManifest = false;
    }
    if (!hasManifest) {
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

  return {
    projectPluginDir: (projectPath) => path.join(projectPath, '.claude', 'plugins'),

    async globalInstall(srcDir: string, opts: GlobalInstallOptions = {}) {
      let name = opts.name;
      if (!name) {
        const manifest = await readJson(path.join(srcDir, '.claude-plugin', 'plugin.json'));
        name = typeof manifest.name === 'string' ? manifest.name : undefined;
      }
      if (!name) throw new Error(`plugin manifest missing name: ${srcDir}`);
      const key = pluginKey(name);

      const existing = (await readInstalled())[key];
      if (existing && existing.length > 0) return infoOf(key, existing, true);

      const mktDir = await syncMarketplace(srcDir, name, opts);
      await run(['plugin', 'marketplace', 'add', mktDir]);
      const { stdout } = await run(['plugin', 'install', key, '--scope', 'user', '--json']);
      const outcome = safeJson(stdout);
      if (outcome?.['outcome'] === 'failed') {
        throw new Error(truncate(String(outcome['message'] ?? 'plugin install failed')));
      }
      return infoOf(key, (await readInstalled())[key], false);
    },

    readInstalled,

    async isInstalled(name) {
      const records = (await readInstalled())[pluginKey(name)];
      return !!records && records.length > 0;
    },

    async uninstall(name) {
      const key = pluginKey(name);
      // 幂等：未安装直接返回（marketplace 源保留——卸载≠移除市场，可重装）
      const existing = (await readInstalled())[key];
      if (!existing || existing.length === 0) return;
      const { stdout } = await run(['plugin', 'uninstall', key, '--scope', 'user', '--json']);
      const outcome = safeJson(stdout);
      if (outcome?.['outcome'] === 'failed') {
        throw new Error(truncate(String(outcome['message'] ?? 'plugin uninstall failed')));
      }
    },

    async readProjectEnabled(projectPath, name) {
      const enabled = enabledOf(await readJson(projectSettingsFile(projectPath)));
      return enabled[pluginKey(name)] ?? false;
    },

    async setProjectEnabled(projectPath, name, enabled) {
      const file = projectSettingsFile(projectPath);
      const settings = await readJson(file);
      settings.enabledPlugins = { ...rawEnabledOf(settings), [pluginKey(name)]: enabled };
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
  };
}

export const CLAUDE_PLUGINS: PluginSurface = createClaudePluginSurface();
