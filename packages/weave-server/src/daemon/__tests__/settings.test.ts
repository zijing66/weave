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
      locale: 'zh-CN',
    });
    expect(saved.terminal.preset).toBe('wt');
    expect(await readDaemonSettings()).toEqual(saved);
    const raw = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf-8')) as {
      terminal: { preset: string };
      locale: string;
    };
    expect(raw.terminal.preset).toBe('wt');
    expect(raw.locale).toBe('zh-CN');
  });

  it('an unknown preset falls back to auto; non-string customCommand to empty', async () => {
    const saved = await writeDaemonSettings({
      terminal: { preset: 'does-not-exist' as never, customCommand: 42 as never },
      locale: 'zh-CN',
    });
    expect(saved).toEqual(DEFAULT_DAEMON_SETTINGS);
  });

  it('a corrupt file falls back to defaults instead of throwing', async () => {
    await writeDaemonSettings({ terminal: { preset: 'cmd', customCommand: 'x' }, locale: 'zh-CN' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'settings.json'), '{not json', 'utf-8');
    expect(await readDaemonSettings()).toEqual(DEFAULT_DAEMON_SETTINGS);
  });

  it('locale round-trips through write and read', async () => {
    const saved = await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'en',
    });
    expect(saved.locale).toBe('en');
    expect((await readDaemonSettings()).locale).toBe('en');
  });

  it('an unsupported locale falls back to zh-CN', async () => {
    const saved = await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'fr' as never,
    });
    expect(saved.locale).toBe('zh-CN');
  });
});

describe('terminalPresetsFor', () => {
  it('offers only Windows presets on win32', () => {
    const ids = terminalPresetsFor('win32').map((p) => p.id);
    expect(ids).toEqual(['auto', 'wt', 'wezterm', 'powershell', 'cmd', 'custom']);
  });

  it('offers only macOS presets on darwin', () => {
    const ids = terminalPresetsFor('darwin').map((p) => p.id);
    expect(ids).toEqual(['auto', 'terminal', 'iterm', 'wezterm', 'ghostty', 'custom']);
  });

  it('offers only Linux presets elsewhere', () => {
    const ids = terminalPresetsFor('linux').map((p) => p.id);
    expect(ids).toEqual(['auto', 'gnome', 'konsole', 'wezterm', 'ghostty', 'custom']);
  });

  it('omits Ghostty on Windows, where it has no build', () => {
    expect(terminalPresetsFor('win32').map((p) => p.id)).not.toContain('ghostty');
  });

  it('offers WezTerm on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      expect(terminalPresetsFor(platform).map((p) => p.id)).toContain('wezterm');
    }
  });

  it('labels every preset it offers', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      for (const preset of terminalPresetsFor(platform)) {
        expect(preset.label.length).toBeGreaterThan(0);
      }
    }
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

  it('wezterm uses `start --cwd` on every platform', () => {
    const expected = { command: 'wezterm', args: ['start', '--cwd', 'D:\\proj'] };
    expect(
      resolveTerminalLaunch('D:\\proj', { preset: 'wezterm', customCommand: '' }, 'win32'),
    ).toEqual([expected]);
    // the directory is an argument, never interpolated into a shell string
    const posix = resolveTerminalLaunch('/tmp/p', { preset: 'wezterm', customCommand: '' }, 'linux');
    expect(posix).toEqual([{ command: 'wezterm', args: ['start', '--cwd', '/tmp/p'] }]);
    expect(posix[0]!.shell).toBeUndefined();
  });

  it('ghostty launches directly on Linux', () => {
    expect(
      resolveTerminalLaunch('/tmp/p', { preset: 'ghostty', customCommand: '' }, 'linux'),
    ).toEqual([{ command: 'ghostty', args: ['--working-directory=/tmp/p'] }]);
  });

  it('ghostty goes through the app bundle on macOS', () => {
    // the macOS `ghostty` binary is a helper CLI that cannot start the app
    expect(
      resolveTerminalLaunch('/tmp/p', { preset: 'ghostty', customCommand: '' }, 'darwin'),
    ).toEqual([{ command: 'open', args: ['-a', 'Ghostty', '/tmp/p'] }]);
  });

  it('ghostty resolves to nothing on Windows, where it does not exist', () => {
    expect(
      resolveTerminalLaunch('D:\\proj', { preset: 'ghostty', customCommand: '' }, 'win32'),
    ).toEqual([]);
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
