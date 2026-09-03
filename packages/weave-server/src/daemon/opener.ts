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

/**
 * Resolve the spawn candidates that would open a terminal at `dir` for the
 * given settings and platform. Pure function — the actual spawning (and the
 * auto-probe fallback) lives in `openInTerminal`.
 */
export function resolveTerminalLaunch(
  dir: string,
  terminal: TerminalSettings,
  platform: NodeJS.Platform = process.platform,
): TerminalLaunch[] {
  const win = platform === 'win32';
  const mac = platform === 'darwin';

  switch (terminal.preset) {
    case 'wt':
      return win ? [{ command: 'wt.exe', args: ['-d', dir] }] : [];
    case 'powershell':
      return win ? [{ command: 'powershell.exe', args: ['-NoExit'], cwd: dir }] : [];
    case 'cmd':
      return win ? [{ command: 'cmd.exe', args: ['/K'], cwd: dir }] : [];
    case 'terminal':
      return mac ? [{ command: 'open', args: ['-a', 'Terminal', dir] }] : [];
    case 'iterm':
      return mac ? [{ command: 'open', args: ['-a', 'iTerm', dir] }] : [];
    case 'gnome':
      return [{ command: 'gnome-terminal', args: [`--working-directory=${dir}`] }];
    case 'konsole':
      return [{ command: 'konsole', args: ['--workdir', dir] }];
    case 'custom': {
      const template = terminal.customCommand.trim();
      if (!template) return [];
      const command = template.replace(/\{path\}/g, quotePath(dir, platform));
      return [{ command, args: [], shell: true }];
    }
    case 'auto':
    default:
      if (win) {
        return [
          { command: 'wt.exe', args: ['-d', dir] },
          { command: 'powershell.exe', args: ['-NoExit'], cwd: dir },
          { command: 'cmd.exe', args: ['/K'], cwd: dir },
        ];
      }
      if (mac) {
        return [
          { command: 'open', args: ['-a', 'Terminal', dir] },
          { command: 'open', args: ['-a', 'iTerm', dir] },
        ];
      }
      return [
        { command: 'gnome-terminal', args: [`--working-directory=${dir}`] },
        { command: 'konsole', args: ['--workdir', dir] },
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
  const candidates = resolveTerminalLaunch(dir, terminal);
  for (const launch of candidates) {
    if (await trySpawn(launch)) return;
  }
  throw new Error(
    candidates.length === 0
      ? `Terminal preset "${terminal.preset}" is unavailable on this platform`
      : 'No usable terminal found (tried: ' + candidates.map((c) => c.command).join(', ') + ')',
  );
}

/** Injection seam for the open routes — tests substitute a spy. */
export interface ProjectOpener {
  openExplorer(dir: string): Promise<void>;
  openTerminal(dir: string, terminal: TerminalSettings): Promise<void>;
}

export const defaultProjectOpener: ProjectOpener = {
  openExplorer: openInExplorer,
  openTerminal: openInTerminal,
};
