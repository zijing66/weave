import {
  doScriptInTerminalWindow,
  listTerminalAppSurfaces,
  listTerminalAppTargets,
  parseTerminalAppTargetId,
  pickTerminalAppWindow,
  terminalAppSurfacesCached,
} from './pty-terminals.js';
import { countWindowsByDir } from './wezterm-mux.js';
import type { AttachTarget } from './wezterm-mux.js';
import { PRESET_CANDIDATES, TerminalBackend, type LaunchOrigin, type TerminalLaunch } from './backend.js';

/**
 * Terminal.app（macOS）：枚举/定点全走 osascript + ps + lsof——tab 的 tty →
 * 该 tty 的进程树根（shell；被 exec 替换成 claude 时就是 claude 本身）→ lsof
 * 取 cwd。无分屏，tab 即整面；「pane 分屏」的等价物是新 tab：run 复用同项目
 * 窗口开新 tab，定点附加落在所选 tab 的窗口。枚举通道只在 darwin 存在，其它
 * 平台 enumerable=false。
 */
export class TerminalAppBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    super('terminal', platform === 'darwin', platform);
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    return PRESET_CANDIDATES.terminal(dir, run, this.platform);
  }

  /** 同项目已有 Terminal.app 窗口 → 在那个窗口开新 tab；窗口中途没了 → 落回新窗。 */
  override async run(dir: string, argv: string[]): Promise<LaunchOrigin | null> {
    if (this.platform === 'darwin') {
      const surfaces = await listTerminalAppSurfaces(this.platform);
      const win = pickTerminalAppWindow(surfaces, dir, this.platform);
      if (win && (await doScriptInTerminalWindow(dir, argv, win.windowId))) return null;
    }
    await this.spawnFirst(
      this.candidates(dir, argv),
      `Terminal preset "${this.preset}" is unavailable on this platform`,
    );
    return null;
  }

  override async countWindows(dirs: readonly string[]): Promise<Map<string, number>> {
    if (dirs.length === 0 || this.platform !== 'darwin') return new Map(dirs.map((d) => [d, 0]));
    const surfaces = await terminalAppSurfacesCached(this.platform);
    if (surfaces.length === 0) return new Map(dirs.map((d) => [d, 0]));
    return countWindowsByDir(
      dirs,
      surfaces.flatMap((s) =>
        s.cwd
          ? [{ muxKey: 'terminal.app', windowId: s.windowId, tabId: s.tabIndex, cwd: s.cwd }]
          : [],
      ),
    );
  }

  override listTargets(dir: string): Promise<AttachTarget[]> {
    return listTerminalAppTargets(dir, this.platform);
  }

  /** 定点附加：落点是所选 tab 的窗口（do script 在该窗口开新 tab）；osascript 无回执。 */
  override async runAt(dir: string, argv: string[], targetId: string): Promise<LaunchOrigin | null> {
    const parsed = parseTerminalAppTargetId(targetId);
    if (!parsed) throw new Error(`Invalid terminal target "${targetId}"`);
    if (!(await doScriptInTerminalWindow(dir, argv, parsed.windowId))) {
      throw new Error('Terminal window is gone — pick a terminal again');
    }
    return null;
  }
}
