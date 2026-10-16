import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLsofCwds,
  parsePromptPaneId,
  parsePsRootPids,
  parseTerminalAppDump,
  parseTerminalAppTargetId,
  parseWtProcDump,
  parseWtTargetId,
  pickTerminalAppWindow,
  promptTerminalChannel,
  resolveTerminalLaunch,
  sessionScreensFromEnvs,
  SocketProbeGate,
  terminalAppTargets,
  terminalBackendFor,
  weztermMuxKey,
  weztermPaneFromEnv,
  weztermSocketCandidates,
  wtPanes,
  wtWindowSlug,
} from '../opener.js';
import type {
  TerminalAppSurface,
  TerminalSettings,
  WeztermPaneInfo,
  WtProcRow,
} from '../opener.js';

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
  it('只有 wezterm / auto / darwin 的 Terminal.app / win32 的 wt 能反查已开窗口', () => {
    expect(terminalBackendFor(settings('wezterm')).enumerable).toBe(true);
    expect(terminalBackendFor(settings('auto')).enumerable).toBe(true);
    // Terminal.app 的枚举通道（osascript+ps+lsof）只在 darwin 存在
    expect(terminalBackendFor(settings('terminal'), 'darwin').enumerable).toBe(true);
    // wt 的枚举通道（进程表 + PEB cwd 走读）只在 win32 存在
    expect(terminalBackendFor(settings('wt'), 'win32').enumerable).toBe(true);
    expect(terminalBackendFor(settings('wt'), 'linux').enumerable).toBe(false);
    for (const preset of [
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

  it('prompt 文本通道能力归后端：只有 wezterm（auto 在无 wezterm attach 的平台不亮）', () => {
    expect(terminalBackendFor(settings('wezterm')).textAddressable).toBe(true);
    expect(terminalBackendFor(settings('auto'), 'linux').textAddressable).toBe(true);
    expect(terminalBackendFor(settings('auto'), 'win32').textAddressable).toBe(false);
    expect(terminalBackendFor(settings('auto'), 'darwin').textAddressable).toBe(false);
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
      expect(terminalBackendFor(settings(preset)).textAddressable, preset).toBe(false);
    }
  });

  it('无文本通道的后端：枚举空表 + 注入明确拒绝（不静默谎报）', async () => {
    const backend = terminalBackendFor(settings('wt'), 'win32');
    await expect(backend.listPromptPanes()).resolves.toEqual([]);
    await expect(backend.sendPromptText('deadbeef:7', 'hi')).rejects.toThrow(
      'Terminal preset "wt" cannot send text into an open pane',
    );
  });

  it('prompt pane id 解码：`<mux 短哈希>:<paneId>`；坏 id → null', () => {
    expect(parsePromptPaneId('deadbeef:42')).toEqual({ muxKey: 'deadbeef', paneId: 42 });
    expect(parsePromptPaneId('terminal:1:2')).toBeNull();
    expect(parsePromptPaneId('deadbeef:x')).toBeNull();
    expect(parsePromptPaneId(':7')).toBeNull();
  });

  it('promptTerminalChannel 适配器：随 settings 后端变化，available 不谎报、注入有明确拒绝', async () => {
    let current = settings('wezterm');
    const channel = promptTerminalChannel(() => current);
    expect(channel.available()).toBe(true);

    // 运行期换 preset：通道声明跟着变（能力矩阵同一拍感知）
    current = settings('wt');
    expect(channel.available()).toBe(false);
    await expect(channel.listPanes()).resolves.toEqual([]);
    await expect(channel.sendText('deadbeef:7', 'hi')).rejects.toThrow(
      'Terminal preset "wt" cannot send text into an open pane',
    );
  });

  it('无通道的 preset 定点附加明确拒绝，文案带 preset 名', async () => {
    // wt 在 win32 已有定点通道（split-pane），不在此列
    for (const preset of ['ghostty', 'iterm', 'powershell'] as const) {
      const backend = terminalBackendFor(settings(preset), 'win32');
      await expect(backend.runAt('/tmp/p', ['claude'], 'terminal:1:1'), preset).rejects.toThrow(
        `Terminal preset "${preset}" cannot attach to a chosen pane`,
      );
    }
  });
});

describe('终端后端 — Terminal.app 通道（osascript 反查 + do script 落子）', () => {
  it('osascript dump → surfaces（坏行跳过，不整体失败）', () => {
    const dump = [
      '4029\t1\t/dev/ttys001\ttrue\ttrue',
      '4029\t2\t/dev/ttys002\tfalse\ttrue',
      'junk',
      '4030\t1\t/dev/ttys003\ttrue\tfalse',
    ].join('\n');
    expect(parseTerminalAppDump(dump)).toEqual([
      { windowId: 4029, tabIndex: 1, tty: '/dev/ttys001', selected: true, frontmost: true },
      { windowId: 4029, tabIndex: 2, tty: '/dev/ttys002', selected: false, frontmost: true },
      { windowId: 4030, tabIndex: 1, tty: '/dev/ttys003', selected: true, frontmost: false },
    ]);
    expect(parseTerminalAppDump('')).toEqual([]);
  });

  it('ps → 每 tty 的进程树根（父进程不在同一 tty = shell；exec 替换后就是它）', () => {
    const ps = [
      '  500   123 ttys001', // 根：父 123 不在 ttys001
      '  777   500 ttys001', // claude，父是 500（同 tty）→ 非根
      '  888   999 ttys002', // 根（exec 替换成 claude 后 cwd 口径不变）
      '  999     1 ??', // 无 tty 的进程不进
    ].join('\n');
    expect(parsePsRootPids(ps)).toEqual(
      new Map([
        ['ttys001', 500],
        ['ttys002', 888],
      ]),
    );
  });

  it('lsof -Fn → pid → cwd', () => {
    const lsof = ['p500', 'fcwd', 'n/Users/x/proj', 'p888', 'fcwd', 'n/tmp/other'].join('\n');
    expect(parseLsofCwds(lsof)).toEqual(
      new Map([
        [500, '/Users/x/proj'],
        [888, '/tmp/other'],
      ]),
    );
    expect(parseLsofCwds('')).toEqual(new Map());
  });

  const surface = (
    windowId: number,
    tabIndex: number,
    cwd: string | null,
    selected: boolean,
    frontmost: boolean,
  ): TerminalAppSurface => ({
    windowId,
    tabIndex,
    tty: `/dev/ttys0${windowId}${tabIndex}`,
    selected,
    frontmost,
    cwd,
  });

  it('目标列表：只列本项目 tab；frontmost → 聚焦 → 新 tab 排前', () => {
    const surfaces = [
      surface(1, 1, '/other', true, true), // 非本项目
      surface(2, 3, '/tmp/proj', false, true), // 本项目，最前窗口的背景 tab
      surface(2, 1, '/tmp/proj', true, true), // 本项目，最前窗口的聚焦 tab
      surface(2, 2, null, false, true), // cwd 取不到 → 不进
      surface(3, 1, '/tmp/proj', true, false), // 本项目，背景窗口的聚焦 tab
    ];
    const targets = terminalAppTargets('/tmp/proj', surfaces, 'darwin');
    expect(targets.map((t) => t.id)).toEqual(['terminal:2:1', 'terminal:2:3', 'terminal:3:1']);
    expect(targets[0]).toMatchObject({
      windowId: 2,
      tabId: 1,
      title: null, // 不取 tab 标题：前端回落「窗口 W · Tab T」
      matchCount: 1,
      paneCount: 1,
      active: true,
    });
    expect(targets[2]!.active).toBe(false);
  });

  it('run 落点：frontmost 优先，其次最大 windowId（越晚创建越近用过）；没有 → null', () => {
    const surfaces = [
      surface(3, 1, '/tmp/proj', true, false),
      surface(2, 1, '/tmp/proj', false, false),
    ];
    expect(pickTerminalAppWindow(surfaces, '/tmp/proj', 'darwin')).toEqual({
      windowId: 3,
      tabIndex: 1,
    });
    const front = [surface(9, 2, '/tmp/proj', false, false), surface(2, 7, '/tmp/proj', true, true)];
    expect(pickTerminalAppWindow(front, '/tmp/proj', 'darwin')).toEqual({
      windowId: 2,
      tabIndex: 7,
    });
    expect(pickTerminalAppWindow([surface(1, 1, '/other', true, true)], '/tmp/proj', 'darwin')).toBeNull();
  });

  it('目标 id 解码：terminal:<win>:<tab>；wezterm 格式互不通用，坏 id → null', () => {
    expect(parseTerminalAppTargetId('terminal:4029:2')).toEqual({ windowId: 4029, tabIndex: 2 });
    expect(parseTerminalAppTargetId('deadbeef:1:2')).toBeNull();
    expect(parseTerminalAppTargetId('terminal:x:1')).toBeNull();
  });

  it('枚举在无 osascript 的环境优雅归零（不 throw，角标不谎报）', async () => {
    const backend = terminalBackendFor(settings('terminal'), 'darwin');
    await expect(backend.listTargets('/tmp/proj')).resolves.toEqual([]);
    const counts = await backend.countWindows(['/tmp/proj']);
    expect(counts.get('/tmp/proj')).toBe(0);
  });
});

describe('终端后端 — Windows Terminal 通道（进程表反查 + 命名窗口落子）', () => {
  // 与 parseWtProcDump 出口一致：name 已归一小写（wtPanes 按小写名匹配）
  const row = (pid: number, parentPid: number, name: string, created: string, cwd: string | null): WtProcRow => ({
    pid,
    parentPid,
    name: name.toLowerCase(),
    created,
    cwd,
  });

  it('进程表 dump → rows（5 列 TSV；cwd 空列 → null；坏行跳过不整体失败）', () => {
    const dump = [
      '200|100|bash.exe|20240101120000|D:\\proj',
      '201|100|OpenConsole.exe|20240101120000|',
      'junk',
      '0|100|zero-pid.exe|20240101120000|x',
      '200|abc|bad-ppid.exe|20240101120000|x',
      '202|100||20240101120000|x',
    ].join('\n');
    expect(parseWtProcDump(dump)).toEqual([
      { pid: 200, parentPid: 100, name: 'bash.exe', created: '20240101120000', cwd: 'D:\\proj' },
      { pid: 201, parentPid: 100, name: 'openconsole.exe', created: '20240101120000', cwd: null },
    ]);
    expect(parseWtProcDump('')).toEqual([]);
  });

  it('pane 根 = WindowsTerminal 直接子进程里非 OpenConsole 的；OpenConsole 是兄弟不是 pane', () => {
    const panes = wtPanes([
      row(100, 1, 'WindowsTerminal.exe', '20240101110000', null),
      row(201, 100, 'OpenConsole.exe', '20240101120000', null), // ConPTY 宿主，排除
      row(202, 100, 'cmd.exe', '20240101120000', 'D:\\other'),
    ]);
    expect(panes).toEqual([{ pid: 202, cwd: 'D:\\other' }]);
    expect(wtPanes([row(1, 0, 'bash.exe', '20240101110000', '/x')])).toEqual([]);
  });

  it('shell 根跟到最深 shell（Git Bash 启动器 cwd 冻结，活的 cwd 在 usr/bin/bash 子进程）', () => {
    const panes = wtPanes([
      row(100, 1, 'WindowsTerminal.exe', '20240101110000', null),
      row(200, 100, 'bash.exe', '20240101120000', 'D:\\frozen'), // bin/bash 启动器
      row(300, 200, 'bash.exe', '20240101120001', 'D:\\proj\\live'), // usr/bin/bash 真 shell
    ]);
    expect(panes).toEqual([{ pid: 200, cwd: 'D:\\proj\\live' }]);
  });

  it('同壳多子（用户手敲了嵌套 shell）跟最年轻的；同时刻并列按 pid 高者', () => {
    const panes = wtPanes([
      row(100, 1, 'WindowsTerminal.exe', '20240101110000', null),
      row(200, 100, 'bash.exe', '20240101120000', 'D:\\frozen'),
      row(301, 200, 'bash.exe', '20240101120500', 'D:\\old'),
      row(302, 200, 'bash.exe', '20240101120600', 'D:\\same-instant'),
      row(303, 200, 'bash.exe', '20240101120600', 'D:\\same-instant-higher-pid'),
    ]);
    expect(panes).toEqual([{ pid: 200, cwd: 'D:\\same-instant-higher-pid' }]);
  });

  it('非 shell 根取自己的 cwd——claude 的工具子进程不是 pane，不该跟', () => {
    const panes = wtPanes([
      row(100, 1, 'WindowsTerminal.exe', '20240101110000', null),
      row(500, 100, 'claude.exe', '20240101120000', 'D:\\proj'),
      row(600, 500, 'bash.exe', '20240101120200', 'D:\\tool-chdir'), // claude Bash 工具的子进程
    ]);
    expect(panes).toEqual([{ pid: 500, cwd: 'D:\\proj' }]);
  });

  it('命名窗口名：同路径稳定、大小写不敏感路径同名、不同路径必不同', () => {
    const slug = wtWindowSlug('C:\\work\\weave');
    expect(slug).toBe(wtWindowSlug('C:\\work\\weave'));
    expect(slug).toBe(wtWindowSlug('c:\\work\\weave')); // win32 键归一含小写
    expect(wtWindowSlug('C:\\work\\other')).not.toBe(slug);
    expect(slug).toMatch(/^weave-[a-z0-9-]+-[0-9a-f]{8}$/);
  });

  it('目标 id 解码：wt:<slug>；非 wt 前缀 / 大写 / 空 slug → null', () => {
    expect(parseWtTargetId('wt:weave-d-proj-1a2b3c4d')).toBe('weave-d-proj-1a2b3c4d');
    expect(parseWtTargetId('wt:')).toBeNull();
    expect(parseWtTargetId('wt:Weave-X')).toBeNull();
    expect(parseWtTargetId('terminal:1:2')).toBeNull();
  });

  it('落子候选：wt 命名窗口（-w slug），开窗即进 tab、带命令经 cmd.exe 转发', () => {
    const DIR = 'D:\\proj';
    const [open] = resolveTerminalLaunch(DIR, settings('wt'), 'win32');
    expect(open).toEqual({
      command: 'wt.exe',
      args: ['-w', wtWindowSlug(DIR), '-d', DIR],
    });
    const [run] = resolveTerminalLaunch(DIR, settings('wt'), 'win32', RUN);
    expect(run).toEqual({
      command: 'wt.exe',
      args: ['-w', wtWindowSlug(DIR), '-d', DIR, 'cmd.exe', '/k', 'claude --resume abc'],
    });
    expect(commands('wt', 'darwin')).toEqual([]);
  });
});

describe('weztermSocketCandidates — 同一 socket 的两种字符串形态只算一个候选', () => {
  it('env 混合分隔符与 join 全反斜杠指向同一 socket：不双计（窗口数不翻倍）', () => {
    const home = mkdtempSync(join(tmpdir(), 'weave-wezterm-'));
    const prevHome = process.env.USERPROFILE;
    const prevSocket = process.env.WEZTERM_UNIX_SOCKET;
    try {
      const sockDir = join(home, '.local', 'share', 'wezterm');
      mkdirSync(sockDir, { recursive: true });
      // gui-sock 名内嵌 pid 探活——用本测试进程 pid 必过
      writeFileSync(join(sockDir, `gui-sock-${process.pid}`), '');
      process.env.USERPROFILE = home;
      // wezterm 注进 pane env 的形态：盘符段反斜杠 + 其余正斜杠
      process.env.WEZTERM_UNIX_SOCKET = `${home}/.local/share/wezterm/gui-sock-${process.pid}`;

      const candidates = weztermSocketCandidates('win32');
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toBe(process.env.WEZTERM_UNIX_SOCKET); // env 形态最优先保留
    } finally {
      process.env.USERPROFILE = prevHome;
      if (prevSocket === undefined) delete process.env.WEZTERM_UNIX_SOCKET;
      else process.env.WEZTERM_UNIX_SOCKET = prevSocket;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('env 未设时仍枚举存活 gui-sock（死 pid 的跳过）', () => {
    const home = mkdtempSync(join(tmpdir(), 'weave-wezterm-'));
    const prevHome = process.env.USERPROFILE;
    const prevSocket = process.env.WEZTERM_UNIX_SOCKET;
    try {
      const sockDir = join(home, '.local', 'share', 'wezterm');
      mkdirSync(sockDir, { recursive: true });
      writeFileSync(join(sockDir, `gui-sock-${process.pid}`), '');
      writeFileSync(join(sockDir, 'gui-sock-999999999'), ''); // 必死 pid
      writeFileSync(join(sockDir, 'agent.12345'), ''); // 非 gui-sock 形态
      process.env.USERPROFILE = home;
      delete process.env.WEZTERM_UNIX_SOCKET;

      expect(weztermSocketCandidates('win32')).toEqual([
        join(sockDir, `gui-sock-${process.pid}`),
      ]);
    } finally {
      process.env.USERPROFILE = prevHome;
      if (prevSocket === undefined) delete process.env.WEZTERM_UNIX_SOCKET;
      else process.env.WEZTERM_UNIX_SOCKET = prevSocket;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('weztermPaneFromEnv — hook 上报的 pane env 定位（纯函数）', () => {
  const SOCK = 'D:\\Users\\u\\.local\\share\\wezterm\\gui-sock-28500';
  const MUXES = [{ socket: SOCK, panes: [{ paneId: 0 }, { paneId: 6 }] }];
  const envOf = (pane: string, socket: string) => ({
    WEZTERM_PANE: pane,
    WEZTERM_UNIX_SOCKET: socket,
  });

  it('pane 号 + 同实例 socket → 该 pane 的 prompt pane id', () => {
    expect(weztermPaneFromEnv(envOf('0', SOCK), MUXES, 'win32')).toBe(
      `${weztermMuxKey(SOCK)}:0`,
    );
    // 大小写/分隔符形态差异不影响命中（归一比较，id 用枚举到的真 socket 算）
    expect(
      weztermPaneFromEnv(envOf('6', SOCK.toLowerCase().replace(/\\/g, '/')), MUXES, 'win32'),
    ).toBe(`${weztermMuxKey(SOCK)}:6`);
  });

  it('键缺、socket 对不上活 mux、pane 已不在 → null（回落标题+cwd，不猜）', () => {
    expect(weztermPaneFromEnv({}, MUXES, 'win32')).toBeNull();
    expect(weztermPaneFromEnv({ WEZTERM_PANE: '0' }, MUXES, 'win32')).toBeNull();
    expect(weztermPaneFromEnv(envOf('0', 'D:/other/gui-sock-1'), MUXES, 'win32')).toBeNull();
    expect(weztermPaneFromEnv(envOf('3', SOCK), MUXES, 'win32')).toBeNull();
    expect(weztermPaneFromEnv(envOf('0', SOCK), [], 'win32')).toBeNull();
  });
});

describe('sessionScreensFromEnvs — 会话 → 所在可见屏幕（纯函数）', () => {
  const SOCK = 'D:\\Users\\u\\.local\\share\\wezterm\\gui-sock-28500';
  const pane = (paneId: number, windowId: number, tabId: number): WeztermPaneInfo => ({
    windowId,
    tabId,
    paneId,
    cwd: null,
    left: 0,
    top: 0,
    isActive: false,
    title: null,
  });
  // 窗口 0 两个 tab（tab 0 有 0/1 两个 pane，tab 1 有 pane 2）；窗口 1 一个 tab（pane 5）
  const MUXES = [
    {
      socket: SOCK,
      panes: [pane(0, 0, 0), pane(1, 0, 0), pane(2, 0, 1), pane(5, 1, 2)],
    },
  ];
  const envOf = (paneId: string, socket = SOCK) => ({
    WEZTERM_PANE: paneId,
    WEZTERM_UNIX_SOCKET: socket,
  });

  it('会话归到它那个 pane 所在的 window/tab，块头带同窗口 tab 数', () => {
    const screens = sessionScreensFromEnvs(
      { a: envOf('2'), b: envOf('1'), c: envOf('5') },
      MUXES,
      'win32',
    );
    const key = weztermMuxKey(SOCK);
    expect(screens.a).toEqual({ id: `${key}:0:1`, windowId: 0, tabId: 1, tabsInWindow: 2 });
    // 同一块屏上的两个会话给出**同一个 id**（前端据此聚成一块）
    expect(screens.b).toEqual({ id: `${key}:0:0`, windowId: 0, tabId: 0, tabsInWindow: 2 });
    expect(screens.c).toEqual({ id: `${key}:1:2`, windowId: 1, tabId: 2, tabsInWindow: 1 });
  });

  it('键缺、socket 对不上活 mux、pane 已不在 → null（该会话不分组，不猜）', () => {
    expect(
      sessionScreensFromEnvs(
        {
          gone: envOf('9'),
          other: envOf('0', 'D:/other/gui-sock-1'),
          bare: {},
        },
        MUXES,
        'win32',
      ),
    ).toEqual({ gone: null, other: null, bare: null });
  });

  it('空 env 表 → 空结果（没上报过定位的会话不进快照）', () => {
    expect(sessionScreensFromEnvs({}, MUXES, 'win32')).toEqual({});
  });
});

describe('SocketProbeGate — 陈旧 socket 不再反复探', () => {
  it('干净失败 → 永久不再探（路径与 GUI pid 绑定，进程死即永久失效）', () => {
    const gate = new SocketProbeGate();
    expect(gate.shouldProbe('/sock-a')).toBe(true);

    gate.failed('/sock-a');
    expect(gate.shouldProbe('/sock-a')).toBe(false);
    // 时间也救不回来：新 GUI 必然是新 pid → 新路径，旧路径不会复活
    expect(gate.shouldProbe('/sock-a', Date.now() + 24 * 3600_000)).toBe(false);
  });

  it('超时 → 只回避一段（GUI 可能只是忙），到期后继续探', () => {
    const gate = new SocketProbeGate();
    const t0 = 1_000_000;

    gate.cooledDown('/sock-b', t0);
    expect(gate.shouldProbe('/sock-b', t0 + 1)).toBe(false);
    expect(gate.shouldProbe('/sock-b', t0 + 60_001)).toBe(true);
  });

  it('探活成功即清掉回避态', () => {
    const gate = new SocketProbeGate();
    const t0 = 1_000_000;

    gate.cooledDown('/sock-c', t0);
    expect(gate.shouldProbe('/sock-c', t0 + 1)).toBe(false);

    gate.succeeded('/sock-c');
    expect(gate.shouldProbe('/sock-c', t0 + 2)).toBe(true);
  });
});
