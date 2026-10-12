import { spawn } from 'node:child_process';
import type { TerminalSettings } from './settings.js';

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

/**
 * Resolve the spawn candidates that would open a terminal at `dir` for the
 * given settings and platform. Pure function — the actual spawning (and the
 * auto-probe fallback) lives in `openInTerminal`.
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
  const win = platform === 'win32';
  const mac = platform === 'darwin';

  switch (terminal.preset) {
    case 'wt':
      return win ? [{ command: 'wt.exe', args: ['-d', dir, ...(throughCmd(run, win) ?? [])] }] : [];
    case 'powershell':
      return win
        ? [
            run
              ? { command: 'powershell.exe', args: ['-NoExit', '-Command', joinCmd(run, 'win32')], cwd: dir }
              : { command: 'powershell.exe', args: ['-NoExit'], cwd: dir },
          ]
        : [];
    case 'cmd':
      return win
        ? [
            run
              ? { command: 'cmd.exe', args: ['/K', joinCmd(run, 'win32')], cwd: dir }
              : { command: 'cmd.exe', args: ['/K'], cwd: dir },
          ]
        : [];
    case 'terminal':
      if (run) return mac ? [{ command: 'osascript', args: osascriptRun('Terminal', dir, run) }] : [];
      return mac ? [{ command: 'open', args: ['-a', 'Terminal', dir] }] : [];
    case 'iterm':
      if (run) return mac ? [{ command: 'osascript', args: osascriptRun('iTerm', dir, run) }] : [];
      return mac ? [{ command: 'open', args: ['-a', 'iTerm', dir] }] : [];
    case 'gnome':
      return [
        {
          command: 'gnome-terminal',
          args: [`--working-directory=${dir}`, ...(run ? ['--', ...run] : [])],
        },
      ];
    case 'konsole':
      return [
        { command: 'konsole', args: ['--workdir', dir, ...(run ? ['-e', ...run] : [])] },
      ];
    case 'wezterm':
      // `start` opens the GUI (or a new window in an existing one) and `--cwd`
      // applies to the first program it spawns. Cross-platform.
      return [{ command: 'wezterm', args: ['start', '--cwd', dir, ...(throughCmd(run, win) ?? [])] }];
    case 'ghostty':
      // No Windows build, so nothing to launch there.
      if (win) return [];
      // On macOS the `ghostty` binary is only a helper CLI — it cannot start
      // the app, so go through the bundle the way the Terminal/iTerm entries
      // do. Ghostty registers a folder open handler that lands the new window
      // in that directory. The bundle open cannot run a command.
      if (mac) return run ? [] : [{ command: 'open', args: ['-a', 'Ghostty', dir] }];
      // On Linux `--working-directory` is a config key, also accepted as a
      // command-line flag when launching.
      return [
        {
          command: 'ghostty',
          args: [`--working-directory=${dir}`, ...(run ? ['-e', ...run] : [])],
        },
      ];
    case 'custom': {
      const template = terminal.customCommand.trim();
      if (!template) return [];
      let command = template.replace(/\{path\}/g, quotePath(dir, platform));
      const cmd = run ? joinCmd(run, platform) : '';
      command = command.includes('{command}')
        ? command.replace(/\{command\}/g, cmd)
        : run
          ? `${command} ${cmd}`
          : command;
      return [{ command, args: [], shell: true }];
    }
    case 'auto':
    default:
      if (win) {
        return [
          { command: 'wt.exe', args: ['-d', dir, ...(throughCmd(run, win) ?? [])] },
          run
            ? { command: 'powershell.exe', args: ['-NoExit', '-Command', joinCmd(run, 'win32')], cwd: dir }
            : { command: 'powershell.exe', args: ['-NoExit'], cwd: dir },
          run
            ? { command: 'cmd.exe', args: ['/K', joinCmd(run, 'win32')], cwd: dir }
            : { command: 'cmd.exe', args: ['/K'], cwd: dir },
        ];
      }
      if (mac) {
        return run
          ? [{ command: 'osascript', args: osascriptRun('Terminal', dir, run) }]
          : [
              { command: 'open', args: ['-a', 'Terminal', dir] },
              { command: 'open', args: ['-a', 'iTerm', dir] },
            ];
      }
      return [
        {
          command: 'gnome-terminal',
          args: [`--working-directory=${dir}`, ...(run ? ['--', ...run] : [])],
        },
        { command: 'konsole', args: ['--workdir', dir, ...(run ? ['-e', ...run] : [])] },
      ];
  }
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
async function launchFirst(candidates: TerminalLaunch[], unavailable: string): Promise<void> {
  for (const launch of candidates) {
    if (await trySpawn(launch)) return;
  }
  throw new Error(
    candidates.length === 0
      ? unavailable
      : 'No usable terminal found (tried: ' + candidates.map((c) => c.command).join(', ') + ')',
  );
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
export async function openInTerminal(
  dir: string,
  terminal: TerminalSettings,
): Promise<void> {
  await launchFirst(
    resolveTerminalLaunch(dir, terminal),
    `Terminal preset "${terminal.preset}" is unavailable on this platform`,
  );
}

/** Open a terminal at `dir` that runs `argv` (e.g. `claude --resume <id>`).
 * Same detached semantics as `openInTerminal` — the process outlives the daemon. */
export async function runInTerminal(
  dir: string,
  argv: string[],
  terminal: TerminalSettings,
): Promise<void> {
  if (terminal.preset === 'wezterm' && (await runInWezterm(dir, argv))) return;
  await launchFirst(
    resolveTerminalLaunch(dir, terminal, process.platform, argv),
    `Terminal preset "${terminal.preset}" cannot run a command here — pick another preset in settings`,
  );
}

// ---- wezterm mux 通道：同项目复用分屏，否则新窗口；失败回退 start 直发 ----
//
// `wezterm start -- PROG` 会绕过 default_prog 直派子进程（用户的 shell 配置、
// job 包裹、OSC 7 全部丢失），所以 run 路径首选 mux：panes 在 mux 里以
// default_prog 起，命令经 send-text 打进去。mux 不在（wezterm 没开）时
// cli 调用快速失败，落到候选单里的 `start` 老行为。

/** `cli list` 里与布局决策相关的字段（left_col/top_row 是单元格坐标）。 */
export interface WeztermPaneInfo {
  windowId: number;
  tabId: number;
  paneId: number;
  cwd: string | null;
  left: number;
  top: number;
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
 * 同项目复用布局：网格按 1 2 / 3 4 / 5 6 生长 —— 首个分屏向右开列，之后
 * 矮列的底格向下延伸，等高取左列。坐标用 `cli list` 报的 left_col/top_row，
 * 用户手工增删 pane 后依旧推导得出，不落持久状态。
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
  const tabPanes = panes.filter((p) => p.tabId === tabId);
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

/** 新项目窗：最近活跃 client 的 workspace（拿不到就省略，进 mux 默认 workspace）。 */
export function planWeztermNewWindow(dir: string, workspace: string | null): string[] {
  const args = ['cli', 'spawn', '--new-window', '--cwd', dir];
  if (workspace) args.push('--workspace', workspace);
  return args;
}

/** list-clients JSON → 最近活跃（idle 最小）client 的 workspace；坏输入 null。 */
export function weztermActiveWorkspaceOf(jsonText: string | null): string | null {
  if (!jsonText) return null;
  let clients: unknown;
  try {
    clients = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(clients)) return null;
  let best: string | null = null;
  let bestIdle = Number.POSITIVE_INFINITY;
  for (const c of clients) {
    const client = c as { workspace?: unknown; idle_time?: { secs?: unknown; nanos?: unknown } };
    if (typeof client?.workspace !== 'string' || !client.workspace) continue;
    const idle = client.idle_time;
    const idleMs =
      (typeof idle?.secs === 'number' ? idle.secs * 1e3 : 0) +
      (typeof idle?.nanos === 'number' ? idle.nanos / 1e6 : 0);
    if (idleMs < bestIdle) {
      bestIdle = idleMs;
      best = client.workspace;
    }
  }
  return best;
}

const WEZTERM_CLI_TIMEOUT_MS = 5000;

/** wezterm cli 子调用：返回 stdout；非零退出/超时/不可执行 → null。 */
function weztermCli(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('wezterm', args, { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, WEZTERM_CLI_TIMEOUT_MS);
    timer.unref();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

/** wezterm run 主通道：同项目 → 分屏复用；否则 → 新窗口；命令一律 send-text。 */
async function runInWezterm(dir: string, argv: string[]): Promise<boolean> {
  const platform = process.platform;
  const panes = parseWeztermPanes(await weztermCli(['cli', 'list', '--format', 'json']));
  const split = planWeztermReuse(dir, panes, platform);
  let paneOut: string | null;
  if (split) {
    paneOut = await weztermCli([
      'cli',
      'split-pane',
      '--pane-id',
      String(split.paneId),
      `--${split.direction}`,
      '--cwd',
      dir,
    ]);
  } else {
    const workspace = weztermActiveWorkspaceOf(
      await weztermCli(['cli', 'list-clients', '--format', 'json']),
    );
    paneOut = await weztermCli(planWeztermNewWindow(dir, workspace));
  }
  const paneId = paneOut?.trim() ?? '';
  if (!/^\d+$/.test(paneId)) return false;
  const sent = await weztermCli([
    'cli',
    'send-text',
    '--pane-id',
    paneId,
    '--no-paste',
    `${joinCmd(argv, platform)}\r`,
  ]);
  return sent !== null;
}

/** Injection seam for the open routes — tests substitute a spy. */
export interface ProjectOpener {
  openExplorer(dir: string): Promise<void>;
  openTerminal(dir: string, terminal: TerminalSettings): Promise<void>;
  runInTerminal(dir: string, argv: string[], terminal: TerminalSettings): Promise<void>;
}

export const defaultProjectOpener: ProjectOpener = {
  openExplorer: openInExplorer,
  openTerminal: openInTerminal,
  runInTerminal,
};
