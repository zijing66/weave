import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import type { TerminalPreset, TerminalSettings } from '../settings.js';
import type { AttachTarget, SessionTerminal } from './wezterm-mux.js';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, joinCmd, quotePath, throughCmd } from './shared.js';
import { wtWindowSlug } from './wt.js';

/**
 * 终端后端基类与共享件：模板方法骨架（「取候选 → 按序尝试 → 全失败抛真相」）、
 * 候选表驱动的通用后端、custom 后端、各 preset 的候选表。各终端自己的后端类在
 * 同级 `backend-<preset>.ts`；工厂表与 `auto` 组合在 opener.ts（门面层，避免
 * 基类 ← 子类 → 工厂的循环 import）。
 *
 * **能力全归后端**，一律「覆写 = 有，基类空实现 = 没有」：
 * enumerable（能否反查已开窗口，不是调用方散写的 `preset === 'wezterm'` 白名单）、
 * textAddressable（能否注入文本 / 裸键序）、locatePane（能否把 hook 上报的 pane env
 * 解析回本后端的 pane 表示法——pane 表示法是后端私有知识，调用方只见不透明 id）、
 * ownsPaneId（这个 id 是不是本后端发的——**击键/文本按 id 认领后端**，故「往哪个终端
 * 打键」不随设置里的 preset 走）。
 * 不支持就走基类空实现（角标不显示 / 层② 诚实置灰 / 回落标题+cwd 启发式，不谎报）。
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

/**
 * prompt 层② 兜底的注入落点：后端枚举出的可打文本 pane。
 * id 不透明、格式归各后端（wezterm = `<mux 短哈希>:<paneId>`）。
 */
export interface PromptPaneTarget {
  id: string;
  /** pane 标题（claude 的 OSC 标题）——与会话标题匹配的素材；取不到 = null。 */
  title: string | null;
  /** pane 实时工作目录；取不到 = null（匹配不上任何项目）。 */
  cwd: string | null;
}

/**
 * 起会话落子的起点定位（spawn 回执）：env 形状与 hook 旁路上报同构（键形归
 * 后端、出 core 表），paneEnvSource='launch' 的 harness 据此关联会话。拿不到
 * 回执的后端（wt 等 stdio ignore 路径）不产出——那些会话不分组，不猜。
 */
export interface LaunchOrigin {
  readonly env: Record<string, string>;
}

/**
 * 按 UTF-8 字节数切块（超长 prompt 分段注入用）：只在**码点边界**切——切进
 * 代理对中间会产出两个孤立代理项，编码后变 U+FFFD。上限按字节不按 `length`
 * 算：`length` 是 UTF-16 单元，中文一字三字节、emoji 一个四字节，按它切会溢出
 * 通道（argv / env 都是字节说话）。
 */
export function chunkByUtf8Bytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes && cur) {
      chunks.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * 正文里出现 paste 起止标记时不能手工分段粘贴（标记会把 paste 提前闭合、后半截
 * 在框外被当命令解释）——退回整段单发，让通道自己失败报错，不悄悄截断。
 */
export function hasPasteMarkers(text: string): boolean {
  return text.includes(BRACKETED_PASTE_START) || text.includes(BRACKETED_PASTE_END);
}

/**
 * 分段粘贴的键串序列：首段前补起标记、末段后补止标记 + CR——同一 paste 会话内
 * 多枪写入就是续排，宿主看到的仍是一次粘贴（折叠成一个 paste 块）。
 */
export function pasteKeyChunks(chunks: readonly string[]): string[] {
  return chunks.map(
    (c, i) =>
      (i === 0 ? BRACKETED_PASTE_START : '') +
      c +
      (i === chunks.length - 1 ? `${BRACKETED_PASTE_END}\r` : ''),
  );
}

/** 终端后端基类。模板方法定义骨架，子类只填候选与真正不同的流程。 */
export abstract class TerminalBackend {
  protected constructor(
    readonly preset: TerminalPreset,
    /** 能否反查已开窗口 / 可附加目标（默认否：不是每种终端都问得到）。 */
    readonly enumerable: boolean,
    protected readonly platform: NodeJS.Platform = process.platform,
    /** 能否给已开 pane 注入文本（prompt 层② send-text 兜底；默认否，不谎报）。 */
    readonly textAddressable: boolean = false,
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
   * default_prog，且 mux 在时会挂死出无窗僵尸而 trySpawn 假成功）。返回落子的
   * 起点（spawn 回执）；候选路径无回执 = null。
   */
  async run(dir: string, argv: string[]): Promise<LaunchOrigin | null> {
    await this.spawnFirst(
      this.candidates(dir, argv),
      `Terminal preset "${this.preset}" cannot run a command here — pick another preset in settings`,
    );
    return null;
  }

  /** 每目录已开终端数（单位 = 本后端的可见屏幕）；不支持的 preset 走这里（空表 = 角标不显示，不谎报）。 */
  async countWindows(_dirs: readonly string[]): Promise<Map<string, number>> {
    return new Map();
  }

  /** 可附加目标（窗口内的 tab）；不支持的 preset 走这里。includeForeign（opt-in）=
   *  别的项目的 tab 也进候选（跨项目分屏落点用），默认关、现状不变。 */
  async listTargets(_dir: string, _includeForeign = false): Promise<AttachTarget[]> {
    return [];
  }

  /** 定点附加（多终端弹窗选定的目标）；无通道的 preset 明确拒绝，不静默忽略。 */
  async runAt(_dir: string, _argv: string[], _targetId: string): Promise<LaunchOrigin | null> {
    throw new Error(
      `Terminal preset "${this.preset}" cannot attach to a chosen pane — pick wezterm, wt or Terminal.app in settings`,
    );
  }

  /** 唤出（切到前台）已开终端；无通道的 preset 明确拒绝。 */
  async focusTarget(_dir: string, _targetId: string): Promise<void> {
    throw new Error(
      `Terminal preset "${this.preset}" cannot bring an open terminal to the front — pick wezterm or wt in settings`,
    );
  }

  /**
   * 系统级隐藏/恢复该终端所在的 OS 窗口（SW_HIDE / SW_SHOW，比最小化深一级：
   * 任务栏与 Alt+Tab 都消失，进程照跑）；win32 之外的平台明确拒绝。
   * 同时回**目标所在窗口此刻的可见性**——状态探测与切换同源，前端不自己猜。
   */
  async setTargetVisibility(
    _dir: string,
    _targetId: string,
    _visibility: 'hide' | 'show',
  ): Promise<{ visibility: 'visible' | 'hidden' }> {
    throw new Error(
      `Terminal preset "${this.preset}" cannot hide or show windows on this platform`,
    );
  }

  /** 目标所在 OS 窗口此刻的可见性；拿不到（找不到窗/无通道）null——前端不摆态，不猜。 */
  async targetVisibility(_dir: string, _targetId: string): Promise<'visible' | 'hidden' | null> {
    return null;
  }

  /** prompt 层② 兜底：枚举可注入文本的 pane；无通道的后端空表（不谎报）。 */
  async listPromptPanes(): Promise<PromptPaneTarget[]> {
    return [];
  }

  /** 层② 定位：pane env → pane id；无定位能力的后端 null（回落标题+cwd，不猜）。 */
  async locatePane(_env: Record<string, string>): Promise<string | null> {
    return null;
  }

  /** 这个 pane id 是不是本后端发的（id 表示法归本后端）；默认不是，不抢别人的 id。 */
  ownsPaneId(_paneId: string): boolean {
    return false;
  }

  /**
   * 这个**可附加目标 id** 是不是本后端发的（多终端弹窗/显隐通道的 target）；
   * 缺省回落 pane id 形（多数后端两形同构），两形分家的后端（wezterm 三段 attach
   * vs 两段 prompt、wt 命名窗 vs pid）各自覆写。
   */
  ownsTargetId(_targetId: string): boolean {
    return false;
  }

  /** 会话 → 所在可见屏幕（会话列表分块）；无枚举能力的后端空表（不分组，不猜）。 */
  async locateScreens(
    _envs: Record<string, Record<string, string>>,
  ): Promise<Record<string, SessionTerminal | null>> {
    return {};
  }

  /**
   * prompt 层② 兜底：向枚举所得 pane 注入 prompt 原文并提交；无通道的后端明确拒绝。
   * 超长由后端自己分段（argv / env 各有上限），**分段对宿主仍是一次粘贴**——
   * 宿主折叠成的 paste 块与一次贴完无差。
   */
  async sendPromptText(_paneId: string, _text: string): Promise<void> {
    throw new Error(
      `Terminal preset "${this.preset}" cannot send text into an open pane — pick a preset with text injection in settings`,
    );
  }

  /** 阻塞问答作答：裸键序注入（模态框只吃键盘，不吃粘贴文本）；无通道的后端明确拒绝。 */
  async sendKeys(_paneId: string, _keys: string): Promise<void> {
    throw new Error(
      `Terminal preset "${this.preset}" cannot send keys to an open pane — pick a preset with key injection in settings`,
    );
  }

  /**
   * 读 pane 可视屏文本（旁路会话读屏通道用）；无读屏能力的后端 null（不谎报）。
   * 只回可视屏（scrollback 不取）——读屏消费方（侧问回答提取）只需要当下画面。
   */
  async getPaneText(_paneId: string): Promise<string | null> {
    return null;
  }

  /** 关掉这个 pane（会话生命周期收尾 / 项目关终端共用）；无通道的后端明确拒绝。 */
  async closePane(_paneId: string): Promise<void> {
    throw new Error(
      `Terminal preset "${this.preset}" cannot close an open pane — pick wezterm in settings`,
    );
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
export class CandidatesBackend extends TerminalBackend {
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
export const PRESET_CANDIDATES: Record<
  Exclude<TerminalPreset, 'auto' | 'custom' | 'wezterm'>,
  (dir: string, run: string[] | undefined, platform: NodeJS.Platform) => TerminalLaunch[]
> = {
  wt: (dir, run, platform) =>
    platform === 'win32'
      ? [
          {
            command: 'wt.exe',
            args: [
              // 命名窗口：wt 原生「在则进 tab、不在则开窗」= 复用项目窗口的落点语义。
              // -M（最大化）只对新建窗口生效：命名窗不在则开窗即最大化，在则进 tab
              // 窗口大小不动（2026-11-09 实测），不干扰用户手动调过的窗口。
              '-M',
              '-w',
              wtWindowSlug(dir),
              // 窗口标题跟随活动 tab（wt 无 set-window-title 通道）：tab 打上
              // 项目名，OS 窗口标题即刻可认（2026-11-12 实测），多窗不再全叫 powershell。
              ...(run ? ['new-tab', '--title', basename(dir)] : []),
              '-d',
              dir,
              ...(throughCmd(run, true) ?? []),
            ],
          },
        ]
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

/** custom：用户自撰命令模板（唯一需要读 settings 的后端）。 */
export class CustomBackend extends TerminalBackend {
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

/** Spawn detached and forget: the child outlives the daemon, its window is
 * its own, and I/O is dropped so a GUI process never blocks on pipes. */
export function trySpawn(launch: TerminalLaunch): Promise<boolean> {
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
