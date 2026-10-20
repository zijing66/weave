import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applescriptString,
  itermPaneFromEnv,
  konsolePaneFromEnv,
  parseItermPaneId,
  parseKonsolePaneId,
  parseLsofCwds,
  parsePromptPaneId,
  parsePsRootPids,
  parseTerminalAppDump,
  parseTerminalAppTargetId,
  parseWtPaneId,
  parseWtProcDump,
  parseWtTargetId,
  panesAtDir,
  pickTerminalAppWindow,
  locatorPresetOf,
  promptTerminalChannel,
  qtKeyOf,
  resolveTerminalLaunch,
  sessionScreensFromEnvs,
  SocketProbeGate,
  terminalAppTargets,
  terminalBackendFor,
  weztermMuxKey,
  weztermPaneFromEnv,
  weztermSocketCandidates,
  weztermCliArgs,
  winRaiseEncodedScript,
  wtInjectEncodedScript,
  wtPanePidFromEnv,
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

  it('prompt 文本通道能力归后端：wezterm 与 win32 的 wt（auto 在无 attach 通道的平台不亮）', () => {
    expect(terminalBackendFor(settings('wezterm')).textAddressable).toBe(true);
    expect(terminalBackendFor(settings('wt'), 'win32').textAddressable).toBe(true);
    expect(terminalBackendFor(settings('auto'), 'linux').textAddressable).toBe(true);
    expect(terminalBackendFor(settings('auto'), 'win32').textAddressable).toBe(false);
    expect(terminalBackendFor(settings('auto'), 'darwin').textAddressable).toBe(false);
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
      expect(terminalBackendFor(settings(preset)).textAddressable, preset).toBe(false);
    }
  });

  it('无文本通道的后端：枚举空表 + 注入明确拒绝（不静默谎报）', async () => {
    const backend = terminalBackendFor(settings('powershell'), 'win32');
    await expect(backend.listPromptPanes()).resolves.toEqual([]);
    await expect(backend.sendPromptText('deadbeef:7', 'hi')).rejects.toThrow(
      'Terminal preset "powershell" cannot send text into an open pane',
    );
  });

  it('prompt pane id 解码：`<mux 短哈希>:<paneId>`；坏 id → null', () => {
    expect(parsePromptPaneId('deadbeef:42')).toEqual({ muxKey: 'deadbeef', paneId: 42 });
    expect(parsePromptPaneId('terminal:1:2')).toBeNull();
    expect(parsePromptPaneId('deadbeef:x')).toBeNull();
    expect(parsePromptPaneId(':7')).toBeNull();
  });

  it('promptTerminalChannel：定位/击键按会话自己的终端走，与开窗 preset 无关', async () => {
    let current = settings('wezterm');
    const channel = promptTerminalChannel(() => current);

    // 运行期把开窗 preset 换成 wt（用户点设置里那个下拉）：文本通道不受影响——
    // 会话活在 wezterm pane 里，pane env 才是归属凭据，不能被开窗偏好否掉。
    current = settings('wt');
    expect(channel.available()).toBe(true);
    // 启发式回落的枚举面仍只在 preset 指向的世界里：wt 不是文本通道 → 空表，
    // 不跨世界拿标题+cwd 去猜（否则 macOS terminal preset 的用户会被误 ESC）。
    await expect(channel.listPanes()).resolves.toEqual([]);
    // 定位键不全 → 认不出世界，判 null（不猜，也不为此枚举 mux）
    await expect(channel.locatePane({ WEZTERM_PANE: '7' })).resolves.toBeNull();
    // 没人认领的 pane id → 通道自身拒绝（文本通道不再有「配置的后端」这条兜底路径）
    await expect(channel.sendKeys('bad-id', '\x1b')).rejects.toThrow('Invalid prompt pane "bad-id"');
  });

  it('会话的终端归属：env 认世界、pane id 认后端，都不看设置里的 preset', () => {
    // env → preset：判据是 core 的定位键表，一组键齐了才认（缺键 = 不是那个终端）
    expect(locatorPresetOf({ WEZTERM_PANE: '7', WEZTERM_UNIX_SOCKET: '/tmp/gui-sock-1' })).toBe(
      'wezterm',
    );
    expect(locatorPresetOf({ WEZTERM_PANE: '7' })).toBeNull();
    expect(locatorPresetOf({ WT_SESSION: 'x' })).toBeNull();
    // pane id → 后端：只有发它的那个后端认领（id 表示法归后端，别人不抢）
    const wezterm = terminalBackendFor(settings('wezterm'), 'win32');
    const wt = terminalBackendFor(settings('wt'), 'win32');
    expect(wezterm.ownsPaneId('deadbeef:7')).toBe(true);
    expect(wezterm.ownsPaneId('terminal:1:2')).toBe(false);
    expect(wt.ownsPaneId('deadbeef:7')).toBe(false);
  });

  it('mux 短标识按比较键取哈希：同一 socket 的两种分隔符形态给出同一个 id', () => {
    // wezterm 注进 pane env 的是混合分隔符，目录拼出来的是全反斜杠——裸串哈希会
    // 同一实例发两个 id，投递时按 id 反查就落空。
    const mixed = 'D:\\Users\\x\\.local/share/wezterm/gui-sock-1';
    const slashed = 'D:\\Users\\x\\.local\\share\\wezterm\\gui-sock-1';
    expect(weztermMuxKey(mixed)).toBe(weztermMuxKey(slashed));
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

  it('env 里是死掉的 gui-sock 时整段丢弃（daemon 从旧 pane 继承来的死 socket）', () => {
    const home = mkdtempSync(join(tmpdir(), 'weave-wezterm-'));
    const prevHome = process.env.USERPROFILE;
    const prevSocket = process.env.WEZTERM_UNIX_SOCKET;
    try {
      const sockDir = join(home, '.local', 'share', 'wezterm');
      mkdirSync(sockDir, { recursive: true });
      writeFileSync(join(sockDir, `gui-sock-${process.pid}`), '');
      process.env.USERPROFILE = home;
      // GUI 已退出的 socket：探活闸挡不住 force 点名，只能在这里就不放进候选
      process.env.WEZTERM_UNIX_SOCKET = join(sockDir, 'gui-sock-999999999');

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

describe('weztermCliArgs — 恒带 --no-auto-start（cli 对失联 socket 会拉起永不退出的 mux-server）', () => {
  it('cli 子命令插在 cli 与子命令之间', () => {
    expect(weztermCliArgs(['cli', 'list', '--format', 'json'])).toEqual([
      'cli',
      '--no-auto-start',
      'list',
      '--format',
      'json',
    ]);
    expect(weztermCliArgs(['cli', 'send-text', '--pane-id', '3', 'hi'])).toEqual([
      'cli',
      '--no-auto-start',
      'send-text',
      '--pane-id',
      '3',
      'hi',
    ]);
  });

  it('非 cli 前缀的调用原样透传（当前没有，防将来误伤）', () => {
    expect(weztermCliArgs(['start', '--cwd', '/p'])).toEqual(['start', '--cwd', '/p']);
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

describe('wt 击键通道 — env→pid 定位与 pane id 表示法', () => {
  const envOf = (pid = '4242', world = 'prof-1') => ({
    WT_PROFILE_ID: world,
    CLAUDE_PID: pid,
  });

  it('定位键齐了才认：profile 标记 + 会话进程号', () => {
    expect(locatorPresetOf(envOf())).toBe('wt');
    expect(locatorPresetOf({ WT_PROFILE_ID: 'prof-1' })).toBeNull();
    expect(locatorPresetOf({ CLAUDE_PID: '4242' })).toBeNull();
    expect(wtPanePidFromEnv(envOf())).toBe(4242);
    expect(wtPanePidFromEnv(envOf('0'))).toBeNull();
    expect(wtPanePidFromEnv(envOf('abc'))).toBeNull();
  });

  it('pane id = wt:<pid>；坏 id 不认领', () => {
    expect(parseWtPaneId('wt:4242')).toBe(4242);
    expect(parseWtPaneId('wt:0')).toBeNull();
    expect(parseWtPaneId('wt:-1')).toBeNull();
    expect(parseWtPaneId('4242')).toBeNull();
    expect(parseWtPaneId('deadbeef:7')).toBeNull();
  });

  it('只有 win32 有这条通道；pane id 归 wt 认领，wezterm 不抢', () => {
    const wt = terminalBackendFor(settings('wt'), 'win32');
    expect(wt.textAddressable).toBe(true);
    expect(wt.ownsPaneId('wt:4242')).toBe(true);
    expect(wt.ownsPaneId('deadbeef:7')).toBe(false);
    expect(terminalBackendFor(settings('wezterm'), 'win32').ownsPaneId('wt:4242')).toBe(false);
    // 别的平台没有 console 输入记录通道：不谎报
    expect(terminalBackendFor(settings('wt'), 'darwin').textAddressable).toBe(false);
  });

  it('定位 = 上报的会话进程号，死了/不是 wt 会话 → null（回落标题+cwd）', async () => {
    const wt = terminalBackendFor(settings('wt'), 'win32');
    expect(await wt.locatePane(envOf(String(process.pid)))).toBe(`wt:${process.pid}`);
    // 999999 恒不在（Windows 上 kill 抛 ESRCH）——存在性校验失败即 null，不猜
    expect(await wt.locatePane(envOf('999999'))).toBeNull();
    expect(await wt.locatePane({})).toBeNull();
  });

  it('坏 pane id 明确拒绝，不会往别的 target 打键', async () => {
    const wt = terminalBackendFor(settings('wt'), 'win32');
    await expect(wt.sendKeys('deadbeef:7', '\x1b')).rejects.toThrow('Invalid prompt pane');
    await expect(wt.sendPromptText('wt:x', 'hi')).rejects.toThrow('Invalid prompt pane');
  });

  it('注入脚本经 -EncodedCommand 传（UTF-16 base64），键串走 env 不进脚本正文', () => {
    const decoded = Buffer.from(wtInjectEncodedScript(), 'base64').toString('utf16le');
    expect(decoded).toContain('AttachConsole');
    expect(decoded).toContain('WriteConsoleInputW');
    expect(decoded).toContain('$env:WEAVE_WT_KEYS');
    expect(decoded).toContain('$env:WEAVE_WT_PID');
    // here-string 收尾必须在行首，否则 PowerShell 解析报错
    expect(decoded).toContain(`\n'@\n`);
  });
});

describe('konsole / iterm 击键通道 — env→pane 定位与表示法（本机无法实机验证）', () => {
  it('定位键齐了才认，且 konsole/iterm 排在 wezterm 前面（终端套终端时内层优先）', () => {
    expect(locatorPresetOf({ KONSOLE_DBUS_SERVICE: ':1.42', KONSOLE_DBUS_SESSION: '/Sessions/3' })).toBe(
      'konsole',
    );
    expect(locatorPresetOf({ KONSOLE_DBUS_SERVICE: ':1.42' })).toBeNull();
    expect(locatorPresetOf({ ITERM_SESSION_ID: 'w0t1p0:ABCD-1' })).toBe('iterm');
    // 从 wezterm 里起的 konsole/iterm 会带着外层 WEZTERM_*：内层的先命中
    const nested = {
      WEZTERM_PANE: '7',
      WEZTERM_UNIX_SOCKET: '/tmp/gui-sock-1',
      KONSOLE_DBUS_SERVICE: 'org.kde.konsole-7',
      KONSOLE_DBUS_SESSION: '/Sessions/1',
    };
    expect(locatorPresetOf(nested)).toBe('konsole');
  });

  it('pane id 表示法归各后端：konsole 带服务名+会话路径，iterm 带 unique id', () => {
    expect(parseKonsolePaneId('konsole::1.42|/Sessions/3')).toEqual({
      service: ':1.42',
      session: '/Sessions/3',
    });
    expect(parseKonsolePaneId('konsole:org.kde.konsole-7|/Sessions/1')).not.toBeNull();
    expect(parseKonsolePaneId('konsole:|/Sessions/3')).toBeNull();
    expect(parseKonsolePaneId('konsole::1.42|Sessions/3')).toBeNull();
    expect(konsolePaneFromEnv({ KONSOLE_DBUS_SERVICE: ':1.42' })).toBeNull();
    expect(konsolePaneFromEnv({ KONSOLE_DBUS_SERVICE: ':1.42', KONSOLE_DBUS_SESSION: '/Sessions/3' })).toBe(
      'konsole::1.42|/Sessions/3',
    );

    expect(parseItermPaneId('iterm:w0t1p0:1A2B-3C')).toBe('w0t1p0:1A2B-3C');
    expect(parseItermPaneId('iterm:w0')).toBeNull();
    expect(itermPaneFromEnv({ ITERM_SESSION_ID: 'w0t1p0:1A2B-3C' })).toBe('iterm:w0t1p0:1A2B-3C');
    expect(itermPaneFromEnv({})).toBeNull();
  });

  it('平台门控与通道能力：konsole 仅在 linux、iterm 仅有文本（没有裸键序）', async () => {
    const konsole = (p: NodeJS.Platform) => terminalBackendFor(settings('konsole'), p);
    expect(konsole('linux').textAddressable).toBe(true);
    expect(konsole('win32').textAddressable).toBe(false);
    expect(konsole('linux').ownsPaneId('konsole::1.42|/Sessions/3')).toBe(true);
    expect(konsole('linux').ownsPaneId('iterm:w0t1p0:1A2B-3C')).toBe(false);

    const iterm = (p: NodeJS.Platform) => terminalBackendFor(settings('iterm'), p);
    expect(iterm('darwin').textAddressable).toBe(true);
    expect(iterm('win32').textAddressable).toBe(false);
    expect(iterm('darwin').ownsPaneId('iterm:w0t1p0:1A2B-3C')).toBe(true);
    // iTerm2 没有裸键序入口：中断/作答诚实拒绝，不假装能打
    await expect(iterm('darwin').sendKeys('iterm:w0t1p0:1A2B-3C', '\x1b')).rejects.toThrow(
      'cannot send keys',
    );
    await expect(iterm('darwin').sendPromptText('w0t1p0:1A2B-3C', 'hi')).rejects.toThrow(
      'Invalid prompt pane',
    );
  });

  it('Qt 键值映射：控制键给真值，ASCII 用码位；AppleScript 字面量先转反斜杠', () => {
    expect(qtKeyOf('\x1b')).toBe(0x01000000);
    expect(qtKeyOf('\r')).toBe(0x01000004);
    expect(qtKeyOf('\t')).toBe(0x01000001);
    expect(qtKeyOf('\b')).toBe(0x01000003);
    expect(qtKeyOf('2')).toBe(0x32);
    expect(applescriptString('a\\"b')).toBe('a\\\\\\"b');
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
      [SOCK],
      'win32',
    );
    const key = weztermMuxKey(SOCK);
    expect(screens.a).toEqual({ id: `${key}:0:1`, windowId: 0, tabId: 1, tabsInWindow: 2 });
    // 同一块屏上的两个会话给出**同一个 id**（前端据此聚成一块）
    expect(screens.b).toEqual({ id: `${key}:0:0`, windowId: 0, tabId: 0, tabsInWindow: 2 });
    expect(screens.c).toEqual({ id: `${key}:1:2`, windowId: 1, tabId: 2, tabsInWindow: 1 });
  });

  it('键缺、socket 已不在候选里、pane 已不在 → null（确认不分组，不猜）', () => {
    expect(
      sessionScreensFromEnvs(
        {
          gone: envOf('9'),
          other: envOf('0', 'D:/other/gui-sock-1'),
          bare: {},
        },
        MUXES,
        [SOCK],
        'win32',
      ),
    ).toEqual({ gone: null, other: null, bare: null });
  });

  it('mux 不在枚举表里但实例还活着 = 这轮没探到 → 缺键（web 保留上次分块）', () => {
    const probes = sessionScreensFromEnvs({ held: envOf('2') }, [], [SOCK], 'win32');
    expect(probes).toEqual({});
    // 候选清单两种路径形态都能认（win 注入的是混合分隔符）
    expect(
      sessionScreensFromEnvs(
        { held: envOf('2', 'D:\\Users\\u\\.local/share/wezterm\\gui-sock-28500') },
        [],
        [SOCK],
        'win32',
      ),
    ).toEqual({});
    // 实例没了（不在候选清单里）才摘出行
    expect(sessionScreensFromEnvs({ held: envOf('2') }, [], [], 'win32')).toEqual({ held: null });
  });

  it('空 env 表 → 空结果（没上报过定位的会话不进快照）', () => {
    expect(sessionScreensFromEnvs({}, MUXES, [SOCK], 'win32')).toEqual({});
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

describe('panesAtDir — 关终端的命中判据（关错就是杀掉用户别的活）', () => {
  const pane = (id: string, cwd: string | null) => ({ id, title: null, cwd });

  it('cwd 恰为项目目录才算：子目录 / 同名前缀 / 无 cwd 一律不碰', () => {
    const hit = panesAtDir(
      [
        pane('exact', 'D:\\work\\code\\weave'),
        pane('sub', 'D:\\work\\code\\weave\\packages'),
        pane('prefix', 'D:\\work\\code\\weave-2'),
        pane('none', null),
        pane('other', 'D:\\work\\code\\other'),
      ],
      'D:\\work\\code\\weave',
      'win32',
    );
    expect(hit.map((p) => p.id)).toEqual(['exact']);
  });

  it('win32 不分大小写、斜杠方向不分；posix 分大小写', () => {
    const panes = [pane('a', 'D:/work/code/Weave'), pane('b', '/home/u/Weave')];
    expect(panesAtDir(panes, 'd:\\work\\code\\weave', 'win32').map((p) => p.id)).toEqual(['a']);
    expect(panesAtDir(panes, '/home/u/weave', 'linux').map((p) => p.id)).toEqual([]);
    expect(panesAtDir(panes, '/home/u/Weave', 'linux').map((p) => p.id)).toEqual(['b']);
  });

  it('目录换过分隔符也能认回同一个（wezterm 的 cwd 是 / 形态）', () => {
    expect(
      panesAtDir([pane('p', 'D:/work/code/weave')], 'D:\\work\\code\\weave', 'win32').map(
        (p) => p.id,
      ),
    ).toEqual(['p']);
  });
});

describe('唤出终端 — 抬窗口脚本', () => {
  const decoded = Buffer.from(winRaiseEncodedScript(), 'base64').toString('utf16le');

  it('经 -EncodedCommand 传（UTF-16 base64），参数全走 env', () => {
    expect(decoded).toContain('EnumWindows');
    expect(decoded).toContain('SetForegroundWindow');
    expect(decoded).toContain('AttachThreadInput');
    expect(decoded).toContain('$env:WEAVE_RAISE_PANE_PIDS');
    expect(decoded).toContain('$env:WEAVE_RAISE_PIDS');
    expect(decoded).toContain('$env:WEAVE_RAISE_EXE');
    expect(decoded).toContain('$env:WEAVE_RAISE_TITLES');
    // wt 那条只给 pane pid + exe，靠进程树往上找窗口宿主
    expect(decoded).toContain('CreateToolhelp32Snapshot');
    expect(decoded).toContain(`\n'@\n`);
  });

  it('不碰 SetConsoleTitle：外部进程改的 pane console 标题不传播给 wezterm', () => {
    expect(decoded).not.toContain('SetConsoleTitleW');
  });

  it('标题比较前先归一（spinner 字与 [活动 tab/总数] 前缀都不是身份）', () => {
    expect(decoded).toContain(String.raw`-replace '^\[\d+/\d+\]\s*'`);
    expect(decoded).toContain(String.raw`-replace '^[^\p{L}\p{N}]+'`);
    expect(decoded).not.toContain(`-replace '^[d+/d+]s*'`);
  });

  it('多窗口时按候选顺序逐条试，唯一命中才抬（不猜）', () => {
    expect(decoded).toContain('foreach ($c in ($env:WEAVE_RAISE_TITLES');
    expect(decoded).toContain('if ($hit.Count -eq 1) { $pick = $hit[0]; break }');
  });
});
