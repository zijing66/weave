import { basename } from 'node:path';
import { pidAlive } from '../claude-liveness.js';
import { countWindowsByDir, normalizeDirKey } from './wezterm-mux.js';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  parseWtPaneId,
  parseWtTargetId,
  wtInjectKeys,
  wtPanePidFromEnv,
  wtPanesAsWindows,
  wtPanesCached,
  wtWindowSlug,
} from './wt.js';
import { winRaiseTerminalWindow } from './win-raise.js';
import { throughCmd } from './shared.js';
import { PRESET_CANDIDATES, TerminalBackend, type LaunchOrigin, type TerminalLaunch } from './backend.js';
import type { AttachTarget } from './wezterm-mux.js';

/**
 * Windows Terminal（win32）：无官方枚举 API，反查走进程树——每个 pane 的
 * shell 是 `WindowsTerminal.exe` 的直接子进程（`OpenConsole.exe` 是 ConPTY
 * 宿主、兄弟进程），shell 的 PEB cwd 即 pane 实时工作目录。pane 归属不到
 * 具体窗口（多窗口共进程、窗口名不外露），角标口径 = 本项目 pane 数（前端
 * 文案「N 个终端已打开」对窗口/pane 皆成立）。开窗/落点走 wt 命名窗口：
 * `-w <name>` 在则进 tab、不在则重建——天然就是「复用项目窗口」的落点语义，
 * 零簿记；定点附加 = 命名窗口里 split-pane（分屏）。
 */
export class WtBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    // wt 没有 per-pane 文本通道，但有 console 输入记录通道（见 sendKeys）。
    super('wt', platform === 'win32', platform, platform === 'win32');
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    return PRESET_CANDIDATES.wt(dir, run, this.platform);
  }

  override async countWindows(dirs: readonly string[]): Promise<Map<string, number>> {
    if (dirs.length === 0 || this.platform !== 'win32') return new Map(dirs.map((d) => [d, 0]));
    const panes = await wtPanesCached();
    if (panes.length === 0) return new Map(dirs.map((d) => [d, 0]));
    return countWindowsByDir(dirs, wtPanesAsWindows(panes));
  }

  /**
   * 目标列表 = 项目命名窗口一条（pane 反查只判「项目有没有 wt 终端」，归属
   * 不了用户手开的未命名窗口——那些列了也无处落子）。走缓存：wt 的落点
   * 自愈（命名窗口不在则重建），不像 wezterm 分屏会落进刚关掉的 pane。
   */
  override async listTargets(dir: string): Promise<AttachTarget[]> {
    if (this.platform !== 'win32') return [];
    const panes = await wtPanesCached();
    const count = countWindowsByDir([dir], wtPanesAsWindows(panes)).get(dir) ?? 0;
    if (count === 0) return [];
    return [
      {
        id: `wt:${wtWindowSlug(dir)}`,
        windowId: 0, // 无窗口号通道；title 非空，前端不回落窗口/Tab 文案
        tabId: 0,
        title: basename(dir),
        matchCount: count,
        paneCount: count,
        active: false, // pane 归属不了窗口，无从判定聚焦，不谎报
        full: false, // pane 数反查不到 → 定不了满，不谎报（可达性由落子自愈）
      },
    ];
  }

  /** 定点附加：命名窗口里分屏跑命令；窗口已关则 wt 重建（原生语义，落点自愈）。 */
  override async runAt(dir: string, argv: string[], targetId: string): Promise<LaunchOrigin | null> {
    if (this.platform !== 'win32') {
      throw new Error(`Terminal preset "${this.preset}" is unavailable on this platform`);
    }
    if (!parseWtTargetId(targetId)) throw new Error(`Invalid terminal target "${targetId}"`);
    await this.spawnFirst(
      [
        {
          command: 'wt.exe',
          args: [
            '-w',
            wtWindowSlug(dir),
            'split-pane',
            '-d',
            dir,
            ...(throughCmd(argv, true) ?? []),
          ],
        },
      ],
      `Terminal preset "${this.preset}" is unavailable on this platform`,
    );
    return null;
  }

  /**
   * 唤出：wt 的 CLI 只有 stdin 通道、进程本身也拿不到窗口号，所以按「这个项目的
   * pane 进程」反查窗口——往上找到宿主 `WindowsTerminal.exe`（wt 一窗一进程），
   * 那个进程的顶层窗口就是要抬的那个；进程和窗口对不上就抛真相，不瞎抬。
   */
  override async focusTarget(dir: string, targetId: string): Promise<void> {
    if (!parseWtTargetId(targetId)) throw new Error(`Invalid terminal target "${targetId}"`);
    const key = normalizeDirKey(dir, this.platform);
    const pids = (await wtPanesCached())
      .filter((p) => key !== null && normalizeDirKey(p.cwd, this.platform) === key)
      .map((p) => p.pid);
    if (!pids.length) throw new Error('That terminal is gone — reopen the list');
    await winRaiseTerminalWindow({ panePids: pids, exe: 'windowsterminal.exe' });
  }

  /**
   * 层② 定位：会话自己上报的 `CLAUDE_PID` 就是那个 pane 的 console 客户端
   * （hook 是它的子进程，跑在同一个 ConPTY 里）。WT 没有 pane 号通道，故 pane
   * id = 该 pid；存在性校验 = pid 还活着（死了宁可 null，回落标题+cwd）。
   */
  override async locatePane(env: Record<string, string>): Promise<string | null> {
    const pid = wtPanePidFromEnv(env);
    if (pid == null || !pidAlive(pid)) return null;
    return `wt:${pid}`;
  }

  /** 本后端的 pane id 表示法 = `wt:<pid>`（见 parseWtPaneId）。 */
  override ownsPaneId(paneId: string): boolean {
    return parseWtPaneId(paneId) !== null;
  }

  /**
   * prompt 层② 注入：bracketed paste 打原文（内含 CR 是字面内容、不提交）→
   * 补一记 CR 提交。与 wezterm 那条通道同语义，只是键记录直写 console。
   */
  override async sendPromptText(paneId: string, text: string): Promise<void> {
    const pid = parseWtPaneId(paneId);
    if (pid == null) throw new Error(`Invalid prompt pane "${paneId}"`);
    await wtInjectKeys(pid, `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}\r`);
  }

  /** 裸键序（阻塞问答作答 / 中断 ESC）：控制字符按真键记录下发（见 wtInjectKeys）。 */
  override async sendKeys(paneId: string, keys: string): Promise<void> {
    const pid = parseWtPaneId(paneId);
    if (pid == null) throw new Error(`Invalid prompt pane "${paneId}"`);
    await wtInjectKeys(pid, keys);
  }
}
