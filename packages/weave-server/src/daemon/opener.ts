import { TERMINAL_LOCATOR_ENV } from '@weavecode/core';
import { readDaemonSettings, type TerminalPreset, type TerminalSettings } from './settings.js';
import { normalizeDirKey } from './opener/wezterm-mux.js';
import { KonsoleBackend } from './opener/backend-konsole.js';
import { ItermBackend } from './opener/backend-iterm.js';
import { GhosttyBackend } from './opener/backend-ghostty.js';
import { TerminalAppBackend } from './opener/backend-terminal-app.js';
import { WtBackend } from './opener/backend-wt.js';
import { WeztermBackend } from './opener/backend-wezterm.js';
import {
  CandidatesBackend,
  CustomBackend,
  PRESET_CANDIDATES,
  TerminalBackend,
  trySpawn,
  type LaunchOrigin,
  type PromptPaneTarget,
  type TerminalLaunch,
} from './opener/backend.js';
import type { AttachTarget, SessionTerminal } from './opener/wezterm-mux.js';

/**
 * 终端后端门面：工厂表（settings.preset → TerminalBackend）+ `auto` 组合 +
 * 顶层便捷函数 + prompt 层② 通道适配。各终端实现各自一个文件
 * （`opener/backend-<preset>.ts`），基类与共享件在 `opener/backend.ts`。
 *
 * Launches use argument-array spawns (never a shell string), so directory
 * names cannot inject commands. The one exception is the `custom` terminal
 * preset, which is a user-authored command template and deliberately goes
 * through a shell — the daemon is localhost-only and token-authenticated.
 */

// ---- re-export：消费方只 import '../opener.js'，门面保持单一入口 ----
export {
  parseTerminalAppDump,
  parseTerminalAppTargetId,
  parsePsRootPids,
  parseLsofCwds,
  pickTerminalAppWindow,
  terminalAppTargets,
} from './opener/pty-terminals.js';
export type { TerminalAppSurface } from './opener/pty-terminals.js';
export { winRaiseEncodedScript } from './opener/win-raise.js';
export {
  parseWtPaneId,
  parseWtProcDump,
  parseWtTargetId,
  wtInjectEncodedScript,
  wtPanePidFromEnv,
  wtPanes,
  wtWindowSlug,
} from './opener/wt.js';
export type { WtProcRow } from './opener/wt.js';
export { quotePath } from './opener/shared.js';
export {
  attachTargetsFromMuxes,
  countWindowsByDir,
  listAttachTargets,
  normalizeDirKey,
  parseAttachTargetId,
  parseWeztermPanes,
  planWeztermNewWindow,
  planWeztermReuse,
  sessionScreensFromEnvs,
  SocketProbeGate,
  weztermActiveWorkspaceOf,
  weztermCliArgs,
  weztermMuxKey,
  weztermPaneFromEnv,
  weztermSocketCandidates,
} from './opener/wezterm-mux.js';
export type {
  AttachTarget,
  SessionTerminal,
  WeztermMuxPane,
} from './opener/wezterm-mux.js';
export { planWeztermGrid } from './opener/wezterm-mux.js';
export {
  konsolePaneFromEnv,
  parseKonsolePaneId,
  qtKeyOf,
} from './opener/backend-konsole.js';
export {
  applescriptString,
  itermPaneFromEnv,
  parseItermPaneId,
} from './opener/backend-iterm.js';
export {
  parsePromptPaneId,
  runInWeztermAt,
} from './opener/backend-wezterm.js';
export {
  CandidatesBackend,
  CustomBackend,
  PRESET_CANDIDATES,
  TerminalBackend,
  trySpawn,
} from './opener/backend.js';
export type {
  LaunchOrigin,
  PromptPaneTarget,
  TerminalLaunch,
} from './opener/backend.js';

/**
 * auto：把本平台的具名 preset 候选按序串起来（与具名条目同源）。反查/定点/
 * 文本通道随平台走它实际会开的终端（darwin=Terminal.app / win32=wt / 其余=
 * wezterm）——委托给对应后端，不自己抄第二份。
 */
class AutoBackend extends TerminalBackend {
  private readonly parts: TerminalBackend[];

  constructor(platform: NodeJS.Platform) {
    // 文本通道随 attachBackend 走（win32=wt / darwin=Terminal.app 都没有，
    // 其余平台是 wezterm）；候选序里本就没有 wezterm，darwin 除外逻辑同反查。
    super('auto', true, platform, platform !== 'win32' && platform !== 'darwin');
    const order: Partial<Record<NodeJS.Platform, TerminalPreset[]>> = {
      win32: ['wt', 'powershell', 'cmd'],
      darwin: ['terminal', 'iterm'],
    };
    const presets = order[platform] ?? ['gnome', 'konsole'];
    this.parts = presets.map(
      (preset) =>
        new CandidatesBackend(
          preset,
          platform,
          PRESET_CANDIDATES[preset as keyof typeof PRESET_CANDIDATES],
        ),
    );
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    return this.parts.flatMap((part) => {
      // macOS 带命令时只用 Terminal：auto 不把命令塞进 iTerm 的 osascript（旧行为）。
      if (run && part.preset === 'iterm') return [];
      return part.candidates(dir, run);
    });
  }

  /**
   * auto 的反查/定点通道随平台走它实际会开的终端：darwin 候选序里是 Terminal.app
   * （没有 wezterm），win32 候选序首位是 wt，其余平台沿用 wezterm 口径。
   */
  private attachBackend(): TerminalBackend {
    if (this.platform === 'darwin') return new TerminalAppBackend(this.platform);
    if (this.platform === 'win32') return new WtBackend(this.platform);
    return new WeztermBackend(this.platform);
  }

  override countWindows(dirs: readonly string[]): Promise<Map<string, number>> {
    return this.attachBackend().countWindows(dirs);
  }

  override listTargets(dir: string): Promise<AttachTarget[]> {
    return this.attachBackend().listTargets(dir);
  }

  override runAt(dir: string, argv: string[], targetId: string): Promise<LaunchOrigin | null> {
    return this.attachBackend().runAt(dir, argv, targetId);
  }

  override focusTarget(dir: string, targetId: string): Promise<void> {
    return this.attachBackend().focusTarget(dir, targetId);
  }

  override listPromptPanes(): Promise<PromptPaneTarget[]> {
    return this.attachBackend().listPromptPanes();
  }

  override locatePane(env: Record<string, string>): Promise<string | null> {
    return this.attachBackend().locatePane(env);
  }

  override locateScreens(
    envs: Record<string, Record<string, string>>,
  ): Promise<Record<string, SessionTerminal | null>> {
    return this.attachBackend().locateScreens(envs);
  }

  override sendPromptText(paneId: string, text: string): Promise<void> {
    return this.attachBackend().sendPromptText(paneId, text);
  }

  override sendKeys(paneId: string, keys: string): Promise<void> {
    return this.attachBackend().sendKeys(paneId, keys);
  }

  override getPaneText(paneId: string): Promise<string | null> {
    return this.attachBackend().getPaneText(paneId);
  }

  override closePane(paneId: string): Promise<void> {
    return this.attachBackend().closePane(paneId);
  }
}

const BACKEND_FACTORIES: Record<
  TerminalPreset,
  (terminal: TerminalSettings, platform: NodeJS.Platform) => TerminalBackend
> = {
  auto: (_terminal, platform) => new AutoBackend(platform),
  wt: (_terminal, platform) => new WtBackend(platform),
  powershell: (_terminal, platform) =>
    new CandidatesBackend('powershell', platform, PRESET_CANDIDATES.powershell),
  cmd: (_terminal, platform) => new CandidatesBackend('cmd', platform, PRESET_CANDIDATES.cmd),
  terminal: (_terminal, platform) => new TerminalAppBackend(platform),
  iterm: (_terminal, platform) => new ItermBackend(platform),
  gnome: (_terminal, platform) => new CandidatesBackend('gnome', platform, PRESET_CANDIDATES.gnome),
  konsole: (_terminal, platform) => new KonsoleBackend(platform),
  ghostty: (_terminal, platform) => new GhosttyBackend(platform),
  wezterm: (_terminal, platform) => new WeztermBackend(platform),
  custom: (terminal, platform) => new CustomBackend(terminal, platform),
};

/** settings → 后端（未知 preset 回落 auto，与旧的 switch default 一致）。 */
export function terminalBackendFor(
  terminal: TerminalSettings,
  platform: NodeJS.Platform = process.platform,
): TerminalBackend {
  return (BACKEND_FACTORIES[terminal.preset] ?? BACKEND_FACTORIES.auto)(terminal, platform);
}

/**
 * 上报的 pane env 属于哪个终端 preset——**每组键齐了才算认得**（缺键 = 不是那个
 * 终端的会话）。表来自 core 的定位键表（preset 名不散写），故「会话活在哪个终端」
 * 只有一个事实源。
 */
export function locatorPresetOf(env: Record<string, string>): TerminalPreset | null {
  for (const [preset, keys] of Object.entries(TERMINAL_LOCATOR_ENV)) {
    if (keys.every((key) => env[key])) return preset as TerminalPreset;
  }
  return null;
}

/**
 * prompt 层② 兜底通道适配（MessageDeliverer 的 PromptTerminal 形状）。
 *
 * 取后端分两处，因为「开窗」与「对话」是两个问题：
 * - `settings.terminal` 答「weave 该往哪个终端开窗」——`listPanes`（标题+cwd
 *   启发式回落的枚举面）用它，没有 env 的会话只在用户指明过的终端世界里猜；
 * - 会话**自己上报的 pane env** 答「这个会话此刻在哪个终端里」——定位按它反查
 *   preset、击键按 **pane id 认领后端**。故换 preset 是纯开窗偏好，已开会话的
 *   停止/作答照旧（唯一实现文本通道的 wezterm 也不是硬编码回落，而是 `ownsPaneId`
 *   自然认领；将来别的终端实现这组方法即自动接入）。
 */
export function promptTerminalChannel(
  settings: () => TerminalSettings,
): {
  available(): boolean;
  listPanes(): Promise<PromptPaneTarget[]>;
  locatePane(env: Record<string, string>): Promise<string | null>;
  locateScreens(envs: Record<string, Record<string, string>>): Promise<Record<string, SessionTerminal | null>>;
  sendText(paneId: string, text: string): Promise<void>;
  sendKeys(paneId: string, keys: string): Promise<void>;
  closePane(paneId: string): Promise<void>;
} {
  const backendFor = (preset: TerminalPreset) => terminalBackendFor({ ...settings(), preset });
  const configuredBackend = () => backendFor(settings().preset);
  // 能远程击键的终端 = 定位键表里那些 preset（能认领「会话在哪个 pane」是前提）。
  const paneBackends = (): TerminalBackend[] =>
    Object.keys(TERMINAL_LOCATOR_ENV).map((preset) => backendFor(preset as TerminalPreset));
  // 会话说自己活在哪个终端 → 就用那个终端的后端定位（认不出世界 = 不猜，返回 null）。
  const backendForEnv = (env: Record<string, string>): TerminalBackend | null => {
    const preset = locatorPresetOf(env);
    return preset ? backendFor(preset) : null;
  };
  const backendForPaneId = (paneId: string): TerminalBackend | null =>
    paneBackends().find((backend) => backend.ownsPaneId(paneId)) ?? null;
  return {
    available: () => paneBackends().some((backend) => backend.textAddressable),
    listPanes: async () => {
      const backend = configuredBackend();
      return backend.textAddressable ? await backend.listPromptPanes() : [];
    },
    locatePane: async (env) => (await backendForEnv(env)?.locatePane(env)) ?? null,
    locateScreens: async (envs) => {
      // 同一批 env 可能来自不同终端世界：按世界分组各问各的后端。三态原样透传——
      // 缺键 = 那个世界这轮没探到（实例还活着），null = 确认不在了（见
      // `sessionScreensFromEnvs`）；这里不再把「没探到」补成 null，否则探活闸的
      // 冷却窗会把分块里的行整批摘出去。认不出定位世界 / 该终端没有反查能力的
      // 确认分不了块，照旧落 null。
      const out: Record<string, SessionTerminal | null> = {};
      const groups = new Map<TerminalPreset, Record<string, Record<string, string>>>();
      for (const [sessionId, env] of Object.entries(envs)) {
        const preset = locatorPresetOf(env);
        if (!preset) {
          out[sessionId] = null;
          continue;
        }
        const group = groups.get(preset) ?? {};
        group[sessionId] = env;
        groups.set(preset, group);
      }
      for (const [preset, group] of groups) {
        const backend = backendFor(preset);
        if (!backend.locateScreens) {
          for (const sessionId of Object.keys(group)) out[sessionId] = null;
          continue;
        }
        const found = await backend.locateScreens(group);
        for (const [sessionId, screen] of Object.entries(found)) out[sessionId] = screen;
      }
      return out;
    },
    sendText: async (paneId, text) => {
      const backend = backendForPaneId(paneId);
      if (!backend) throw new Error(`Invalid prompt pane "${paneId}"`);
      await backend.sendPromptText(paneId, text);
    },
    sendKeys: async (paneId, keys) => {
      const backend = backendForPaneId(paneId);
      if (!backend) throw new Error(`Invalid prompt pane "${paneId}"`);
      await backend.sendKeys(paneId, keys);
    },
    closePane: async (paneId) => {
      const backend = backendForPaneId(paneId);
      if (!backend) throw new Error(`Invalid prompt pane "${paneId}"`);
      await backend.closePane(paneId);
    },
  };
}

/**
 * 项目卡「终端」角标的数据面：每个目录已打开的终端窗口数（窗口级口径；wt
 * 归属不到窗口，按 pane 数计——前端文案「N 个终端已打开」两种口径都成立）。
 * 「这个 preset 能不能反查」由后端回答：wezterm 走 mux `cli list`、Terminal.app
 * 走 osascript+ps+lsof、wt 走进程表 PEB 走读；其余 preset 没有可枚举通道 →
 * 一律 0（角标不显示，不谎报）。
 */

/** Open a terminal at `dir` that runs `argv` (e.g. `claude --resume <id>`).
 * Same detached semantics as `openInTerminal` — the process outlives the daemon.
 * Returns the launch origin (spawn receipt) when the backend can get one. */
export async function runInTerminal(
  dir: string,
  argv: string[],
  terminal: TerminalSettings,
): Promise<LaunchOrigin | null> {
  // wezterm 分流在 WeztermBackend 覆写的 run 里，不在这里 if preset：有活 mux
  // 走 mux（legacy `start -- PROG` 绕过 default_prog，且 mux 在时 `start` 只会
  // 挂死出一个无窗僵尸 + trySpawn 假成功）；一个活 mux 都没有 → 回落 `start`
  // 起新 GUI（用户此刻还没开 wezterm 的常态），回落里起不来才抛。
  return terminalBackendFor(terminal).run(dir, argv);
}

export async function countOpenTerminals(
  dirs: string[],
  terminal: TerminalSettings,
): Promise<Map<string, number>> {
  // 「这个 preset 能不能反查」由后端回答（不支持 → 基类空表 → 上游落 0），
  // 不在调用方列 preset 白名单。
  return terminalBackendFor(terminal).countWindows(dirs);
}

/**
 * cwd **恰为** `dir` 的 pane = 这个项目的终端（关终端的命中判据，与
 * `countWindowsByDir` 同一条：精确相等、不含子目录）。关错一个就是杀掉用户
 * 顺手开着的别的活，故判据单点在此。
 */
export function panesAtDir(
  panes: readonly PromptPaneTarget[],
  dir: string,
  platform: NodeJS.Platform = process.platform,
): PromptPaneTarget[] {
  const wanted = normalizeDirKey(dir, platform);
  return panes.filter((p) => p.cwd != null && normalizeDirKey(p.cwd, platform) === wanted);
}

/**
 * `dir` 名下可关的 pane（项目关终端多选弹窗的数据面）：`panesAtDir` 命中的那些。
 *
 * 枚举不到 pane 而计数说有 = 这个后端有窗口却关不了（wt 只数不关）——如实抛，
 * 不返回空表让弹窗装作「没有终端」。
 */
export async function listProjectPanes(
  dir: string,
  terminal: TerminalSettings,
  platform: NodeJS.Platform = process.platform,
): Promise<PromptPaneTarget[]> {
  const backend = terminalBackendFor(terminal, platform);
  const panes = panesAtDir(await backend.listPromptPanes(), dir, platform);
  if (panes.length === 0 && ((await backend.countWindows([dir])).get(dir) ?? 0) > 0) {
    throw new Error(
      `Terminal preset "${backend.preset}" cannot close open panes remotely — pick wezterm in settings`,
    );
  }
  return panes;
}

/**
 * 关掉 `dir` 的已开终端（项目卡「关闭终端」）：只关清单里的那些 pane——清单来自
 * 用户在弹窗里的多选，**不提供「一口气全关」**（那是这次要去掉的误触面）。
 * 窗口里别的 cwd 的 pane 不动（不替用户关掉顺手开着的别的活），只剩它一个时整窗
 * 随 pane 一起没。返回关掉的 pane 数；清单里的 pane 一个都没命中 = 目标已经没了，
 * 如实返回 0。
 */
export async function closeTerminalsIn(
  dir: string,
  terminal: TerminalSettings,
  paneIds: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const backend = terminalBackendFor(terminal, platform);
  const wanted = new Set(paneIds);
  const panes = (await listProjectPanes(dir, terminal, platform)).filter((p) => wanted.has(p.id));
  for (const pane of panes) await backend.closePane(pane.id);
  return panes.length;
}

/**
 * 每项目窗口数（projectId → 窗口数）：/terminals/counts 路由与隐藏刷新器共用
 * 同一口径，免得两处各自拼 settings/opener 后漂移。
 */
export async function readTerminalCounts(
  projects: readonly { id: number; path: string }[],
  opener: ProjectOpener | undefined = undefined,
): Promise<Record<number, number>> {
  const settings = await readDaemonSettings();
  const count = opener?.countTerminals ?? countOpenTerminals;
  const byPath = await count(
    projects.map((p) => p.path),
    settings.terminal,
  );
  return Object.fromEntries(projects.map((p) => [p.id, byPath.get(p.path) ?? 0]));
}

/**
 * Resolve the spawn candidates that would open a terminal at `dir`. 兼容入口：
 * 候选解析已归后端（`TerminalBackend.candidates`），这里只做分发。
 *
 * `run` = argv of a command to execute inside the new terminal (e.g.
 * `['claude', '--resume', id]`); omitted = just open the directory.
 */
export function resolveTerminalLaunch(
  dir: string,
  terminal: TerminalSettings,
  platform: NodeJS.Platform = process.platform,
  run?: string[],
): TerminalLaunch[] {
  return terminalBackendFor(terminal, platform).candidates(dir, run);
}

/** File-manager command that opens `dir` (per platform). */
export function resolveExplorerLaunch(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): TerminalLaunch {
  if (platform === 'win32') return { command: 'explorer.exe', args: [dir] };
  if (platform === 'darwin') return { command: 'open', args: [dir] };
  return { command: 'xdg-open', args: [dir] };
}

/** Open the OS file manager at `dir`. */
export async function openInExplorer(dir: string): Promise<void> {
  const launch = resolveExplorerLaunch(dir);
  if (!(await trySpawn(launch))) {
    throw new Error(`Failed to open file manager (${launch.command})`);
  }
}

/** Open a terminal at `dir` following the configured preset. `auto` tries the
 * platform candidates in order until one launches. */
export async function openInTerminal(dir: string, terminal: TerminalSettings): Promise<void> {
  await terminalBackendFor(terminal).open(dir);
}

/** Injection seam for the open routes — tests substitute a spy. */
export interface ProjectOpener {
  openExplorer(dir: string): Promise<void>;
  openTerminal(dir: string, terminal: TerminalSettings): Promise<void>;
  runInTerminal(dir: string, argv: string[], terminal: TerminalSettings): Promise<LaunchOrigin | null>;
  /** 已打开终端窗口计数（可选：不实现的 spy 由路由回落到默认实现）。 */
  countTerminals?(dirs: string[], terminal: TerminalSettings): Promise<Map<string, number>>;
  /** 关掉本目录的已开终端（可选）：只关清单里的 pane，回关掉几个。 */
  closeTerminals?(
    dir: string,
    terminal: TerminalSettings,
    paneIds: readonly string[],
  ): Promise<number>;
  /** 本目录名下可关的 pane（可选）：关终端多选弹窗的数据面。 */
  listPanes?(dir: string, terminal: TerminalSettings): Promise<PromptPaneTarget[]>;
  /** 可附加终端目标列表（可选）：多终端选择弹窗的数据面。 */
  listTerminals?(dir: string, terminal: TerminalSettings): Promise<AttachTarget[]>;
  /** 定点附加到指定目标 tab（可选）：会话终端选择后的落点。 */
  runInTerminalAt?(
    dir: string,
    argv: string[],
    targetId: string,
    terminal: TerminalSettings,
  ): Promise<LaunchOrigin | null>;
  focusTerminal?(dir: string, targetId: string, terminal: TerminalSettings): Promise<void>;
}

export const defaultProjectOpener: ProjectOpener = {
  openExplorer: openInExplorer,
  openTerminal: openInTerminal,
  runInTerminal,
  countTerminals: countOpenTerminals,
  closeTerminals: (dir, terminal, paneIds) => closeTerminalsIn(dir, terminal, paneIds),
  listPanes: (dir, terminal) => listProjectPanes(dir, terminal),
  // 目标列表/定点附加经 settings → 后端分发（wezterm mux / Terminal.app osascript），
  // 不再硬连 wezterm——调用方只传语义参数。
  listTerminals: (dir, terminal) => terminalBackendFor(terminal).listTargets(dir),
  runInTerminalAt: (dir, argv, targetId, terminal) =>
    terminalBackendFor(terminal).runAt(dir, argv, targetId),
  focusTerminal: (dir, targetId, terminal) =>
    terminalBackendFor(terminal).focusTarget(dir, targetId),
};
