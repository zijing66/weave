import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { TERMINAL_LOCATOR_ENV } from '@weavecode/core';
import { pidAlive } from './claude-liveness.js';
import { readDaemonSettings, type TerminalPreset, type TerminalSettings } from './settings.js';
import { joinCmd, quotePath, throughCmd } from './opener/shared.js';
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
} from './opener/wt.js';
import { winRaiseTerminalWindow } from './opener/win-raise.js';
import {
  doScriptInTerminalWindow,
  listTerminalAppSurfaces,
  listTerminalAppTargets,
  parseTerminalAppTargetId,
  pickTerminalAppWindow,
  terminalAppSurfacesCached,
} from './opener/pty-terminals.js';
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
export { planWeztermGrid } from './opener/wezterm-mux.js';
export type { WtProcRow } from './opener/wt.js';
export { quotePath } from './opener/shared.js';
import {
  MAX_PANES_PER_SCREEN,
  planWeztermGrid,
  weztermSpawnAndSend,
  captureCommand,
  countWindowsByDir,
  listAttachTargets,
  normalizeDirKey,
  openInWezterm,
  parseAttachTargetId,
  runInWezterm,
  weztermCli,
  weztermGuiPidOf,
  weztermLiveMuxes,
  weztermMuxForId,
  weztermMuxKey,
  weztermPaneFromEnv,
  sessionScreensFromEnvs,
  weztermStepError,
  type CaptureResult,
  type WeztermMux,
} from './opener/wezterm-mux.js';
import type { AttachTarget, SessionTerminal } from './opener/wezterm-mux.js';
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

/**
 * Cross-platform "open this directory" helpers behind the project context
 * menu: the OS file manager (Explorer/Finder/xdg-open) and a terminal at that
 * directory.
 *
 * Launches use argument-array spawns (never a shell string), so directory
 * names cannot inject commands. The one exception is the `custom` terminal
 * preset, which is a user-authored command template and deliberately goes
 * through a shell — the daemon is localhost-only and token-authenticated.
 */

/** One spawn candidate: earlier entries are tried first (auto-probing). */
export interface TerminalLaunch {
  command: string;
  args: string[];
  /** Working directory for the spawned process (inherited cwd). */
  cwd?: string;
  /** Run through the platform shell (custom commands only). */
  shell?: boolean;
}


/**
 * macOS: build an AppleScript launch that opens a new window at `dir` running
 * `argv` (the `open -a` handlers cannot pass a command).
 */
function osascriptRun(
  app: 'Terminal' | 'iTerm',
  dir: string,
  argv: string[],
): string[] {
  // 'darwin' 走 quoteArg/quotePath 的 POSIX 分支（osascript 只在 macOS 路径出现）
  const shell = `cd ${quotePath(dir, 'darwin')} && ${joinCmd(argv, 'darwin')}`;
  const text = shell.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (app === 'Terminal') {
    return [
      '-e',
      `tell application "Terminal" to do script "${text}"`,
      '-e',
      'tell application "Terminal" to activate',
    ];
  }
  return [
    '-e',
    'tell application "iTerm" to create window with default profile',
    '-e',
    `tell application "iTerm" to tell current window to write text "${text}"`,
  ];
}

// ---- 终端后端：模板方法 ----
//
// 骨架固定为「取候选 → 按序尝试 → 全失败抛真相」（TerminalBackend.spawnFirst），
// 子类只填两处差异：候选表、以及流程真的不同的那个 preset（wezterm 的 run 必须走
// mux 通道）。**能力全归后端**，一律「覆写 = 有，基类空实现 = 没有」：
// enumerable（能否反查已开窗口，不是调用方散写的 `preset === 'wezterm'` 白名单）、
// textAddressable（能否注入文本 / 裸键序）、locatePane（能否把 hook 上报的 pane env
// 解析回本后端的 pane 表示法——pane 表示法是后端私有知识，调用方只见不透明 id）、
// ownsPaneId（这个 id 是不是本后端发的——**击键/文本按 id 认领后端**，故「往哪个终端
// 打键」不随设置里的 preset 走）。
// 不支持就走基类空实现（角标不显示 / 层② 诚实置灰 / 回落标题+cwd 启发式，不谎报）。

/**
 * prompt 层② 兜底的注入落点：后端枚举出的可打文本 pane。
 * id 不透明、格式归各后端（wezterm = `<mux 短哈希>:<paneId>`）。
 */
export interface PromptPaneTarget {
  id: string;
  /** pane 标题（claude 的 OSC 标题）——与会话标题匹配的素材；取不到 = null。 */
  title: string | null;
  /** pane 实时工作目录；取不到 = null（匹配不上任何项目）。 */
  cwd: string | null;
}

/** prompt pane id ↔ (mux, paneId) 解码；坏 id → null。 */
export function parsePromptPaneId(id: string): { muxKey: string; paneId: number } | null {
  const m = /^([0-9a-f]{8}):(\d+)$/.exec(id);
  if (!m) return null;
  return { muxKey: m[1]!, paneId: Number(m[2]) };
}

/**
 * 起会话落子的起点定位（spawn 回执）：env 形状与 hook 旁路上报同构（键形归
 * 后端、出 core 表），paneEnvSource='launch' 的 harness 据此关联会话。拿不到
 * 回执的后端（wt 等 stdio ignore 路径）不产出——那些会话不分组，不猜。
 */
export interface LaunchOrigin {
  readonly env: Record<string, string>;
}

/** 终端后端基类。模板方法定义骨架，子类只填候选与真正不同的流程。 */
export abstract class TerminalBackend {
  protected constructor(
    readonly preset: TerminalPreset,
    /** 能否反查已开窗口 / 可附加目标（默认否：不是每种终端都问得到）。 */
    readonly enumerable: boolean,
    protected readonly platform: NodeJS.Platform = process.platform,
    /** 能否给已开 pane 注入文本（prompt 层② send-text 兜底；默认否，不谎报）。 */
    readonly textAddressable: boolean = false,
  ) {}

  /** 启动候选（按序尝试，第一个起的算成功）；空 = 本平台不支持该 preset。 */
  abstract candidates(dir: string, run?: string[]): TerminalLaunch[];

  /** 开一个终端（模板方法）。 */
  async open(dir: string): Promise<void> {
    await this.spawnFirst(
      this.candidates(dir),
      `Terminal preset "${this.preset}" is unavailable on this platform`,
    );
  }

  /**
   * 开一个终端并把 `argv` 送进去（模板方法）。缺省把命令并进候选参数；wezterm
   * 覆写为走 mux——唯一流程真正不同的 preset（legacy `start -- PROG` 绕过
   * default_prog，且 mux 在时会挂死出无窗僵尸而 trySpawn 假成功）。返回落子的
   * 起点（spawn 回执）；候选路径无回执 = null。
   */
  async run(dir: string, argv: string[]): Promise<LaunchOrigin | null> {
    await this.spawnFirst(
      this.candidates(dir, argv),
      `Terminal preset "${this.preset}" cannot run a command here — pick another preset in settings`,
    );
    return null;
  }

  /** 每目录已开终端数（单位 = 本后端的可见屏幕）；不支持的 preset 走这里（空表 = 角标不显示，不谎报）。 */
  async countWindows(_dirs: readonly string[]): Promise<Map<string, number>> {
    return new Map();
  }

  /** 可附加目标（窗口内的 tab）；不支持的 preset 走这里。 */
  async listTargets(_dir: string): Promise<AttachTarget[]> {
    return [];
  }

  /** 定点附加（多终端弹窗选定的目标）；无通道的 preset 明确拒绝，不静默忽略。 */
  async runAt(_dir: string, _argv: string[], _targetId: string): Promise<LaunchOrigin | null> {
    throw new Error(
      `Terminal preset "${this.preset}" cannot attach to a chosen pane — pick wezterm, wt or Terminal.app in settings`,
    );
  }

  /** 唤出（切到前台）已开终端；无通道的 preset 明确拒绝。 */
  async focusTarget(_dir: string, _targetId: string): Promise<void> {
    throw new Error(
      `Terminal preset "${this.preset}" cannot bring an open terminal to the front — pick wezterm or wt in settings`,
    );
  }

  /** prompt 层② 兜底：枚举可注入文本的 pane；无通道的后端空表（不谎报）。 */
  async listPromptPanes(): Promise<PromptPaneTarget[]> {
    return [];
  }

  /** 层② 定位：pane env → pane id；无定位能力的后端 null（回落标题+cwd，不猜）。 */
  async locatePane(_env: Record<string, string>): Promise<string | null> {
    return null;
  }

  /** 这个 pane id 是不是本后端发的（id 表示法归本后端）；默认不是，不抢别人的 id。 */
  ownsPaneId(_paneId: string): boolean {
    return false;
  }

  /** 会话 → 所在可见屏幕（会话列表分块）；无枚举能力的后端空表（不分组，不猜）。 */
  async locateScreens(
    _envs: Record<string, Record<string, string>>,
  ): Promise<Record<string, SessionTerminal | null>> {
    return {};
  }

  /** prompt 层② 兜底：向枚举所得 pane 注入 prompt 原文并提交；无通道的后端明确拒绝。 */
  async sendPromptText(_paneId: string, _text: string): Promise<void> {
    throw new Error(
      `Terminal preset "${this.preset}" cannot send text into an open pane — pick wezterm in settings`,
    );
  }

  /** 阻塞问答作答：裸键序注入（模态框只吃键盘，不吃粘贴文本）；无通道的后端明确拒绝。 */
  async sendKeys(_paneId: string, _keys: string): Promise<void> {
    throw new Error(
      `Terminal preset "${this.preset}" cannot send keys to an open pane — pick wezterm in settings`,
    );
  }

  /**
   * 读 pane 可视屏文本（旁路会话读屏通道用）；无读屏能力的后端 null（不谎报）。
   * 只回可视屏（scrollback 不取）——读屏消费方（侧问回答提取）只需要当下画面。
   */
  async getPaneText(_paneId: string): Promise<string | null> {
    return null;
  }

  /** 关掉这个 pane（会话生命周期收尾 / 项目关终端共用）；无通道的后端明确拒绝。 */
  async closePane(_paneId: string): Promise<void> {
    throw new Error(
      `Terminal preset "${this.preset}" cannot close an open pane — pick wezterm in settings`,
    );
  }

  /** 按候选顺序起一个；全失败抛真相（含试过哪些命令）。 */
  protected async spawnFirst(candidates: TerminalLaunch[], emptyReason: string): Promise<void> {
    for (const launch of candidates) {
      if (await trySpawn(launch)) return;
    }
    throw new Error(
      candidates.length === 0
        ? emptyReason
        : 'No usable terminal found (tried: ' + candidates.map((c) => c.command).join(', ') + ')',
    );
  }
}

/** 候选数据驱动的后端：绝大多数 preset 只差一张候选表。 */
class CandidatesBackend extends TerminalBackend {
  constructor(
    preset: TerminalPreset,
    platform: NodeJS.Platform,
    private readonly make: (
      dir: string,
      run: string[] | undefined,
      platform: NodeJS.Platform,
    ) => TerminalLaunch[],
  ) {
    super(preset, false, platform);
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    return this.make(dir, run, this.platform);
  }
}

/** 各 preset 的候选表（纯数据）；`auto` 由这些具名条目组合，不再各抄一遍。 */
const PRESET_CANDIDATES: Record<
  Exclude<TerminalPreset, 'auto' | 'custom' | 'wezterm'>,
  (dir: string, run: string[] | undefined, platform: NodeJS.Platform) => TerminalLaunch[]
> = {
  wt: (dir, run, platform) =>
    platform === 'win32'
      ? [
          {
            command: 'wt.exe',
            args: [
              // 命名窗口：wt 原生「在则进 tab、不在则开窗」= 复用项目窗口的落点语义
              '-w',
              wtWindowSlug(dir),
              '-d',
              dir,
              ...(throughCmd(run, true) ?? []),
            ],
          },
        ]
      : [],
  powershell: (dir, run, platform) =>
    platform === 'win32'
      ? [
          run
            ? { command: 'powershell.exe', args: ['-NoExit', '-Command', joinCmd(run, 'win32')], cwd: dir }
            : { command: 'powershell.exe', args: ['-NoExit'], cwd: dir },
        ]
      : [],
  cmd: (dir, run, platform) =>
    platform === 'win32'
      ? [
          run
            ? { command: 'cmd.exe', args: ['/K', joinCmd(run, 'win32')], cwd: dir }
            : { command: 'cmd.exe', args: ['/K'], cwd: dir },
        ]
      : [],
  terminal: (dir, run, platform) => {
    if (platform !== 'darwin') return [];
    return run
      ? [{ command: 'osascript', args: osascriptRun('Terminal', dir, run) }]
      : [{ command: 'open', args: ['-a', 'Terminal', dir] }];
  },
  iterm: (dir, run, platform) => {
    if (platform !== 'darwin') return [];
    return run
      ? [{ command: 'osascript', args: osascriptRun('iTerm', dir, run) }]
      : [{ command: 'open', args: ['-a', 'iTerm', dir] }];
  },
  // gnome/konsole 不按平台过滤：选项可能来自另一台机器（settings 注释同此口径）。
  gnome: (dir, run) => [
    {
      command: 'gnome-terminal',
      args: [`--working-directory=${dir}`, ...(run ? ['--', ...run] : [])],
    },
  ],
  konsole: (dir, run) => [
    { command: 'konsole', args: ['--workdir', dir, ...(run ? ['-e', ...run] : [])] },
  ],
  ghostty: (dir, run, platform) => {
    // No Windows build, so nothing to launch there.
    if (platform === 'win32') return [];
    // On macOS the `ghostty` binary is only a helper CLI — it cannot start the
    // app, so go through the bundle the way the Terminal/iTerm entries do.
    // Ghostty registers a folder open handler that lands the new window in that
    // directory. The bundle open cannot run a command.
    if (platform === 'darwin') {
      return run ? [] : [{ command: 'open', args: ['-a', 'Ghostty', dir] }];
    }
    // On Linux `--working-directory` is a config key, also accepted as a
    // command-line flag when launching.
    return [
      {
        command: 'ghostty',
        args: [`--working-directory=${dir}`, ...(run ? ['-e', ...run] : [])],
      },
    ];
  },
};

/** custom：用户自撰命令模板（唯一需要读 settings 的后端）。 */
class CustomBackend extends TerminalBackend {
  constructor(
    private readonly terminal: TerminalSettings,
    platform: NodeJS.Platform,
  ) {
    super('custom', false, platform);
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    const template = this.terminal.customCommand.trim();
    if (!template) return [];
    let command = template.replace(/\{path\}/g, quotePath(dir, this.platform));
    const cmd = run ? joinCmd(run, this.platform) : '';
    command = command.includes('{command}')
      ? command.replace(/\{command\}/g, cmd)
      : run
        ? `${command} ${cmd}`
        : command;
    return [{ command, args: [], shell: true }];
  }
}

/**
 * ghostty：Linux 上先走 `+new-window` IPC（窗口开进已运行实例，1.2.0+；GTK
 * 实现，见源码 src/apprt/gtk/ipc）——IPC 是短命 CLI、按退出码判成败，不能进
 * 候选表（trySpawn 只看进程起了没，会假成功），故覆写 open/run。无实例/未配
 * D-Bus 激活时非零退出 → 兜底独立进程候选。`-e` 后的 argv 原样直达（中间无
 * shell），与 send-text 路径不同、无需引号。反查无通道（无 list 类命令），
 * 不谎报。
 */
class GhosttyBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    super('ghostty', false, platform);
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    return PRESET_CANDIDATES.ghostty(dir, run, this.platform);
  }

  private async openViaIpcThenStandalone(dir: string, argv: string[]): Promise<void> {
    if (this.platform === 'linux') {
      const args = [
        '+new-window',
        `--working-directory=${dir}`,
        ...(argv.length > 0 ? ['-e', ...argv] : []),
      ];
      const r = await captureCommand('ghostty', args);
      if (r?.ok) return;
    }
    await this.spawnFirst(
      this.candidates(dir, argv.length > 0 ? argv : undefined),
      `Terminal preset "${this.preset}" is unavailable on this platform`,
    );
  }

  override open(dir: string): Promise<void> {
    return this.openViaIpcThenStandalone(dir, []);
  }

  override async run(dir: string, argv: string[]): Promise<LaunchOrigin | null> {
    await this.openViaIpcThenStandalone(dir, argv);
    return null;
  }
}

/**
 * Windows Terminal（win32）：无官方枚举 API，反查走进程树——每个 pane 的
 * shell 是 `WindowsTerminal.exe` 的直接子进程（`OpenConsole.exe` 是 ConPTY
 * 宿主、兄弟进程），shell 的 PEB cwd 即 pane 实时工作目录。pane 归属不到
 * 具体窗口（多窗口共进程、窗口名不外露），角标口径 = 本项目 pane 数（前端
 * 文案「N 个终端已打开」对窗口/pane 皆成立）。开窗/落点走 wt 命名窗口：
 * `-w <name>` 在则进 tab、不在则重建——天然就是「复用项目窗口」的落点语义，
 * 零簿记；定点附加 = 命名窗口里 split-pane（分屏）。
 */
class WtBackend extends TerminalBackend {
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

class WeztermBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    super('wezterm', true, platform, true);
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    // `start` opens the GUI (or a new window in an existing one) and `--cwd`
    // applies to the first program it spawns. Cross-platform.
    return [
      {
        command: 'wezterm',
        args: ['start', '--cwd', dir, ...(throughCmd(run, this.platform === 'win32') ?? [])],
      },
    ];
  }

  /**
   * 开终端（不带命令）：有活实例 → 在实例里开新窗口落子（与会话列表的新终端
   * 同一条 mux 通道）；一个活实例都没有 → 回落 legacy `start` 起新 GUI（第一台
   * 终端总得有人开）。**不能只靠 `start`**：Windows 上它恒起一个新 GUI 进程、
   * 不并进已开实例（实测 `WEZTERM_UNIX_SOCKET` 指着活实例也照样新起），那是
   * 另一套窗口/实例，跟用户日常那个 wezterm 不是一回事。
   */
  override async open(dir: string): Promise<void> {
    if (await openInWezterm(dir)) return;
    await super.open(dir);
  }

  /**
   * 带命令开终端：有活实例 → mux 落子；**一个活实例都没有 → 回落 legacy `start`**
   * （与 `open` 同一条回落）——那是「用户此刻还没开 wezterm」的常态，不是错误：
   * `start --cwd dir <cmd>` 起新 GUI 并把命令跑在里面。原先这里一律 400
   * 「wezterm mux undiscoverable — is wezterm running?」，用户点「打开终端」得到的
   * 却是一条报错；「`start` 在 mux 在时会挂死出无窗僵尸」那条只对活实例成立。
   */
  override async run(dir: string, argv: string[]): Promise<LaunchOrigin | null> {
    const origin = await runInWezterm(dir, argv);
    if (origin) return origin;
    return super.run(dir, argv);
  }

  override async countWindows(dirs: readonly string[]): Promise<Map<string, number>> {
    if (dirs.length === 0) return new Map();
    const { muxes } = await weztermLiveMuxesCached();
    if (muxes.length === 0) return new Map(dirs.map((dir) => [dir, 0]));
    return countWindowsByDir(
      dirs,
      muxes.flatMap((mux) =>
        mux.panes.map((pane) => ({
          muxKey: mux.socket,
          windowId: pane.windowId,
          tabId: pane.tabId,
          cwd: pane.cwd,
        })),
      ),
    );
  }

  override listTargets(dir: string): Promise<AttachTarget[]> {
    return listAttachTargets(dir, this.platform);
  }

  override runAt(dir: string, argv: string[], targetId: string): Promise<LaunchOrigin | null> {
    return runInWeztermAt(dir, argv, targetId, this.platform);
  }

  /** 唤出两步：`activate-pane` 只切 mux 内部的焦点（实测不抬 OS 窗口、不解最小化），
   *  Windows 上还得在那个 GUI 进程的窗口里按标题认出来抬（OS 窗口标题 = 该窗口活动
   *  pane 的标题）。 */
  override async focusTarget(_dir: string, targetId: string): Promise<void> {
    const parsed = parseAttachTargetId(targetId);
    if (!parsed) throw new Error(`Invalid terminal target "${targetId}"`);
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) throw new Error('wezterm instance is gone — cannot bring the terminal to the front');
    const pane = mux.panes.find(
      (p) => p.windowId === parsed.windowId && p.tabId === parsed.tabId,
    );
    if (!pane) throw new Error('That terminal is gone — reopen the list');
    const args = ['cli', 'activate-pane', '--pane-id', String(pane.paneId)];
    const res = await weztermCli(args, mux.socket);
    if (!res?.ok) throw new Error(weztermStepError(args, mux.socket, res));
    if (this.platform !== 'win32') return;
    // activate 之后的标题才是 OS 窗口标题；目标 pane 的标题最可信，同窗口其它 pane
    // 次之（OS 标题可能停在别的 tab 上一次上报的那一帧）。
    const after = (await weztermMuxForId(parsed.muxKey))?.panes ?? mux.panes;
    const fresh = after.find((p) => p.paneId === pane.paneId) ?? pane;
    const titles = [
      fresh.title,
      ...after.filter((p) => p.windowId === parsed.windowId).map((p) => p.title),
    ].filter((t): t is string => !!t);
    await winRaiseTerminalWindow({
      guiPid: weztermGuiPidOf(mux.socket) ?? undefined,
      titles,
    });
  }

  /** prompt 层②：跨 mux 摊平全部 pane（实时枚举——落点决策必须看实时世界）。 */
  override async listPromptPanes(): Promise<PromptPaneTarget[]> {
    const { muxes } = await weztermLiveMuxes();
    return muxes.flatMap((mux) =>
      mux.panes.map((p) => ({
        id: `${weztermMuxKey(mux.socket)}:${p.paneId}`,
        title: p.title,
        cwd: p.cwd,
      })),
    );
  }

  /**
   * 层② 定位（hook 旁路上报的 pane env → prompt pane id）：pane 号 + mux socket
   * 归位到该实例的活动 pane。**含存在性校验**——socket 对不上活 mux、pane 已不在
   * 一律 null（调用方回落标题+cwd 启发式，宁可少答也不往别人的 pane 打键）。
   */
  override async locatePane(env: Record<string, string>): Promise<string | null> {
    // 两个定位键缺任一即判「不是 wezterm 会话」：先判再枚举，省一轮 spawn
    // （判据与 weztermPaneFromEnv 同一条件，只是挪到枚举之前）。
    const [paneKey, socketKey] = TERMINAL_LOCATOR_ENV.wezterm;
    const socket = env[socketKey];
    if (!env[paneKey] || !socket) return null;
    // 只探会话自己上报的那个 socket（绕过探活闸）：投递路径已知目标，全量扫一遍
    // 既慢又会被冷却期误伤成「找不到 pane」。
    const { muxes } = await weztermLiveMuxes(true, socket);
    return weztermPaneFromEnv(env, muxes, this.platform);
  }

  /** 本后端的 pane id 表示法 = `<mux 短哈希>:<paneId>`（见 parsePromptPaneId）。 */
  override ownsPaneId(paneId: string): boolean {
    return parsePromptPaneId(paneId) !== null;
  }

  /**
   * 会话 → 可见屏幕（会话列表分块）：与 locatePane 同一份旁路 env，但**吃 10s
   * 探活缓存**——分组是展示面，滞后十秒无感，而它由计数探活同一轮触发（共用一次
   * `cli list`），不为此多 spawn。
   */
  override async locateScreens(
    envs: Record<string, Record<string, string>>,
  ): Promise<Record<string, SessionTerminal | null>> {
    if (Object.keys(envs).length === 0) return {};
    const { muxes, candidates } = await weztermLiveMuxesCached();
    return sessionScreensFromEnvs(envs, muxes, candidates, this.platform);
  }

  /**
   * prompt 层② 注入（spike 字节级实测配方）：bracketed paste 打原文（内含
   * CR 是字面内容、不会被终端解释提交）→ `--no-paste` 补一记 CR 提交。mux
   * 实时重枚举定位，目标没了 throw（消息转可见失败，不静默丢）。
   */
  override async sendPromptText(paneId: string, text: string): Promise<void> {
    const parsed = parsePromptPaneId(paneId);
    if (!parsed) throw new Error(`Invalid prompt pane "${paneId}"`);
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) throw new Error('wezterm instance is gone — cannot deliver prompt');
    const pane = String(parsed.paneId);
    if (text) {
      const pasted = await weztermCli(['cli', 'send-text', '--pane-id', pane, text], mux.socket);
      if (!pasted?.ok) {
        throw new Error(
          weztermStepError(['cli', 'send-text', '--pane-id', pane, '<prompt text>'], mux.socket, pasted),
        );
      }
    }
    const submit = await weztermCli(['cli', 'send-text', '--pane-id', pane, '--no-paste', '\r'], mux.socket);
    if (!submit?.ok) {
      throw new Error(
        weztermStepError(['cli', 'send-text', '--pane-id', pane, '--no-paste', '<CR>'], mux.socket, submit),
      );
    }
  }

  /**
   * 裸键序进 pty（阻塞问答作答 / 会话中断的 ESC 共用这一条通道）：`--no-paste`
   * 绕过 bracketed paste，CR 字节即回车键、ESC 即中断。mux 定位口径与
   * sendPromptText 同。
   */
  override async sendKeys(paneId: string, keys: string): Promise<void> {
    const parsed = parsePromptPaneId(paneId);
    if (!parsed) throw new Error(`Invalid prompt pane "${paneId}"`);
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) throw new Error('wezterm instance is gone — cannot send keys to the pane');
    const pane = String(parsed.paneId);
    const sent = await weztermCli(
      ['cli', 'send-text', '--pane-id', pane, '--no-paste', keys],
      mux.socket,
    );
    if (!sent?.ok) {
      throw new Error(
        weztermStepError(['cli', 'send-text', '--pane-id', pane, '--no-paste', '<keys>'], mux.socket, sent),
      );
    }
  }

  /**
   * 关 pane（`wezterm cli kill-pane`）：宿主随 pane 一起退出——这就是「退出会话」
   * 的远程等价（harness 没有「请退出」这种信号，pane 没了它就没了）。mux 定位口径
   * 与 sendKeys 同；目标没了 throw，不静默假装关掉了。
   */
  override async closePane(paneId: string): Promise<void> {
    const parsed = parsePromptPaneId(paneId);
    if (!parsed) throw new Error(`Invalid prompt pane "${paneId}"`);
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) throw new Error('wezterm instance is gone — cannot close the pane');
    const pane = String(parsed.paneId);
    const killed = await weztermCli(['cli', 'kill-pane', '--pane-id', pane], mux.socket);
    if (!killed?.ok) {
      throw new Error(weztermStepError(['cli', 'kill-pane', '--pane-id', pane], mux.socket, killed));
    }
  }

  /** 读 pane 可视屏（`cli get-text`）：mux 定位口径与 sendKeys 同；失败 null（不猜）。 */
  override async getPaneText(paneId: string): Promise<string | null> {
    const parsed = parsePromptPaneId(paneId);
    if (!parsed) return null;
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) return null;
    const got = await weztermCli(
      ['cli', 'get-text', '--pane-id', String(parsed.paneId)],
      mux.socket,
    );
    return got?.ok ? got.out : null;
  }
}

/** auto：把本平台的具名 preset 候选按序串起来（与具名条目同源）。 */
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
// ---- Terminal.app 通道（macOS）：osascript 反查 + do script 落子 ----
//
// Terminal.app 无分屏，tab 即整面；AppleScript 的 `do script "…" in <窗口>`
// 在指定窗口开新 tab（`in` 缺省 = 新窗口）。反查走 tty 桥：tab 的 tty →
// `ps` 找该 tty 的进程树根（shell；被 exec 替换成 claude 时就是 claude 本身，
// cwd 口径不变）→ `lsof` 取根进程 cwd。daemon 控制 Terminal.app 需 macOS
// 自动化授权（TCC），未授权时 AppleEvent 失败 → 枚举空表/落子 false，不谎报。



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

/**
 * 定点附加（用户在会话终端弹窗里选的 tab）：实时重枚举定位目标，目标不在了
 * 就 throw——让前端报「该终端已关闭，请重选」，绝不静默换到别处（换了就是
 * 「我点了 A，命令进了 B」）；已长满同样明确拒绝（**不擅自另开窗口**，那也是
 * 换地方），前端同一事实置灰，用户自己决定开新终端还是挑别的。
 */
export async function runInWeztermAt(
  dir: string,
  argv: string[],
  targetId: string,
  platform: NodeJS.Platform = process.platform,
): Promise<LaunchOrigin | null> {
  const parsed = parseAttachTargetId(targetId);
  if (!parsed) throw new Error(`Invalid terminal target "${targetId}"`);
  const { muxes } = await weztermLiveMuxes();
  const mux = muxes.find((m) => weztermMuxKey(m.socket) === parsed.muxKey);
  if (!mux) throw new Error('wezterm instance is gone — pick a terminal again');
  const tabPanes = mux.panes.filter(
    (p) => p.windowId === parsed.windowId && p.tabId === parsed.tabId,
  );
  if (tabPanes.length === 0) throw new Error('terminal tab is gone — pick a terminal again');
  if (tabPanes.length >= MAX_PANES_PER_SCREEN) {
    throw new Error(
      `terminal is full (${MAX_PANES_PER_SCREEN} panes) — pick another terminal or open a new one`,
    );
  }
  return weztermSpawnAndSend(mux.socket, dir, argv, planWeztermGrid(tabPanes), mux.workspace, platform);
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
 * 探活结果短缓存（10s）：角标的周期探测 + 开窗后对账 + GET 后台对账会在
 * 瞬间打多枪，缓存挡掉重复 spawn——一枪要对**每个存活 socket** spawn 一次
 * `wezterm cli list`（实测 wall ~180ms / CPU 62–125ms；残留幽灵 GUI 会把
 * socket 数放大）。**只给计数用**（light 探测，workspace/idle 留空）：
 * runInWezterm 的落点决策必须看实时世界（缓存会让分屏落到刚关掉的 pane）。
 */
let muxCache: { at: number; muxes: WeztermMux[]; candidates: string[] } | null = null;

export async function weztermLiveMuxesCached(): Promise<{ muxes: WeztermMux[]; candidates: string[] }> {
  if (muxCache && Date.now() - muxCache.at < 10000) return muxCache;
  const { muxes, candidates } = await weztermLiveMuxes(true);
  muxCache = { at: Date.now(), muxes, candidates };
  return muxCache;
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

/** Spawn detached and forget: the child outlives the daemon, its window is
 * its own, and I/O is dropped so a GUI process never blocks on pipes. */
export function trySpawn(launch: TerminalLaunch): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        shell: launch.shell,
        detached: true,
        stdio: 'ignore',
      });
    } catch {
      resolve(false);
      return;
    }
    // ENOENT and friends surface asynchronously on the 'error' event; a
    // successful launch emits 'spawn' immediately (we do not wait for exit).
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** Try candidates in order until one launches (auto-probe fallback). */

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
/** wezterm：run 走 mux 通道；窗口/pane 反查走 `cli list`；prompt 文本走 send-text。 */
class KonsoleBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    super('konsole', false, platform, platform === 'linux');
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    return PRESET_CANDIDATES.konsole(dir, run, this.platform);
  }

  override async locatePane(env: Record<string, string>): Promise<string | null> {
    return konsolePaneFromEnv(env);
  }

  override ownsPaneId(paneId: string): boolean {
    return parseKonsolePaneId(paneId) !== null;
  }

  override async sendPromptText(paneId: string, text: string): Promise<void> {
    const target = parseKonsolePaneId(paneId);
    if (!target) throw new Error(`Invalid prompt pane "${paneId}"`);
    if (text) await konsoleCall(target, 'sendText', text);
    await konsoleCall(target, 'sendKey', String(QT_KEY_RETURN));
  }

  override async sendKeys(paneId: string, keys: string): Promise<void> {
    const target = parseKonsolePaneId(paneId);
    if (!target) throw new Error(`Invalid prompt pane "${paneId}"`);
    for (const ch of keys) await konsoleCall(target, 'sendKey', String(qtKeyOf(ch)));
  }
}

/** Konsole 的 pane id ↔ (D-Bus 服务名, 会话路径)；坏 id → null。 */
export function parseKonsolePaneId(id: string): { service: string; session: string } | null {
  const m = /^konsole:([\w.:-]+)\|(\/[\w/]+)$/.exec(id);
  return m ? { service: m[1]!, session: m[2]! } : null;
}

/** 上报的 pane env → Konsole 的 pane id；不是 Konsole 会话（缺键）→ null。 */
export function konsolePaneFromEnv(env: Record<string, string>): string | null {
  const [serviceKey, sessionKey] = TERMINAL_LOCATOR_ENV.konsole;
  const service = env[serviceKey];
  const session = env[sessionKey];
  if (!service || !session) return null;
  const id = `konsole:${service}|${session}`;
  return parseKonsolePaneId(id) ? id : null;
}

/** Qt::Key_Return（Konsole 的 sendKey 吃 Qt 键值）。 */
const QT_KEY_RETURN = 0x01000004;

/** 字符 → Qt 键值：控制键给真值，其余用码位（ASCII 与 Qt::Key 一致）。 */
export function qtKeyOf(ch: string): number {
  switch (ch) {
    case '\x1b':
      return 0x01000000;
    case '\r':
    case '\n':
      return QT_KEY_RETURN;
    case '\t':
      return 0x01000001;
    case '\b':
      return 0x01000003;
    default:
      return ch.codePointAt(0) ?? 0;
  }
}

/**
 * 调 Konsole 会话的 D-Bus 方法：先试 Qt 自带的 `qdbus(6/5)`（参数原样走 argv、
 * 无需拼引号），再回落到 dbus 本身的 `dbus-send`（`string:` 形参）。
 */
async function konsoleCall(
  target: { service: string; session: string },
  method: 'sendText' | 'sendKey',
  arg: string,
): Promise<void> {
  const attempts: Array<{ command: string; args: string[] }> = [
    ...['qdbus6', 'qdbus5', 'qdbus'].map((command) => ({
      command,
      args: [target.service, target.session, method, arg],
    })),
    {
      command: 'dbus-send',
      args: [
        '--session',
        '--type=method_call',
        `--dest=${target.service}`,
        target.session,
        `org.kde.konsole.Session.${method}`,
        `string:${arg}`,
      ],
    },
  ];
  let last: CaptureResult | null = null;
  for (const attempt of attempts) {
    const r = await captureCommand(attempt.command, attempt.args, undefined, 5000);
    if (r?.ok) return;
    last = r;
  }
  const detail = last ? last.err || last.out || 'unknown error' : 'no qdbus / dbus-send on PATH';
  throw new Error(`Konsole D-Bus call "${method}" failed: ${detail}`);
}

/**
 * iTerm2（macOS）：`ITERM_SESSION_ID`（`w0t0p0:<UUID>`）一条就唯一定位一个会话，
 * 文本走 AppleScript `write text`。**只有文本通道**——iTerm2 没有裸键序入口，
 * 中断/作答在这条路上诚实不支持（`sendKeys` 走基类拒绝，不假装能打）。
 * 同 Konsole：本机无法实机验证。
 */
class ItermBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    super('iterm', false, platform, platform === 'darwin');
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    return PRESET_CANDIDATES.iterm(dir, run, this.platform);
  }

  override async locatePane(env: Record<string, string>): Promise<string | null> {
    return itermPaneFromEnv(env);
  }

  override ownsPaneId(paneId: string): boolean {
    return parseItermPaneId(paneId) !== null;
  }

  override async sendPromptText(paneId: string, text: string): Promise<void> {
    const sessionId = parseItermPaneId(paneId);
    if (!sessionId) throw new Error(`Invalid prompt pane "${paneId}"`);
    await itermWriteText(sessionId, text);
  }
}

/** iTerm2 的 pane id ↔ 会话 unique id；坏 id → null。 */
export function parseItermPaneId(paneId: string): string | null {
  const m = /^iterm:(w\d+t\d+p\d+:[0-9A-Fa-f-]+)$/.exec(paneId);
  return m ? m[1]! : null;
}

/** 上报的 pane env → iTerm2 的 pane id；不是 iTerm 会话（缺键）→ null。 */
export function itermPaneFromEnv(env: Record<string, string>): string | null {
  const [sessionKey] = TERMINAL_LOCATOR_ENV.iterm;
  const raw = env[sessionKey];
  if (!raw) return null;
  const id = `iterm:${raw}`;
  return parseItermPaneId(id) ? id : null;
}

/** AppleScript 字符串字面量转义（反斜杠先转，免把引号转义再转一遍）。 */
export function applescriptString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function itermWriteText(sessionId: string, text: string): Promise<void> {
  const script = `tell application "iTerm2"
repeat with w in windows
repeat with t in tabs of w
repeat with s in sessions of t
if unique id of s is "${sessionId}" then
tell s to write text "${applescriptString(text)}"
return "ok"
end if
end repeat
end repeat
end repeat
end tell`;
  const r = await captureCommand('osascript', ['-e', script], undefined, 8000);
  if (!r) throw new Error('osascript is unavailable — cannot send text into iTerm2');
  if (!r.ok || !r.out.includes('ok')) {
    throw new Error(`iTerm2 write text failed: ${r.err || r.out || 'unknown error'}`);
  }
}

/**
 * Terminal.app（macOS）：枚举/定点全走 osascript + ps + lsof——tab 的 tty →
 * 该 tty 的进程树根（shell；被 exec 替换成 claude 时就是 claude 本身）→ lsof
 * 取 cwd。无分屏，tab 即整面；「pane 分屏」的等价物是新 tab：run 复用同项目
 * 窗口开新 tab，定点附加落在所选 tab 的窗口。枚举通道只在 darwin 存在，其它
 * 平台 enumerable=false。
 */
class TerminalAppBackend extends TerminalBackend {
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
