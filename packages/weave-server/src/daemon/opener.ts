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
  await launchFirst(
    resolveTerminalLaunch(dir, terminal, process.platform, argv),
    `Terminal preset "${terminal.preset}" cannot run a command here — pick another preset in settings`,
  );
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
