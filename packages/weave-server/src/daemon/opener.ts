import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readDaemonSettings, type TerminalPreset, type TerminalSettings } from './settings.js';

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

/** Quote a path for interpolation into a custom shell command. */
export function quotePath(dir: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // cmd.exe/PowerShell double-quoted string; `"` is not a legal Windows
    // filename character so no escaping is needed.
    return `"${dir}"`;
  }
  // POSIX single quotes; escape embedded single quotes POSIX-style.
  return `'${dir.replace(/'/g, "'\\''")}'`;
}

/** Quote one argv entry for a shell command line (win32: cmd/PowerShell; posix: sh). */
function quoteArg(arg: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return arg !== '' && !/[\s"&|<>^%]/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
  }
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Join argv into one shell command line for presets that take a command string. */
function joinCmd(argv: string[], platform: NodeJS.Platform): string {
  return argv.map((a) => quoteArg(a, platform)).join(' ');
}

/**
 * win32：`wt.exe` / `wezterm` 是直接 CreateProcess 派发，**不做 PATHEXT 解析** ——
 * 裸 `claude`（Windows 上只有 .cmd/.ps1 shim，没有同名 .exe）会报
 * `0x80070002 找不到文件`。统一经 cmd.exe 转发（cmd/powershell 预设本来就经 shell，
 * 所以只有这几个直发的预设需要）。`/k` 保留窗口：启动失败时用户看得见原因。
 */
function throughCmd(run: string[] | undefined, win: boolean): string[] | undefined {
  if (!win || !run || run.length === 0) return run;
  return ['cmd.exe', '/k', joinCmd(run, 'win32')];
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
// mux 通道）。**枚举能力也归后端**：「这个 preset 能不能反查已开窗口」不再是调用方
// 散写的 `preset === 'wezterm'` 白名单，而是后端覆没覆写那两个方法——不支持就走
// 基类空实现（角标不显示，不谎报）。

/** 终端后端基类。模板方法定义骨架，子类只填候选与真正不同的流程。 */
export abstract class TerminalBackend {
  protected constructor(
    readonly preset: TerminalPreset,
    /** 能否反查已开窗口 / 可附加目标（默认否：不是每种终端都问得到）。 */
    readonly enumerable: boolean,
    protected readonly platform: NodeJS.Platform = process.platform,
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
   * default_prog，且 mux 在时会挂死出无窗僵尸而 trySpawn 假成功）。
   */
  async run(dir: string, argv: string[]): Promise<void> {
    await this.spawnFirst(
      this.candidates(dir, argv),
      `Terminal preset "${this.preset}" cannot run a command here — pick another preset in settings`,
    );
  }

  /** 每目录已开窗口数；不支持的 preset 走这里（空表 = 角标不显示，不谎报）。 */
  async countWindows(_dirs: readonly string[]): Promise<Map<string, number>> {
    return new Map();
  }

  /** 可附加目标（窗口内的 tab）；不支持的 preset 走这里。 */
  async listTargets(_dir: string): Promise<WeztermAttachTarget[]> {
    return [];
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
      ? [{ command: 'wt.exe', args: ['-d', dir, ...(throughCmd(run, platform === 'win32') ?? [])] }]
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

/** wezterm：run 走 mux 通道；窗口/pane 反查也只有它问得到。 */
class WeztermBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    super('wezterm', true, platform);
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

  override async run(dir: string, argv: string[]): Promise<void> {
    await runInWezterm(dir, argv);
  }

  override async countWindows(dirs: readonly string[]): Promise<Map<string, number>> {
    if (dirs.length === 0) return new Map();
    const muxes = await weztermLiveMuxesCached();
    if (muxes.length === 0) return new Map(dirs.map((dir) => [dir, 0]));
    return countWindowsByDir(
      dirs,
      muxes.flatMap((mux) =>
        mux.panes.map((pane) => ({ muxKey: mux.socket, windowId: pane.windowId, cwd: pane.cwd })),
      ),
    );
  }

  override listTargets(dir: string): Promise<WeztermAttachTarget[]> {
    return listAttachTargets(dir, this.platform);
  }
}

/** auto：把本平台的具名 preset 候选按序串起来（与具名条目同源）。 */
class AutoBackend extends TerminalBackend {
  private readonly parts: TerminalBackend[];

  constructor(platform: NodeJS.Platform) {
    super('auto', true, platform);
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

  /** auto 在有 wezterm 的机器上开的就是 wezterm，反查口径随之。 */
  override countWindows(dirs: readonly string[]): Promise<Map<string, number>> {
    return new WeztermBackend(this.platform).countWindows(dirs);
  }

  override listTargets(dir: string): Promise<WeztermAttachTarget[]> {
    return new WeztermBackend(this.platform).listTargets(dir);
  }
}

const BACKEND_FACTORIES: Record<
  TerminalPreset,
  (terminal: TerminalSettings, platform: NodeJS.Platform) => TerminalBackend
> = {
  auto: (_terminal, platform) => new AutoBackend(platform),
  wt: (_terminal, platform) => new CandidatesBackend('wt', platform, PRESET_CANDIDATES.wt),
  powershell: (_terminal, platform) =>
    new CandidatesBackend('powershell', platform, PRESET_CANDIDATES.powershell),
  cmd: (_terminal, platform) => new CandidatesBackend('cmd', platform, PRESET_CANDIDATES.cmd),
  terminal: (_terminal, platform) =>
    new CandidatesBackend('terminal', platform, PRESET_CANDIDATES.terminal),
  iterm: (_terminal, platform) => new CandidatesBackend('iterm', platform, PRESET_CANDIDATES.iterm),
  gnome: (_terminal, platform) => new CandidatesBackend('gnome', platform, PRESET_CANDIDATES.gnome),
  konsole: (_terminal, platform) =>
    new CandidatesBackend('konsole', platform, PRESET_CANDIDATES.konsole),
  ghostty: (_terminal, platform) =>
    new CandidatesBackend('ghostty', platform, PRESET_CANDIDATES.ghostty),
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
function trySpawn(launch: TerminalLaunch): Promise<boolean> {
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

/** Open a terminal at `dir` that runs `argv` (e.g. `claude --resume <id>`).
 * Same detached semantics as `openInTerminal` — the process outlives the daemon. */
export async function runInTerminal(
  dir: string,
  argv: string[],
  terminal: TerminalSettings,
): Promise<void> {
  // wezterm 只走 mux：legacy `start -- PROG` 绕过 default_prog 不说，mux 在时
  // `start` 只会挂死出一个无窗僵尸 + trySpawn 假成功。失败一律抛真相。
  // 这条分流在 WeztermBackend 覆写的 run 里，不在这里 if preset。
  await terminalBackendFor(terminal).run(dir, argv);
}

// ---- wezterm mux 通道：同项目复用分屏，否则新窗口；失败要喊出来 ----
//
// `wezterm start -- PROG` 会绕过 default_prog 直派子进程（用户的 shell 配置、
// job 包裹、OSC 7 全部丢失），所以 run 路径首选 mux：panes 在 mux 里以
// default_prog 起，命令经 send-text 打进去。每个 GUI 实例各持有自己的 mux
// socket（gui-sock-<pid>），daemon 不在 pane 里、没有 wezterm 注入的
// WEZTERM_UNIX_SOCKET，必须主动发现并按存活/活跃度选 mux。任何失败一律
// throw——legacy `start` 在 mux 存在时是挂死假成功，静默落过去就是谎报 200。

/** `cli list` 里与布局决策相关的字段（left_col/top_row 是单元格坐标）。 */
export interface WeztermPaneInfo {
  windowId: number;
  tabId: number;
  paneId: number;
  cwd: string | null;
  left: number;
  top: number;
  /** 该 pane 是否当前聚焦（多终端弹窗的排序信号之一）。 */
  isActive: boolean;
  /** pane 标题（claude 的 OSC 标题）——弹窗标签的素材，缺省回落窗口/Tab 号。 */
  title: string | null;
}

export type WeztermDirection = 'right' | 'bottom';

/** 分屏落点：把哪个 pane 往哪个方向切。 */
export interface WeztermSplitTarget {
  paneId: number;
  direction: WeztermDirection;
}

/** 解析 `cli list --format json`；坏输入安全落空（上层转新窗口/回退）。 */
export function parseWeztermPanes(jsonText: string | null): WeztermPaneInfo[] {
  if (!jsonText) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const panes: WeztermPaneInfo[] = [];
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    if (typeof row?.pane_id !== 'number' || typeof row?.tab_id !== 'number') continue;
    panes.push({
      windowId: typeof row.window_id === 'number' ? row.window_id : 0,
      tabId: row.tab_id,
      paneId: row.pane_id,
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      left: typeof row.left_col === 'number' ? row.left_col : 0,
      top: typeof row.top_row === 'number' ? row.top_row : 0,
      isActive: row.is_active === true,
      title: typeof row.title === 'string' && row.title ? row.title : null,
    });
  }
  return panes;
}

/** file:/// URL/本地路径 → 规范比较键：统一斜杠、去尾斜杠，win 下压大小写。 */
function normalizeDirKey(raw: string | null, platform: NodeJS.Platform): string | null {
  if (!raw) return null;
  let s = raw;
  if (s.startsWith('file://')) {
    s = s.slice('file://'.length);
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
    // win：file:///D:/x → D:/x；posix：file:///tmp/x → /tmp/x
    if (platform === 'win32') s = s.replace(/^\//, '');
  }
  s = s.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s) return null;
  return platform === 'win32' ? s.toLowerCase() : s;
}

/** 跨 mux 摊平的 pane 行：计数只需 (mux 判别键, windowId, cwd)。 */
export interface WeztermMuxPane {
  muxKey: string;
  windowId: number;
  cwd: string | null;
}

/**
 * 已打开终端窗口计数（窗口级口径：distinct (mux, windowId)、任一 pane cwd 命中
 * 即计——不是分屏 pane 数、也不是会话数）。同一窗口多个 pane 同属一目录只计 1。
 */
export function countWindowsByDir(
  dirs: readonly string[],
  panes: readonly WeztermMuxPane[],
  platform: NodeJS.Platform = process.platform,
): Map<string, number> {
  const keys = dirs.map((d) => normalizeDirKey(d, platform));
  const windows = dirs.map(() => new Set<string>());
  for (const pane of panes) {
    const cwdKey = normalizeDirKey(pane.cwd, platform);
    if (!cwdKey) continue;
    for (let i = 0; i < dirs.length; i++) {
      if (keys[i] !== null && keys[i] === cwdKey) windows[i]!.add(`${pane.muxKey}#${pane.windowId}`);
    }
  }
  return new Map(dirs.map((d, i) => [d, windows[i]!.size]));
}

/** 匹配 pane 最多的 tab 复用（平手取最早 tab），tab 内完整 pane 集合参与布局。 */
function pickWeztermTab(key: string, panes: WeztermPaneInfo[], platform: NodeJS.Platform) {
  const matches = new Map<number, number>();
  for (const p of panes) {
    if (normalizeDirKey(p.cwd, platform) === key) {
      matches.set(p.tabId, (matches.get(p.tabId) ?? 0) + 1);
    }
  }
  let bestTab: number | null = null;
  let bestCount = 0;
  for (const [tabId, count] of matches) {
    if (bestTab === null || count > bestCount || (count === bestCount && tabId < bestTab)) {
      bestTab = tabId;
      bestCount = count;
    }
  }
  return bestTab;
}

/**
 * 一个 tab 内的网格生长：网格按 1 2 / 3 4 / 5 6 生长 —— 首个分屏向右开列，
 * 之后矮列的底格向下延伸，等高取左列。坐标用 `cli list` 报的 left_col/top_row，
 * 用户手工增删 pane 后依旧推导得出，不落持久状态。
 */
export function planWeztermGrid(tabPanes: WeztermPaneInfo[]): WeztermSplitTarget | null {
  if (tabPanes.length === 0) return null;
  if (tabPanes.length === 1) return { paneId: tabPanes[0]!.paneId, direction: 'right' };
  // 列 = left 值分组（升序）；单列 → 底格向右开第二列；多列 → 矮列底格向下
  const columns = new Map<number, WeztermPaneInfo[]>();
  for (const p of tabPanes) {
    const col = columns.get(p.left) ?? [];
    col.push(p);
    columns.set(p.left, col);
  }
  const ordered = [...columns.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, ps]) => [...ps].sort((a, b) => b.top - a.top));
  if (ordered.length === 1) {
    return { paneId: ordered[0]![0]!.paneId, direction: 'right' };
  }
  let target = ordered[0]!;
  for (const col of ordered) {
    if (col.length < target.length) target = col;
  }
  return { paneId: target[0]!.paneId, direction: 'bottom' };
}

/**
 * 同项目复用布局：挑「cwd 匹配该项目的 pane 最多」的 tab（平手取最早 tab），
 * 再按 tab 内网格生长推导落点。
 */
export function planWeztermReuse(
  dir: string,
  panes: WeztermPaneInfo[],
  platform: NodeJS.Platform = process.platform,
): WeztermSplitTarget | null {
  const key = normalizeDirKey(dir, platform);
  if (!key) return null;
  const tabId = pickWeztermTab(key, panes, platform);
  if (tabId === null) return null;
  return planWeztermGrid(panes.filter((p) => p.tabId === tabId));
}

/** 新项目窗：最近活跃 client 的 workspace（拿不到就省略，进 mux 默认 workspace）。 */
export function planWeztermNewWindow(dir: string, workspace: string | null): string[] {
  const args = ['cli', 'spawn', '--new-window', '--cwd', dir];
  if (workspace) args.push('--workspace', workspace);
  return args;
}

/** 会话终端可附加目标（多终端弹窗的选项）：wezterm 一个窗口内的一个 tab。 */
export interface WeztermAttachTarget {
  /** 不透明 id（`<mux 短哈希>:<windowId>:<tabId>`）——web 只见 id，不见本机 socket 路径。 */
  id: string;
  windowId: number;
  tabId: number;
  /** tab 聚焦 pane 的标题（claude 的 OSC 标题）；null 由前端回落「窗口 W · Tab T」文案。 */
  title: string | null;
  /** cwd 命中请求目录的 pane 数 / 该 tab 总 pane 数。 */
  matchCount: number;
  paneCount: number;
  /** 该 tab 内含聚焦 pane（窗口正看着它）。 */
  active: boolean;
}

/** mux socket → 不透明短标识（不回传本机路径）。 */
export function weztermMuxKey(socket: string): string {
  return createHash('sha256').update(socket).digest('hex').slice(0, 8);
}

/** 目标 id ↔ (mux, window, tab) 解码；坏 id → null。 */
export function parseAttachTargetId(
  id: string,
): { muxKey: string; windowId: number; tabId: number } | null {
  const m = /^([0-9a-f]{8}):(\d+):(\d+)$/.exec(id);
  if (!m) return null;
  return { muxKey: m[1]!, windowId: Number(m[2]), tabId: Number(m[3]) };
}

/**
 * 目标列表（纯函数）：**只列本项目名下的 tab**（至少一个 pane 的 cwd 命中该目录）
 * ——别的项目的终端不进来，用户不必在一堆无关窗口里挑。空表语义 = 该项目没有
 * 终端开着（调用方据此直接开新窗，而不是弹一个空选择框）。
 *
 * 排序（最近活跃从上往下）：① 整个 wezterm 实例更近活跃（mux 的 client idle
 * 更小）在前；② 同实例内含聚焦 pane 的 tab 在前；③ 其余按 tabId 降序（tab 越晚
 * 创建越可能更近用过）。`cli list` 不报任何时间戳，这是可得信号下的最佳近似。
 */
export function attachTargetsFromMuxes(
  dir: string,
  muxes: readonly { socket: string; idleMs: number; panes: WeztermPaneInfo[] }[],
  platform: NodeJS.Platform = process.platform,
): WeztermAttachTarget[] {
  const key = normalizeDirKey(dir, platform);
  if (!key) return [];
  const out: WeztermAttachTarget[] = [];
  for (const mux of [...muxes].sort((a, b) => a.idleMs - b.idleMs)) {
    const byTarget = new Map<string, WeztermPaneInfo[]>();
    for (const p of mux.panes) {
      const k = `${p.windowId}:${p.tabId}`;
      const list = byTarget.get(k) ?? [];
      list.push(p);
      byTarget.set(k, list);
    }
    const rows: WeztermAttachTarget[] = [];
    for (const [k, panes] of byTarget) {
      const matchCount = panes.filter((p) => normalizeDirKey(p.cwd, platform) === key).length;
      if (matchCount === 0) continue; // 非本项目终端 → 不进候选
      const windowId = Number(k.slice(0, k.indexOf(':')));
      const tabId = Number(k.slice(k.indexOf(':') + 1));
      const focus = panes.find((p) => p.isActive) ?? panes[0]!;
      rows.push({
        id: `${weztermMuxKey(mux.socket)}:${windowId}:${tabId}`,
        windowId,
        tabId,
        title: focus.title,
        matchCount,
        paneCount: panes.length,
        active: panes.some((p) => p.isActive),
      });
    }
    rows.sort((a, b) => Number(b.active) - Number(a.active) || b.tabId - a.tabId);
    out.push(...rows);
  }
  return out;
}

/** 目标列表（实时枚举，不吃探活缓存——用户手一划就可能关掉窗）。 */
export async function listAttachTargets(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<WeztermAttachTarget[]> {
  const { muxes } = await weztermLiveMuxes();
  return attachTargetsFromMuxes(dir, muxes, platform);
}

/** 活跃 client：workspace + idle 毫秒（idle 还用来在多个 mux 之间选最活跃的）。 */
interface WeztermActiveClient {
  workspace: string;
  idleMs: number;
}

/** list-clients JSON → idle 最小的 client；坏输入/无有效 client → null。 */
function weztermActiveClient(jsonText: string | null): WeztermActiveClient | null {
  if (!jsonText) return null;
  let clients: unknown;
  try {
    clients = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(clients)) return null;
  let best: WeztermActiveClient | null = null;
  for (const c of clients) {
    const client = c as { workspace?: unknown; idle_time?: { secs?: unknown; nanos?: unknown } };
    if (typeof client?.workspace !== 'string' || !client.workspace) continue;
    const idle = client.idle_time;
    const idleMs =
      (typeof idle?.secs === 'number' ? idle.secs * 1e3 : 0) +
      (typeof idle?.nanos === 'number' ? idle.nanos / 1e6 : 0);
    if (best === null || idleMs < best.idleMs) {
      best = { workspace: client.workspace, idleMs };
    }
  }
  return best;
}

/** list-clients JSON → 最近活跃（idle 最小）client 的 workspace；坏输入 null。 */
export function weztermActiveWorkspaceOf(jsonText: string | null): string | null {
  return weztermActiveClient(jsonText)?.workspace ?? null;
}

const WEZTERM_CLI_TIMEOUT_MS = 5000;

/** wezterm cli 调用结果：ok=rc0 且未超时；out/err 供上层拼错误文案。 */
interface WeztermCliResult {
  ok: boolean;
  out: string;
  err: string;
  timedOut: boolean;
}

/**
 * wezterm cli 子调用：null = 进程起不来（ENOENT 等）；其余带 rc/stdout/stderr。
 * socket 非空时经 WEZTERM_UNIX_SOCKET 指定 mux——daemon 不在 pane 里，没有
 * wezterm 注入的这个 env，不显式点名就会去连默认 sock/残留 socket 而误判。
 */
function weztermCli(args: string[], socket: string): Promise<WeztermCliResult | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('wezterm', args, {
        windowsHide: true,
        env: { ...process.env, WEZTERM_UNIX_SOCKET: socket },
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: WeztermCliResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    // 计时到点即 resolve——kill 对卡死进程可能无效，不 resolve 会挂死；
    // 废料管+unref，免得杀不掉的孤儿子进程拖着 daemon 事件loop
    const timer = setTimeout(() => {
      child.stdout.destroy();
      child.stderr?.destroy();
      child.unref();
      child.kill();
      finish({ ok: false, out, err: err.trim(), timedOut: true });
    }, WEZTERM_CLI_TIMEOUT_MS);
    timer.unref();
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      finish({ ok: code === 0, out, err: err.trim(), timedOut: false });
    });
  });
}

/** cli 步骤失败的诊断文案：socket + 命令 + stderr/超时，经路由 400 → 前端 toast。 */
function weztermStepError(args: string[], socket: string, r: WeztermCliResult | null): string {
  const cmd = `wezterm[${basename(socket)}] ${args.join(' ')}`;
  if (r === null) return `${cmd}: executable not found`;
  if (r.timedOut) return `${cmd}: timed out after ${WEZTERM_CLI_TIMEOUT_MS}ms`;
  return r.err ? `${cmd}: ${r.err}` : `${cmd}: exited with failure`;
}

/** gui-sock-<pid> 文件名自带 GUI 进程 pid，signal 0 探活。 */
function weztermPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 目录下 pid 仍活的 gui-sock 完整路径（pid 大→小 ≈ 新→旧）；io 失败当空目录。
 * 排序不碰 stat：win 下 AF_UNIX socket 文件 statSync 一律 EACCES。 */
function weztermGuiSocksIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const live: { path: string; pid: number }[] = [];
  for (const name of names) {
    const m = /^gui-sock-(\d+)$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!weztermPidAlive(pid)) continue;
    live.push({ path: join(dir, name), pid });
  }
  return live.sort((a, b) => b.pid - a.pid).map((s) => s.path);
}

/**
 * 候选 mux socket：进程 env 显式指定的最优先（daemon 一般没有，pane 内才有），
 * 其次存活 GUI 的 gui-sock-*（新的在前 ≈ 最近开的 wezterm 实例）。
 * 跳过裸 `sock`：指向死 mux-server 时 cli 会原地拉起一个无人看的幽灵 server
 * 还 rc=0 返回空世界，会造成新一轮假成功。
 */
function weztermSocketCandidates(platform: NodeJS.Platform): string[] {
  const out: string[] = [];
  if (process.env.WEZTERM_UNIX_SOCKET) out.push(process.env.WEZTERM_UNIX_SOCKET);
  const home = platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  if (home) out.push(...weztermGuiSocksIn(join(home, '.local', 'share', 'wezterm')));
  if (platform !== 'win32' && process.env.XDG_RUNTIME_DIR) {
    out.push(...weztermGuiSocksIn(join(process.env.XDG_RUNTIME_DIR, 'wezterm')));
  }
  return [...new Set(out)];
}

/** 一个探活通过的 mux：socket + pane 世界 + 活跃 client（workspace 与 idle）。 */
interface WeztermMux {
  socket: string;
  panes: WeztermPaneInfo[];
  workspace: string | null;
  idleMs: number;
}

/** 探活超时后回避多久（可能只是 GUI 忙，不是死了）。 */
const PROBE_TIMEOUT_COOLDOWN_MS = 60_000;

/**
 * 探活失败的 socket 记忆——避免对已知坏 socket 反复 spawn `wezterm cli`。
 *
 * 为什么需要：陈旧的 `gui-sock-<pid>` 不会自己消失（wezterm 退出不清理，实测
 * 攒到过 48 个），而对着死 socket 跑 `wezterm cli` 会**原地拉起幽灵 mux-server，
 * 甚至挂死**——实测一次探活 >250s 不返回，且代码里 5s 超时后的 kill「对卡死
 * 进程可能无效」，于是每次枚举都再堆一个。
 *
 * 判据的分寸：socket 路径与 GUI 的 pid 绑定，**进程死则该路径永久失效**（新 GUI
 * 必然是新 pid → 新路径），所以「干净的非零退出」可以永久记住；而**超时/起不来
 * 只算可疑**（本机 GUI 常年在 4~6 核，5s 内答不上来是可能的），只短期回避，
 * 免得把活着的 GUI 误判死。
 */
export class SocketProbeGate {
  private readonly dead = new Set<string>();
  private readonly cooling = new Map<string, number>();

  /** 这一轮要不要探它。 */
  shouldProbe(socket: string, now: number = Date.now()): boolean {
    if (this.dead.has(socket)) return false;
    const until = this.cooling.get(socket);
    return until === undefined || now >= until;
  }

  /** 探活成功：它活着，清掉回避态。 */
  succeeded(socket: string): void {
    this.cooling.delete(socket);
  }

  /** 干净的非零退出（socket 层失败）→ 该路径永久失效。 */
  failed(socket: string): void {
    this.dead.add(socket);
    this.cooling.delete(socket);
  }

  /** 超时 / 可执行起不来 → 只回避一段时间。 */
  cooledDown(socket: string, now: number = Date.now()): void {
    if (this.dead.has(socket)) return;
    this.cooling.set(socket, now + PROBE_TIMEOUT_COOLDOWN_MS);
  }
}

/** 进程内的探活失败记忆（见 SocketProbeGate）。 */
const probeGate = new SocketProbeGate();

/** 逐候选探活（单次 5s 超时兜底挂死的 GUI）；返回活 mux 与候选清单（报错用）。 */
async function weztermLiveMuxes(): Promise<{ muxes: WeztermMux[]; candidates: string[] }> {
  const candidates = weztermSocketCandidates(process.platform);
  const muxes: WeztermMux[] = [];
  for (const socket of candidates) {
    // 已知坏的 socket 不再重探：死 socket 会把 cli 挂死或踢出幽灵 mux-server。
    if (!probeGate.shouldProbe(socket)) continue;
    const listed = await weztermCli(['cli', 'list', '--format', 'json'], socket);
    if (!listed?.ok) {
      // 干净的非零退出 = 该 socket 路径永久失效；超时/起不来只回避。
      if (listed && !listed.timedOut) probeGate.failed(socket);
      else probeGate.cooledDown(socket);
      continue;
    }
    probeGate.succeeded(socket);
    const clients = await weztermCli(['cli', 'list-clients', '--format', 'json'], socket);
    const active = weztermActiveClient(clients?.ok ? clients.out : null);
    muxes.push({
      socket,
      panes: parseWeztermPanes(listed.out),
      workspace: active?.workspace ?? null,
      idleMs: active?.idleMs ?? Number.POSITIVE_INFINITY,
    });
  }
  return { muxes, candidates };
}

/**
 * wezterm run 主通道：同项目 → 分屏复用；否则 → 最活跃 mux 开新窗口；
 * 命令一律 send-text。任何失败（无活 mux / 某步 rc≠0 / 超时）一律 throw——
 * 错误经路由 400 → 前端 toast，绝不静默落到假成功的 legacy start。
 */
async function runInWezterm(dir: string, argv: string[]): Promise<void> {
  const platform = process.platform;
  const { muxes, candidates } = await weztermLiveMuxes();
  if (muxes.length === 0) {
    throw new Error(
      candidates.length === 0
        ? `wezterm mux undiscoverable: ${process.env.WEZTERM_UNIX_SOCKET ? 'WEZTERM_UNIX_SOCKET set but dead' : 'WEZTERM_UNIX_SOCKET unset'} and no living gui-sock under socket dirs (USERPROFILE=${process.env.USERPROFILE ?? '?'} HOME=${process.env.HOME ?? '?'}) — is wezterm running?`
        : `wezterm mux sockets all unreachable: ${candidates.map((s) => basename(s)).join(', ')} — wezterm may be wedged, restart it`,
    );
  }
  // 同项目分屏：任一 mux 里 cwd 对上就在那里切；多 mux 命中取更活跃的那个
  let chosen: WeztermMux | null = null;
  let split: WeztermSplitTarget | null = null;
  for (const mux of muxes) {
    const s = planWeztermReuse(dir, mux.panes, platform);
    if (s && (chosen === null || mux.idleMs < chosen.idleMs)) {
      chosen = mux;
      split = s;
    }
  }
  // 无命中 → 在最近活跃（idle 最小）的 mux 开新窗
  chosen ??= muxes.reduce((a, b) => (b.idleMs < a.idleMs ? b : a));
  await weztermSpawnAndSend(chosen.socket, dir, argv, split, chosen.workspace);
}

/**
 * spawn（分屏/新窗）+ send-text 投递：runInWezterm 与定点附加共用的尾部。
 * split = null → 开新窗口。任何一步失败一律 throw（路由 400 → 前端报因）。
 */
async function weztermSpawnAndSend(
  socket: string,
  dir: string,
  argv: string[],
  split: WeztermSplitTarget | null,
  workspace: string | null,
): Promise<void> {
  const platform = process.platform;
  const spawnArgs = split
    ? ['cli', 'split-pane', '--pane-id', String(split.paneId), `--${split.direction}`, '--cwd', dir]
    : planWeztermNewWindow(dir, workspace);
  const spawned = await weztermCli(spawnArgs, socket);
  if (!spawned?.ok) throw new Error(weztermStepError(spawnArgs, socket, spawned));
  const paneId = spawned.out.trim();
  if (!/^\d+$/.test(paneId)) {
    throw new Error(`wezterm[${basename(socket)}] ${spawnArgs.join(' ')}: unexpected pane id "${paneId}"`);
  }
  const sendArgs = [
    'cli',
    'send-text',
    '--pane-id',
    paneId,
    '--no-paste',
    `${joinCmd(argv, platform)}\r`,
  ];
  const sent = await weztermCli(sendArgs, socket);
  if (!sent?.ok) throw new Error(weztermStepError(sendArgs, socket, sent));
}

/**
 * 定点附加（用户在会话终端弹窗里选的 tab）：实时重枚举定位目标，目标不在了
 * 就 throw——让前端报「该终端已关闭，请重选」，绝不静默换到别处（换了就是
 * 「我点了 A，命令进了 B」）。
 */
export async function runInWeztermAt(dir: string, argv: string[], targetId: string): Promise<void> {
  const parsed = parseAttachTargetId(targetId);
  if (!parsed) throw new Error(`Invalid terminal target "${targetId}"`);
  const { muxes } = await weztermLiveMuxes();
  const mux = muxes.find((m) => weztermMuxKey(m.socket) === parsed.muxKey);
  if (!mux) throw new Error('wezterm instance is gone — pick a terminal again');
  const tabPanes = mux.panes.filter(
    (p) => p.windowId === parsed.windowId && p.tabId === parsed.tabId,
  );
  if (tabPanes.length === 0) throw new Error('terminal tab is gone — pick a terminal again');
  await weztermSpawnAndSend(mux.socket, dir, argv, planWeztermGrid(tabPanes), mux.workspace);
}

/**
 * 项目卡「终端」角标的数据面：每个目录已打开的终端窗口数（窗口级口径）。
 * 枚举能力只有 wezterm 有（mux `cli list` 报 pane 的 window_id + cwd）；
 * preset = wezterm/auto 才探测（auto 在装了 wezterm 的机器上开的就是它），
 * 其余 preset 没有可枚举通道 → 一律 0（角标不显示，不谎报）。
 */
export async function countOpenTerminals(
  dirs: string[],
  terminal: TerminalSettings,
): Promise<Map<string, number>> {
  // 「这个 preset 能不能反查」由后端回答（不支持 → 基类空表 → 上游落 0），
  // 不在调用方列 preset 白名单。
  return terminalBackendFor(terminal).countWindows(dirs);
}

/**
 * 每项目窗口数（projectId → 窗口数）：/terminals/counts 路由与隐藏刷新器共用
 * 同一口径，免得两处各自拼 settings/opener 后漂移。
 */
export async function readTerminalCounts(
  projects: readonly { id: number; path: string }[],
  opener: ProjectOpener = defaultProjectOpener,
): Promise<Record<number, number>> {
  const settings = await readDaemonSettings();
  const count = opener.countTerminals ?? countOpenTerminals;
  const byPath = await count(
    projects.map((p) => p.path),
    settings.terminal,
  );
  return Object.fromEntries(projects.map((p) => [p.id, byPath.get(p.path) ?? 0]));
}

/**
 * 探活结果短缓存（10s）：角标轮询 + 焦点回归/开窗后刷新会在瞬间打多枪。
 * TTL 必须**大于**前端轮询间隔（App.tsx 是 5s），否则每枪都穿透、缓存等于
 * 不存在——而一枪要对**每个存活 socket** spawn 一次 `wezterm cli list`
 * （实测 wall ~180ms / CPU 62–125ms；机器上残留的幽灵 GUI 会把 socket 数放大）。
 * **只给计数用**：runInWezterm 的落点决策必须看实时世界（缓存会让分屏落到
 * 刚关掉的 pane）。
 */
let muxCache: { at: number; muxes: WeztermMux[] } | null = null;

async function weztermLiveMuxesCached(): Promise<WeztermMux[]> {
  if (muxCache && Date.now() - muxCache.at < 10000) return muxCache.muxes;
  const { muxes } = await weztermLiveMuxes();
  muxCache = { at: Date.now(), muxes };
  return muxes;
}

/** Injection seam for the open routes — tests substitute a spy. */
export interface ProjectOpener {
  openExplorer(dir: string): Promise<void>;
  openTerminal(dir: string, terminal: TerminalSettings): Promise<void>;
  runInTerminal(dir: string, argv: string[], terminal: TerminalSettings): Promise<void>;
  /** 已打开终端窗口计数（可选：不实现的 spy 由路由回落到默认实现）。 */
  countTerminals?(dirs: string[], terminal: TerminalSettings): Promise<Map<string, number>>;
  /** 可附加终端目标列表（可选）：多终端选择弹窗的数据面。 */
  listTerminals?(dir: string): Promise<WeztermAttachTarget[]>;
  /** 定点附加到指定目标 tab（可选）：会话终端选择后的落点。 */
  runInTerminalAt?(dir: string, argv: string[], targetId: string): Promise<void>;
}

export const defaultProjectOpener: ProjectOpener = {
  openExplorer: openInExplorer,
  openTerminal: openInTerminal,
  runInTerminal,
  countTerminals: countOpenTerminals,
  listTerminals: listAttachTargets,
  runInTerminalAt: runInWeztermAt,
};
