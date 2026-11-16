/**
 * 终端后端注册表：auto 组合 + 工厂表（settings.preset → TerminalBackend）+
 * 解析入口（terminalBackendFor / enumerableBackends / backendForTargetId）+
 * pane env → preset 反查。各终端实现各自一个文件（`backend-<preset>.ts`），
 * 基类与共享件在 `backend.ts`；门面 re-export 在 `../opener.ts`。
 */
import { TERMINAL_LOCATOR_ENV } from '@weavecode/core';
import type { TerminalPreset, TerminalSettings } from '../settings.js';
import { KonsoleBackend } from './backend-konsole.js';
import { ItermBackend } from './backend-iterm.js';
import { GhosttyBackend } from './backend-ghostty.js';
import { TerminalAppBackend } from './backend-terminal-app.js';
import { WtBackend } from './backend-wt.js';
import { WeztermBackend } from './backend-wezterm.js';
import {
  CandidatesBackend,
  CustomBackend,
  PRESET_CANDIDATES,
  TerminalBackend,
  type LaunchOrigin,
  type PromptPaneTarget,
  type TerminalLaunch,
} from './backend.js';
import type { AttachTarget, SessionTerminal } from './wezterm-mux.js';

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

  override hideSpawnedWindow(dir: string): Promise<boolean> {
    return this.attachBackend().hideSpawnedWindow(dir);
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
 * 本平台有反查能力的全部后端（win32 = wt + wezterm，其余平台照各自实现）。
 * 角标/显隐的探测面按它合并——已开窗口活在哪个终端里只由它自己在的事实决定，
 * 换 settings preset 不改写历史窗口的归属（用户从 wt 换 wezterm，wt 里开着的
 * 会话照常计数/显隐/唤出，不会「切换后全部丢失」）。
 */
export function enumerableBackends(platform: NodeJS.Platform = process.platform): TerminalBackend[] {
  const presets: TerminalPreset[] =
    platform === 'win32'
      ? ['wt', 'wezterm']
      : platform === 'darwin'
        ? ['terminal', 'iterm', 'wezterm']
        : ['wezterm', 'gnome', 'konsole', 'ghostty'];
  return presets
    .map((p) => BACKEND_FACTORIES[p]?.(  { preset: p, customCommand: '' }, platform))
    .filter((b): b is TerminalBackend => Boolean(b) && b!.enumerable);
}

/**
 * targetId → 后端认领（id 表示法归各后端：`wt:weave-…` / wezterm 三段 attach 形）。
 * 没人认领按 settings 指的后端处理（开窗偏好兜底，旧行为）。
 */
export function backendForTargetId(
  targetId: string,
  terminal: TerminalSettings,
  platform: NodeJS.Platform = process.platform,
): TerminalBackend {
  const claimed = enumerableBackends(platform).find(
    (b) => b.ownsTargetId(targetId) || b.ownsPaneId(targetId),
  );
  return claimed ?? terminalBackendFor(terminal, platform);
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
