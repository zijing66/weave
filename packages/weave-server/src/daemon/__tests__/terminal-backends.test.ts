import { describe, it, expect } from 'vitest';
import { resolveTerminalLaunch, terminalBackendFor } from '../opener.js';
import type { TerminalSettings } from '../settings.js';

/**
 * 终端后端的行为钉子。
 *
 * 这里钉的是重构**前后必须一致**的东西：各 preset 的平台门控、命令选型、
 * `auto` 的串联顺序（原来 auto 把 wt/powershell/cmd 那三行原样抄了一遍，现在
 * 由具名条目组合——下面那条 toEqual 就是那次去重的等价性证明），以及
 * 「哪个 preset 能反查已开窗口」这个能力归属。
 */

const settings = (preset: TerminalSettings['preset'], customCommand = ''): TerminalSettings => ({
  preset,
  customCommand,
});

const DIR = '/tmp/proj';
const RUN = ['claude', '--resume', 'abc'];

/** 候选清单里的命令名（钉平台门控与命令选型，不锁参数细节）。 */
function commands(
  preset: TerminalSettings['preset'],
  platform: NodeJS.Platform,
  run?: string[],
): string[] {
  return resolveTerminalLaunch(DIR, settings(preset), platform, run).map((c) => c.command);
}

describe('终端后端 — preset 候选与平台门控', () => {
  it('Windows 专属 preset 只在 win32 出候选', () => {
    expect(commands('wt', 'win32')).toEqual(['wt.exe']);
    expect(commands('powershell', 'win32')).toEqual(['powershell.exe']);
    expect(commands('cmd', 'win32')).toEqual(['cmd.exe']);
    for (const platform of ['darwin', 'linux'] as const) {
      expect(commands('wt', platform), platform).toEqual([]);
      expect(commands('powershell', platform), platform).toEqual([]);
      expect(commands('cmd', platform), platform).toEqual([]);
    }
  });

  it('macOS 专属 preset 只在 darwin 出候选，且带命令时走 osascript', () => {
    expect(commands('terminal', 'darwin')).toEqual(['open']);
    expect(commands('terminal', 'darwin', RUN)).toEqual(['osascript']);
    expect(commands('iterm', 'darwin')).toEqual(['open']);
    expect(commands('iterm', 'darwin', RUN)).toEqual(['osascript']);
    expect(commands('terminal', 'win32')).toEqual([]);
    expect(commands('iterm', 'linux')).toEqual([]);
  });

  it('gnome/konsole 不按平台门控（选项可能来自另一台机器）', () => {
    expect(commands('gnome', 'win32')).toEqual(['gnome-terminal']);
    expect(commands('konsole', 'linux')).toEqual(['konsole']);
  });

  it('ghostty：无 Windows 版；macOS 走 bundle 因而不能带命令；Linux 走自己的 flag', () => {
    expect(commands('ghostty', 'win32')).toEqual([]);
    expect(commands('ghostty', 'darwin')).toEqual(['open']);
    expect(commands('ghostty', 'darwin', RUN)).toEqual([]);
    expect(commands('ghostty', 'linux', RUN)).toEqual(['ghostty']);
  });

  it('wezterm 跨平台都出候选（run 的真分流在后端覆写里）', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(commands('wezterm', platform), platform).toEqual(['wezterm']);
    }
  });

  it('custom 展开占位、经 shell 执行；空模板不出候选', () => {
    const [plain] = resolveTerminalLaunch(DIR, settings('custom', 'myt -d {path}'), 'linux', RUN);
    expect(plain).toMatchObject({ shell: true, args: [] });
    expect(plain!.command).toContain(DIR); // {path} 已展开
    expect(plain!.command).toContain('claude'); // 无 {command} 占位 → 追加命令

    const [token] = resolveTerminalLaunch(
      DIR,
      settings('custom', 'myt --cmd {command}'),
      'linux',
      RUN,
    );
    expect(token!.command.startsWith('myt --cmd ')).toBe(true);
    // 占位替换而非追加：命令只出现一次
    expect(token!.command.match(/claude/g)).toHaveLength(1);

    expect(resolveTerminalLaunch(DIR, settings('custom', ''), 'linux')).toEqual([]);
  });
});

describe('终端后端 — auto 由具名条目组合（去重的等价性证明）', () => {
  it('win32：auto 的候选 === wt + powershell + cmd 的串联', () => {
    const auto = resolveTerminalLaunch(DIR, settings('auto'), 'win32', RUN);
    const composed = (['wt', 'powershell', 'cmd'] as const).flatMap((preset) =>
      resolveTerminalLaunch(DIR, settings(preset), 'win32', RUN),
    );
    expect(auto).toEqual(composed);
  });

  it('darwin：带命令时 auto 只用 Terminal，不把命令塞进 iTerm', () => {
    expect(commands('auto', 'darwin', RUN)).toEqual(['osascript']);
    expect(commands('auto', 'darwin')).toEqual(['open', 'open']); // Terminal + iTerm
  });

  it('linux：auto 串 gnome-terminal + konsole', () => {
    expect(commands('auto', 'linux')).toEqual(['gnome-terminal', 'konsole']);
  });

  it('未知 preset 回落 auto（与旧 switch 的 default 一致）', () => {
    const bogus = { preset: 'nope', customCommand: '' } as unknown as TerminalSettings;
    expect(resolveTerminalLaunch(DIR, bogus, 'linux')).toEqual(
      resolveTerminalLaunch(DIR, settings('auto'), 'linux'),
    );
  });
});

describe('终端后端 — 枚举能力归后端（调用方不再列 preset 白名单）', () => {
  it('只有 wezterm / auto 能反查已开窗口', () => {
    expect(terminalBackendFor(settings('wezterm')).enumerable).toBe(true);
    expect(terminalBackendFor(settings('auto')).enumerable).toBe(true);
    for (const preset of [
      'wt',
      'powershell',
      'cmd',
      'terminal',
      'iterm',
      'gnome',
      'konsole',
      'ghostty',
      'custom',
    ] as const) {
      expect(terminalBackendFor(settings(preset)).enumerable, preset).toBe(false);
    }
  });

  it('不支持的 preset 反查走空实现（一次 wezterm 都不 spawn）', async () => {
    const backend = terminalBackendFor(settings('cmd'));
    expect((await backend.countWindows(['/a', '/b'])).size).toBe(0);
    expect(await backend.listTargets('/a')).toEqual([]);
  });
});
