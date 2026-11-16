/**
 * 门面尾段：候选解析兼容入口 + 资源管理器/终端打开 + ProjectOpener 装配
 * （routes 的 opener 缺省值）。工厂/世界读取分属 backend-registry.ts / world.ts。
 */
import type { TerminalSettings } from '../settings.js';
import {
  backendForTargetId,
  terminalBackendFor,
} from './backend-registry.js';
import type { AttachTarget } from './wezterm-mux.js';
import { trySpawn, type LaunchOrigin, type PromptPaneTarget, type TerminalLaunch } from './backend.js';
import {
  countOpenTerminals,
  closeTerminalsIn,
  listProjectPanes,
  runInTerminal,
} from './world.js';
import { enumerableBackends } from './backend-registry.js';

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
  /** 可附加终端目标列表（可选）：多终端选择弹窗的数据面。includeForeign（opt-in）=
   *  跨项目的 tab 也进候选（默认关，现状不变）。 */
  listTerminals?(dir: string, terminal: TerminalSettings, includeForeign?: boolean): Promise<AttachTarget[]>;
  /** 定点附加到指定目标 tab（可选）：会话终端选择后的落点。 */
  runInTerminalAt?(
    dir: string,
    argv: string[],
    targetId: string,
    terminal: TerminalSettings,
  ): Promise<LaunchOrigin | null>;
  focusTerminal?(dir: string, targetId: string, terminal: TerminalSettings): Promise<void>;
  /** 系统级隐藏/恢复该目标所在 OS 窗口（可选：能力归后端，win32 才有实现）。 */
  setTerminalVisibility?(
    dir: string,
    targetId: string,
    visibility: 'hide' | 'show',
    terminal: TerminalSettings,
  ): Promise<{ visibility: 'visible' | 'hidden' }>;
  /** 目标所在 OS 窗口此刻的可见性（可选；拿不到 null，前端不摆态）。 */
  terminalVisibility?(
    dir: string,
    targetId: string,
    terminal: TerminalSettings,
  ): Promise<'visible' | 'hidden' | null>;
  /** 自动隐藏的精确通道（可选）：按 spawn 差集认出的窗口句柄直打，不读窗口标题
   *  （能力归后端，按 preset 分发）。返回 false = 无精确通道（复用窗/认窗未成/
   *  非本后端落子），调用方退标题认窗。 */
  hideSpawnedWindow?(dir: string, terminal: TerminalSettings): Promise<boolean>;
}

export const defaultProjectOpener: ProjectOpener = {
  openExplorer: openInExplorer,
  openTerminal: openInTerminal,
  runInTerminal,
  countTerminals: countOpenTerminals,
  closeTerminals: (dir, terminal, paneIds) => closeTerminalsIn(dir, terminal, paneIds),
  listPanes: (dir, terminal) => listProjectPanes(dir, terminal),
  // 目标列表/定点附加经 settings → 后端分发（wezterm mux / Terminal.app osascript），
  // 不再硬连 wezterm——调用方只传语义参数。目标列表走合并面：每个可枚举后端
  // 各列各的（id 前缀区分归属），已开窗口不因换 preset 从弹窗里消失。
  listTerminals: async (dir, _terminal, includeForeign = false) =>
    (
      await Promise.all(
        enumerableBackends().map((b) =>
          b.listTargets(dir, includeForeign).catch(() => [] as AttachTarget[]),
        ),
      )
    ).flat(),
  runInTerminalAt: (dir, argv, targetId, terminal) =>
    terminalBackendFor(terminal).runAt(dir, argv, targetId),
  focusTerminal: (dir, targetId, terminal) =>
    terminalBackendFor(terminal).focusTarget(dir, targetId),
  setTerminalVisibility: (dir, targetId, visibility, terminal) =>
    backendForTargetId(targetId, terminal).setTargetVisibility(dir, targetId, visibility),
  terminalVisibility: (dir, targetId, terminal) =>
    backendForTargetId(targetId, terminal).targetVisibility(dir, targetId),
  hideSpawnedWindow: (dir, terminal) => terminalBackendFor(terminal).hideSpawnedWindow(dir),
};
