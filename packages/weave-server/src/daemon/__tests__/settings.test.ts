import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_DAEMON_SETTINGS,
  readDaemonSettings,
  writeDaemonSettings,
  setDaemonSettingsDir,
  terminalPresetsFor,
} from '../settings.js';
import { quotePath, resolveTerminalLaunch, resolveExplorerLaunch } from '../opener.js';

describe('daemon settings persistence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'weave-settings-'));
    setDaemonSettingsDir(dir);
  });

  afterEach(() => {
    setDaemonSettingsDir(null);
  });

  it('readDaemonSettings returns defaults when no file exists', async () => {
    expect(await readDaemonSettings()).toEqual(DEFAULT_DAEMON_SETTINGS);
  });

  it('writeDaemonSettings round-trips a valid config and persists JSON', async () => {
    const saved = await writeDaemonSettings({
      terminal: { preset: 'wt', customCommand: '' },
    });
    expect(saved.terminal.preset).toBe('wt');
    expect(await readDaemonSettings()).toEqual(saved);
    const raw = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf-8')) as {
      terminal: { preset: string };
    };
    expect(raw.terminal.preset).toBe('wt');
  });

  it('an unknown preset falls back to auto; non-string customCommand to empty', async () => {
    const saved = await writeDaemonSettings({
      terminal: { preset: 'does-not-exist' as never, customCommand: 42 as never },
    });
    expect(saved).toEqual(DEFAULT_DAEMON_SETTINGS);
  });

  it('a corrupt file falls back to defaults instead of throwing', async () => {
    await writeDaemonSettings({ terminal: { preset: 'cmd', customCommand: 'x' } });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'settings.json'), '{not json', 'utf-8');
    expect(await readDaemonSettings()).toEqual(DEFAULT_DAEMON_SETTINGS);
  });
});

describe('terminalPresetsFor', () => {
  it('offers only Windows presets on win32', () => {
    const ids = terminalPresetsFor('win32').map((p) => p.id);
    expect(ids).toEqual(['auto', 'wt', 'powershell', 'cmd', 'custom']);
  });

  it('offers only macOS presets on darwin', () => {
    const ids = terminalPresetsFor('darwin').map((p) => p.id);
    expect(ids).toEqual(['auto', 'terminal', 'iterm', 'custom']);
  });

  it('offers only Linux presets elsewhere', () => {
    const ids = terminalPresetsFor('linux').map((p) => p.id);
    expect(ids).toEqual(['auto', 'gnome', 'konsole', 'custom']);
  });
});

describe('quotePath', () => {
  it('double-quotes on Windows', () => {
    expect(quotePath('D:\\repo sub\\x', 'win32')).toBe('"D:\\repo sub\\x"');
  });

  it('single-quotes POSIX paths and escapes embedded quotes', () => {
    expect(quotePath('/home/user/dir', 'linux')).toBe("'/home/user/dir'");
    expect(quotePath("/home/it's", 'linux')).toBe("'/home/it'\\''s'");
  });
});

describe('resolveTerminalLaunch', () => {
  it('auto on Windows probes wt, then powershell, then cmd', () => {
    const launches = resolveTerminalLaunch('D:\\proj', { preset: 'auto', customCommand: '' }, 'win32');
    expect(launches).toHaveLength(3);
    expect(launches[0]).toEqual({ command: 'wt.exe', args: ['-d', 'D:\\proj'] });
    // cwd-based launches never interpolate the directory into a command string
    expect(launches[1]).toEqual({ command: 'powershell.exe', args: ['-NoExit'], cwd: 'D:\\proj' });
    expect(launches[2]).toEqual({ command: 'cmd.exe', args: ['/K'], cwd: 'D:\\proj' });
  });

  it('auto on macOS prefers Terminal.app, then iTerm', () => {
    const launches = resolveTerminalLaunch('/tmp/p', { preset: 'auto', customCommand: '' }, 'darwin');
    expect(launches.map((l) => l.args.slice(0, 2).join(' '))).toEqual(['-a Terminal', '-a iTerm']);
    expect(launches.every((l) => l.cwd === undefined && l.shell !== true)).toBe(true);
  });

  it('auto on Linux probes gnome-terminal then konsole', () => {
    const launches = resolveTerminalLaunch('/tmp/p', { preset: 'auto', customCommand: '' }, 'linux');
    expect(launches[0]).toEqual({ command: 'gnome-terminal', args: ['--working-directory=/tmp/p'] });
    expect(launches[1]).toEqual({ command: 'konsole', args: ['--workdir', '/tmp/p'] });
  });

  it('platform-specific presets resolve to empty off their platform', () => {
    const off = resolveTerminalLaunch('/tmp/p', { preset: 'wt', customCommand: '' }, 'linux');
    expect(off).toEqual([]);
  });

  it('a custom template substitutes the quoted path and runs via shell', () => {
    const launches = resolveTerminalLaunch(
      '/tmp/my proj',
      { preset: 'custom', customCommand: 'alacritty --working-directory {path} --hold' },
      'linux',
    );
    expect(launches).toEqual([
      { command: "alacritty --working-directory '/tmp/my proj' --hold", args: [], shell: true },
    ]);
  });

  it('an empty custom template resolves to no candidates', () => {
    expect(
      resolveTerminalLaunch('/tmp/p', { preset: 'custom', customCommand: '  ' }, 'linux'),
    ).toEqual([]);
  });
});

describe('resolveExplorerLaunch', () => {
  it('uses the platform file manager', () => {
    expect(resolveExplorerLaunch('D:\\p', 'win32')).toEqual({ command: 'explorer.exe', args: ['D:\\p'] });
    expect(resolveExplorerLaunch('/tmp/p', 'darwin')).toEqual({ command: 'open', args: ['/tmp/p'] });
    expect(resolveExplorerLaunch('/tmp/p', 'linux')).toEqual({ command: 'xdg-open', args: ['/tmp/p'] });
  });
});
