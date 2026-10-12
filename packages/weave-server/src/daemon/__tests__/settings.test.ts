import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../db/db.js';
import {
  DEFAULT_DAEMON_SETTINGS,
  DEFAULT_EVENT_RETENTION_DAYS,
  readDaemonSettings,
  readDaemonSettingsSync,
  writeDaemonSettings,
  setDaemonSettingsDb,
  terminalPresetsFor,
} from '../settings.js';
import {
  quotePath,
  resolveTerminalLaunch,
  resolveExplorerLaunch,
  parseWeztermPanes,
  planWeztermReuse,
  planWeztermNewWindow,
  weztermActiveWorkspaceOf,
  type WeztermPaneInfo,
} from '../opener.js';

describe('daemon settings persistence (db key-value)', () => {
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    setDaemonSettingsDb(db);
  });

  afterEach(() => {
    setDaemonSettingsDb(null);
  });

  it('readDaemonSettings returns defaults when no rows exist', async () => {
    expect(await readDaemonSettings()).toEqual(DEFAULT_DAEMON_SETTINGS);
  });

  it('writeDaemonSettings round-trips and lands in the settings kv table', async () => {
    const saved = await writeDaemonSettings({
      terminal: { preset: 'wt', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    expect(saved.terminal.preset).toBe('wt');
    expect(await readDaemonSettings()).toEqual(saved);
    const rows = db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    expect(map.get('terminal.preset')).toBe('wt');
    expect(map.get('locale')).toBe('zh-CN');
    expect(map.get('hooks.enabled')).toBe('true');
    expect(map.get('events.retentionDays')).toBe('90');
  });

  it('an unknown preset falls back to auto; non-string customCommand to empty', async () => {
    const saved = await writeDaemonSettings({
      terminal: { preset: 'does-not-exist' as never, customCommand: 42 as never },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    expect(saved).toEqual(DEFAULT_DAEMON_SETTINGS);
  });

  it('corrupt rows heal per-key to defaults instead of throwing', async () => {
    await writeDaemonSettings({
      terminal: { preset: 'wt', customCommand: 'x' },
      locale: 'en',
      hooks: { enabled: true },
    });
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('nope', 'terminal.preset');
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('fr', 'locale');
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('NaN', 'events.retentionDays');
    const s = await readDaemonSettings();
    expect(s.terminal.preset).toBe('auto'); // 白名单回落
    expect(s.locale).toBe('zh-CN');
    expect(s.events?.retentionDays).toBe(DEFAULT_EVENT_RETENTION_DAYS);
    expect(s.terminal.customCommand).toBe('x'); // 好值不受坏值影响
  });

  it('locale round-trips through write and read', async () => {
    const saved = await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'en',
      hooks: { enabled: true },
    });
    expect(saved.locale).toBe('en');
    expect((await readDaemonSettings()).locale).toBe('en');
  });

  it('an unsupported locale falls back to zh-CN', async () => {
    const saved = await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'fr' as never,
      hooks: { enabled: true },
    });
    expect(saved.locale).toBe('zh-CN');
  });

  it('hooks.enabled round-trips; non-boolean falls back to true', async () => {
    const off = await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: false },
    });
    expect(off.hooks.enabled).toBe(false);
    expect((await readDaemonSettings()).hooks.enabled).toBe(false);

    const bad = await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: 'yes' as never },
    });
    expect(bad.hooks.enabled).toBe(true);
  });

  it('events.retentionDays round-trips（含同步读）；非法值回落默认', async () => {
    const saved = await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
      events: { retentionDays: 7 },
    });
    expect(saved.events?.retentionDays).toBe(7);
    expect((await readDaemonSettings()).events?.retentionDays).toBe(7);
    expect(readDaemonSettingsSync().events?.retentionDays).toBe(7);

    const bad = await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
      events: { retentionDays: 0 as never },
    });
    expect(bad.events?.retentionDays).toBe(DEFAULT_EVENT_RETENTION_DAYS);
  });

  it('startup.launchOnLogin round-trips；缺省/非法值回落 false（默认关）', async () => {
    // 存量库缺 key → 默认关
    expect((await readDaemonSettings()).startup?.launchOnLogin).toBe(false);

    const on = await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
      startup: { launchOnLogin: true },
    });
    expect(on.startup?.launchOnLogin).toBe(true);
    expect((await readDaemonSettings()).startup?.launchOnLogin).toBe(true);
    const rows = db.prepare('SELECT value FROM settings WHERE key = ?').all(
      'startup.launchOnLogin',
    ) as { value: string }[];
    expect(rows[0]?.value).toBe('true');

    const off = await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
      startup: { launchOnLogin: false },
    });
    expect(off.startup?.launchOnLogin).toBe(false);

    const bad = await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
      startup: { launchOnLogin: 'yes' as never },
    });
    expect(bad.startup?.launchOnLogin).toBe(false);
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

  // ---- run 模式：终端内执行命令（在默认终端打开会话 = claude --resume ----
  it('run: wt passes the argv after -d', () => {
    expect(
      resolveTerminalLaunch('D:\\proj', { preset: 'wt', customCommand: '' }, 'win32', [
        'claude',
        '--resume',
        'abc-123',
      ]),
    ).toEqual([
      {
        command: 'wt.exe',
        args: ['-d', 'D:\\proj', 'cmd.exe', '/k', 'claude --resume abc-123'],
      },
    ]);
  });

  it('run: wezterm 在 Windows 经 cmd.exe 转发（裸 claude 会 0x80070002），POSIX 直发', () => {
    expect(
      resolveTerminalLaunch('D:\\proj', { preset: 'wezterm', customCommand: '' }, 'win32', [
        'claude',
        '--resume',
        'abc-123',
      ]),
    ).toEqual([
      {
        command: 'wezterm',
        args: ['start', '--cwd', 'D:\\proj', 'cmd.exe', '/k', 'claude --resume abc-123'],
      },
    ]);
    expect(
      resolveTerminalLaunch('/tmp/p', { preset: 'wezterm', customCommand: '' }, 'linux', [
        'claude',
        '--resume',
        'abc',
      ]),
    ).toEqual([
      { command: 'wezterm', args: ['start', '--cwd', '/tmp/p', 'claude', '--resume', 'abc'] },
    ]);
  });

  it('run: powershell/cmd get a joined command line, cwd stays the project dir', () => {
    const ps = resolveTerminalLaunch(
      'D:\\proj',
      { preset: 'powershell', customCommand: '' },
      'win32',
      ['claude', '--resume', 'abc-123'],
    );
    expect(ps).toEqual([
      {
        command: 'powershell.exe',
        args: ['-NoExit', '-Command', 'claude --resume abc-123'],
        cwd: 'D:\\proj',
      },
    ]);
    const cmd = resolveTerminalLaunch('D:\\proj', { preset: 'cmd', customCommand: '' }, 'win32', [
      'claude',
      '--resume',
      'abc-123',
    ]);
    expect(cmd).toEqual([
      { command: 'cmd.exe', args: ['/K', 'claude --resume abc-123'], cwd: 'D:\\proj' },
    ]);
  });

  it('run: auto on Windows keeps the probe order with command variants', () => {
    const launches = resolveTerminalLaunch(
      'D:\\proj',
      { preset: 'auto', customCommand: '' },
      'win32',
      ['claude', '--resume', 'abc'],
    );
    expect(launches.map((l) => l.command)).toEqual(['wt.exe', 'powershell.exe', 'cmd.exe']);
    expect(launches[0]!.args).toEqual([
      '-d',
      'D:\\proj',
      'cmd.exe',
      '/k',
      'claude --resume abc',
    ]);
    expect(launches[2]!.args).toEqual(['/K', 'claude --resume abc']);
  });

  it('run: linux presets append the argv (-e / --)', () => {
    const gnome = resolveTerminalLaunch(
      '/tmp/p',
      { preset: 'gnome', customCommand: '' },
      'linux',
      ['claude', '--resume', 'abc'],
    );
    expect(gnome[0]!.args).toEqual([
      '--working-directory=/tmp/p',
      '--',
      'claude',
      '--resume',
      'abc',
    ]);
    const konsole = resolveTerminalLaunch(
      '/tmp/p',
      { preset: 'konsole', customCommand: '' },
      'linux',
      ['claude', '--resume', 'abc'],
    );
    expect(konsole[0]!.args).toEqual(['--workdir', '/tmp/p', '-e', 'claude', '--resume', 'abc']);
  });

  it('run: macOS presets open via AppleScript with cd + command', () => {
    const launches = resolveTerminalLaunch(
      '/tmp/p',
      { preset: 'terminal', customCommand: '' },
      'darwin',
      ['claude', '--resume', 'abc'],
    );
    expect(launches).toHaveLength(1);
    expect(launches[0]!.command).toBe('osascript');
    expect(launches[0]!.args.join(' ')).toContain('do script "cd \'/tmp/p\' && claude --resume abc"');
    // 无 run 的既有行为不受影响
    const openOnly = resolveTerminalLaunch('/tmp/p', { preset: 'terminal', customCommand: '' }, 'darwin');
    expect(openOnly[0]!.command).toBe('open');
  });

  it('run: custom template substitutes {command}, or appends when absent', () => {
    const withPlace = resolveTerminalLaunch(
      '/tmp/p',
      { preset: 'custom', customCommand: 'myterm -e {path} {command}' },
      'linux',
      ['claude', '--resume', 'abc'],
    );
    expect(withPlace[0]!.command).toBe("myterm -e '/tmp/p' claude --resume abc");
    const appended = resolveTerminalLaunch(
      'D:\\proj',
      { preset: 'custom', customCommand: 'wt -d {path}' },
      'win32',
      ['claude', '--resume', 'abc'],
    );
    expect(appended[0]!.command).toBe('wt -d "D:\\proj" claude --resume abc');
    // 无 run 时残留的 {command} 占位符清空
    const noRun = resolveTerminalLaunch(
      '/tmp/p',
      { preset: 'custom', customCommand: 'myterm {command}' },
      'linux',
    );
    expect(noRun[0]!.command).toBe('myterm ');
  });

  it('run: ghostty on macOS goes through the bundle, which cannot run a command → empty', () => {
    expect(
      resolveTerminalLaunch('/tmp/p', { preset: 'ghostty', customCommand: '' }, 'darwin', [
        'claude',
        '--resume',
        'abc',
      ]),
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

describe('wezterm mux 会话通道（纯函数）', () => {
  const mkPane = (
    paneId: number,
    left: number,
    top: number,
    tabId = 0,
    cwd = 'file:///p/proj',
  ): WeztermPaneInfo => ({ windowId: 0, tabId, paneId, cwd, left, top });

  it('parseWeztermPanes 提取布局字段，坏输入塌成空表', () => {
    expect(parseWeztermPanes(null)).toEqual([]);
    expect(parseWeztermPanes('not json')).toEqual([]);
    expect(parseWeztermPanes('{"a":1}')).toEqual([]);
    const real = JSON.stringify([
      { window_id: 0, tab_id: 0, pane_id: 0, cwd: 'file:///D:/x', left_col: 0, top_row: 0 },
      { window_id: 0, tab_id: 0, pane_id: 2, cwd: null, left_col: 0, top_row: 27 },
    ]);
    expect(parseWeztermPanes(real)).toEqual([
      { windowId: 0, tabId: 0, paneId: 0, cwd: 'file:///D:/x', left: 0, top: 0 },
      { windowId: 0, tabId: 0, paneId: 2, cwd: null, left: 0, top: 27 },
    ]);
  });

  it('planWeztermReuse：cwd 不匹配 → null（走新窗口）', () => {
    expect(planWeztermReuse('/p/proj', [], 'linux')).toBeNull();
    expect(planWeztermReuse('/p/proj', [mkPane(1, 0, 0, 0, 'file:///p/else')], 'linux')).toBeNull();
    expect(planWeztermReuse('/p/proj', [mkPane(1, 0, 0, 0, null)], 'linux')).toBeNull();
  });

  it('planWeztermReuse：win32 目录键大小写/斜杠/尾斜杠不敏感', () => {
    expect(planWeztermReuse('D:\\PROJ\\', [mkPane(7, 0, 0, 3, 'file:///d:/proj/')], 'win32')).toEqual(
      { paneId: 7, direction: 'right' },
    );
  });

  it('planWeztermReuse：posix 目录键大小写敏感', () => {
    expect(planWeztermReuse('/tmp/x', [mkPane(1, 0, 0, 0, 'file:///tmp/X')], 'linux')).toBeNull();
    expect(planWeztermReuse('/tmp/X', [mkPane(1, 0, 0, 0, 'file:///tmp/X')], 'linux')).toEqual({
      paneId: 1,
      direction: 'right',
    });
  });

  it('planWeztermReuse：网格按 1 2 / 3 4 / 5 6 生长', () => {
    // 第 2 格（1|2）：唯一 pane 向右开列
    expect(planWeztermReuse('/p/proj', [mkPane(1, 0, 0)], 'linux')).toEqual({
      paneId: 1,
      direction: 'right',
    });
    // 第 3 格（3 在 1 下）：两列等高 → 左列底格向下
    expect(planWeztermReuse('/p/proj', [mkPane(1, 0, 0), mkPane(2, 60, 0)], 'linux')).toEqual({
      paneId: 1,
      direction: 'bottom',
    });
    // 第 4 格（4 在 2 下）：右列矮 → 右列向下
    expect(
      planWeztermReuse('/p/proj', [mkPane(1, 0, 0), mkPane(2, 60, 0), mkPane(3, 0, 12)], 'linux'),
    ).toEqual({ paneId: 2, direction: 'bottom' });
    // 第 5 格（5 在 3 下）：再次等高 → 左列底格（top 最大的 3）向下
    expect(
      planWeztermReuse(
        '/p/proj',
        [mkPane(1, 0, 0), mkPane(2, 60, 0), mkPane(3, 0, 12), mkPane(4, 60, 12)],
        'linux',
      ),
    ).toEqual({ paneId: 3, direction: 'bottom' });
  });

  it('planWeztermReuse：右列被关掉只剩单列 → 底格向右重开列', () => {
    expect(
      planWeztermReuse('/p/proj', [mkPane(1, 0, 0), mkPane(3, 0, 12)], 'linux'),
    ).toEqual({ paneId: 3, direction: 'right' });
  });

  it('planWeztermReuse：多 tab 命中取匹配最多者，几何只看该 tab', () => {
    const panes = [mkPane(1, 0, 0, 0), mkPane(5, 0, 0, 1), mkPane(6, 60, 0, 1)];
    // tab1 里网格已成型（2 pane 匹配）→ 等高两列 → 左列底格向下
    expect(planWeztermReuse('/p/proj', panes, 'linux')).toEqual({ paneId: 5, direction: 'bottom' });
  });

  it('planWeztermNewWindow：workspace 随行，缺省省略', () => {
    expect(planWeztermNewWindow('D:\\proj', 'default')).toEqual([
      'cli',
      'spawn',
      '--new-window',
      '--cwd',
      'D:\\proj',
      '--workspace',
      'default',
    ]);
    expect(planWeztermNewWindow('/p/proj', null)).toEqual([
      'cli',
      'spawn',
      '--new-window',
      '--cwd',
      '/p/proj',
    ]);
  });

  it('weztermActiveWorkspaceOf 取 idle 最小的 client，坏输入安全落空', () => {
    expect(weztermActiveWorkspaceOf(null)).toBeNull();
    expect(weztermActiveWorkspaceOf('wat')).toBeNull();
    expect(weztermActiveWorkspaceOf('[]')).toBeNull();
    expect(
      weztermActiveWorkspaceOf(
        JSON.stringify([
          { workspace: 'ws-old', idle_time: { secs: 60, nanos: 0 } },
          { workspace: 'ws-live', idle_time: { secs: 0, nanos: 500_000_000 } },
        ]),
      ),
    ).toBe('ws-live');
  });
});
