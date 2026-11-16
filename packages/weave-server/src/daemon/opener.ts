import { TERMINAL_LOCATOR_ENV } from '@weavecode/core';
import { type TerminalPreset, type TerminalSettings } from './settings.js';
import { TerminalBackend, type PromptPaneTarget } from './opener/backend.js';
import type { SessionTerminal } from './opener/wezterm-mux.js';

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
  hideSpawnedWeztermWindow,
  weztermMuxKey,
  weztermPaneFromEnv,
} from './opener/wezterm-mux.js';
export type {
  AttachTarget,
  SessionTerminal,
  WeztermMuxPane,
} from './opener/wezterm-mux.js';
export { planWeztermGrid } from './opener/wezterm-mux.js';
export {
  captureCommand,
  SocketProbeGate,
  weztermActiveWorkspaceOf,
  weztermCliArgs,
  weztermLiveMuxes,
  weztermLiveMuxesCached,
  weztermMuxForId,
  weztermSocketCandidates,
} from './opener/wezterm-probe.js';
export type { CaptureResult, WeztermMux } from './opener/wezterm-probe.js';
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
  chunkByUtf8Bytes,
  hasPasteMarkers,
  pasteKeyChunks,
  trySpawn,
} from './opener/backend.js';
export type {
  LaunchOrigin,
  PromptPaneTarget,
  TerminalLaunch,
} from './opener/backend.js';
import {
  locatorPresetOf,
  terminalBackendFor,
} from './opener/backend-registry.js';
export {
  backendForTargetId,
  locatorPresetOf,
  terminalBackendFor,
} from './opener/backend-registry.js';
export { enumerableBackends } from './opener/backend-registry.js';
export {
  closeTerminalsIn,
  countOpenTerminals,
  listProjectPanes,
  panesAtDir,
  readTerminalWorld,
  runInTerminal,
} from './opener/world.js';

export type { ProjectOpener } from './opener/facade.js';
export {
  resolveTerminalLaunch,
  resolveExplorerLaunch,
  openInExplorer,
  openInTerminal,
  defaultProjectOpener,
} from './opener/facade.js';

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
  /** 读 pane 可视屏（中断后的读屏确认：宿主吞掉 ESC 时才补打）。 */
  getPaneText(paneId: string): Promise<string | null>;
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
    getPaneText: async (paneId) => {
      const backend = backendForPaneId(paneId);
      if (!backend) throw new Error(`Invalid prompt pane "${paneId}"`);
      return backend.getPaneText(paneId);
    },
    closePane: async (paneId) => {
      const backend = backendForPaneId(paneId);
      if (!backend) throw new Error(`Invalid prompt pane "${paneId}"`);
      await backend.closePane(paneId);
    },
  };
}
