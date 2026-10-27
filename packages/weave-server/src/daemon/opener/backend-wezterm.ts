import { TERMINAL_LOCATOR_ENV } from '@weavecode/core';
import {
  MAX_PANES_PER_SCREEN,
  countWindowsByDir,
  listAttachTargets,
  openInWezterm,
  parseAttachTargetId,
  planWeztermGrid,
  runInWezterm,
  weztermCli,
  weztermGuiPidOf,
  weztermLiveMuxes,
  weztermMuxForId,
  weztermMuxKey,
  weztermPaneFromEnv,
  sessionScreensFromEnvs,
  weztermSpawnAndSend,
  weztermStepError,
  type AttachTarget,
  type SessionTerminal,
  type WeztermMux,
} from './wezterm-mux.js';
import { winRaiseTerminalWindow } from './win-raise.js';
import { throughCmd } from './shared.js';
import { TerminalBackend, type LaunchOrigin, type PromptPaneTarget, type TerminalLaunch } from './backend.js';

/**
 * 探活结果短缓存（10s）：角标的周期探测 + 开窗后对账 + GET 后台对账会在
 * 瞬间打多枪，缓存挡掉重复 spawn——一枪要对**每个存活 socket** spawn 一次
 * `wezterm cli list`（实测 wall ~180ms / CPU 62–125ms；残留幽灵 GUI 会把
 * socket 数放大）。**只给计数/分组用**（light 探测，workspace/idle 留空）：
 * runInWezterm 的落点决策必须看实时世界（缓存会让分屏落到刚关掉的 pane）。
 */
let muxCache: { at: number; muxes: WeztermMux[]; candidates: string[] } | null = null;

export async function weztermLiveMuxesCached(): Promise<{ muxes: WeztermMux[]; candidates: string[] }> {
  if (muxCache && Date.now() - muxCache.at < 10000) return muxCache;
  const { muxes, candidates } = await weztermLiveMuxes(true);
  muxCache = { at: Date.now(), muxes, candidates };
  return muxCache;
}

/**
 * wezterm 后端：唯一满能力后端（枚举/附加/唤出/注入/读屏/关 pane 全有）。
 * run 走 mux 通道（legacy `start -- PROG` 绕过 default_prog，且 mux 在时会挂死
 * 出无窗僵尸而 trySpawn 假成功）；窗口/pane 反查走 `cli list`；prompt 文本走
 * send-text。
 */
export class WeztermBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    super('wezterm', true, platform, true);
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    // `start` opens the GUI (or a new window in an existing one) and `--cwd`
    // applies to the first program it spawns. Cross-platform.
    return [
      {
        command: 'wezterm',
        args: ['start', '--cwd', dir, ...(throughCmd(run, this.platform === 'win32') ?? [])],
      },
    ];
  }

  /**
   * 开终端（不带命令）：有活实例 → 在实例里开新窗口落子（与会话列表的新终端
   * 同一条 mux 通道）；一个活实例都没有 → 回落 legacy `start` 起新 GUI（第一台
   * 终端总得有人开）。**不能只靠 `start`**：Windows 上它恒起一个新 GUI 进程、
   * 不并进已开实例（实测 `WEZTERM_UNIX_SOCKET` 指着活实例也照样新起），那是
   * 另一套窗口/实例，跟用户日常那个 wezterm 不是一回事。
   */
  override async open(dir: string): Promise<void> {
    if (await openInWezterm(dir)) return;
    await super.open(dir);
  }

  /**
   * 带命令开终端：有活实例 → mux 落子；**一个活实例都没有 → 回落 legacy `start`**
   * （与 `open` 同一条回落）——那是「用户此刻还没开 wezterm」的常态，不是错误：
   * `start --cwd dir <cmd>` 起新 GUI 并把命令跑在里面。原先这里一律 400
   * 「wezterm mux undiscoverable — is wezterm running?」，用户点「打开终端」得到的
   * 却是一条报错;「`start` 在 mux 在时会挂死出无窗僵尸」那条只对活实例成立。
   */
  override async run(dir: string, argv: string[]): Promise<LaunchOrigin | null> {
    const origin = await runInWezterm(dir, argv);
    if (origin) return origin;
    return super.run(dir, argv);
  }

  override async countWindows(dirs: readonly string[]): Promise<Map<string, number>> {
    if (dirs.length === 0) return new Map();
    const { muxes } = await weztermLiveMuxesCached();
    if (muxes.length === 0) return new Map(dirs.map((dir) => [dir, 0]));
    return countWindowsByDir(
      dirs,
      muxes.flatMap((mux) =>
        mux.panes.map((pane) => ({
          muxKey: mux.socket,
          windowId: pane.windowId,
          tabId: pane.tabId,
          cwd: pane.cwd,
        })),
      ),
    );
  }

  override listTargets(dir: string): Promise<AttachTarget[]> {
    return listAttachTargets(dir, this.platform);
  }

  override runAt(dir: string, argv: string[], targetId: string): Promise<LaunchOrigin | null> {
    return runInWeztermAt(dir, argv, targetId, this.platform);
  }

  /** 唤出两步：`activate-pane` 只切 mux 内部的焦点（实测不抬 OS 窗口、不解最小化），
   *  Windows 上还得在那个 GUI 进程的窗口里按标题认出来抬（OS 窗口标题 = 该窗口活动
   *  pane 的标题）。 */
  override async focusTarget(_dir: string, targetId: string): Promise<void> {
    const parsed = parseAttachTargetId(targetId);
    if (!parsed) throw new Error(`Invalid terminal target "${targetId}"`);
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) throw new Error('wezterm instance is gone — cannot bring the terminal to the front');
    const pane = mux.panes.find(
      (p) => p.windowId === parsed.windowId && p.tabId === parsed.tabId,
    );
    if (!pane) throw new Error('That terminal is gone — reopen the list');
    const args = ['cli', 'activate-pane', '--pane-id', String(pane.paneId)];
    const res = await weztermCli(args, mux.socket);
    if (!res?.ok) throw new Error(weztermStepError(args, mux.socket, res));
    if (this.platform !== 'win32') return;
    // activate 之后的标题才是 OS 窗口标题；目标 pane 的标题最可信，同窗口其它 pane
    // 次之（OS 标题可能停在别的 tab 上一次上报的那一帧）。
    const after = (await weztermMuxForId(parsed.muxKey))?.panes ?? mux.panes;
    const fresh = after.find((p) => p.paneId === pane.paneId) ?? pane;
    const titles = [
      fresh.title,
      ...after.filter((p) => p.windowId === parsed.windowId).map((p) => p.title),
    ].filter((t): t is string => !!t);
    await winRaiseTerminalWindow({
      guiPid: weztermGuiPidOf(mux.socket) ?? undefined,
      titles,
    });
  }

  /** prompt 层②：跨 mux 摊平全部 pane（实时枚举——落点决策必须看实时世界）。 */
  override async listPromptPanes(): Promise<PromptPaneTarget[]> {
    const { muxes } = await weztermLiveMuxes();
    return muxes.flatMap((mux) =>
      mux.panes.map((p) => ({
        id: `${weztermMuxKey(mux.socket)}:${p.paneId}`,
        title: p.title,
        cwd: p.cwd,
      })),
    );
  }

  /**
   * 层② 定位（hook 旁路上报的 pane env → prompt pane id）：pane 号 + mux socket
   * 归位到该实例的活动 pane。**含存在性校验**——socket 对不上活 mux、pane 已不在
   * 一律 null（调用方回落标题+cwd 启发式，宁可少答也不往别人的 pane 打键）。
   */
  override async locatePane(env: Record<string, string>): Promise<string | null> {
    // 两个定位键缺任一即判「不是 wezterm 会话」：先判再枚举，省一轮 spawn
    // （判据与 weztermPaneFromEnv 同一条件，只是挪到枚举之前）。
    const [paneKey, socketKey] = TERMINAL_LOCATOR_ENV.wezterm;
    const socket = env[socketKey];
    if (!env[paneKey] || !socket) return null;
    // 只探会话自己上报的那个 socket（绕过探活闸）：投递路径已知目标，全量扫一遍
    // both slow and cooled-down gates can misfire as "pane not found".
    const { muxes } = await weztermLiveMuxes(true, socket);
    return weztermPaneFromEnv(env, muxes, this.platform);
  }

  /** 本后端的 pane id 表示法 = `<mux 短哈希>:<paneId>`（见 parsePromptPaneId）。 */
  override ownsPaneId(paneId: string): boolean {
    return parsePromptPaneId(paneId) !== null;
  }

  /**
   * 会话 → 可见屏幕（会话列表分块）：与 locatePane 同一份旁路 env，但**吃 10s
   * 探活缓存**——分组是展示面，滞后十秒无感，而它由计数探活同一轮触发（共用一次
   * `cli list`），不为此多 spawn。
   */
  override async locateScreens(
    envs: Record<string, Record<string, string>>,
  ): Promise<Record<string, SessionTerminal | null>> {
    if (Object.keys(envs).length === 0) return {};
    const { muxes, candidates } = await weztermLiveMuxesCached();
    return sessionScreensFromEnvs(envs, muxes, candidates, this.platform);
  }

  /**
   * prompt 层② 注入（spike 字节级实测配方）：bracketed paste 打原文（内含
   * CR 是字面内容、不会被终端解释提交）→ `--no-paste` 补一记 CR 提交。mux
   * 实时重枚举定位，目标没了 throw（消息转可见失败，不静默丢）。
   */
  override async sendPromptText(paneId: string, text: string): Promise<void> {
    const parsed = parsePromptPaneId(paneId);
    if (!parsed) throw new Error(`Invalid prompt pane "${paneId}"`);
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) throw new Error('wezterm instance is gone — cannot deliver prompt');
    const pane = String(parsed.paneId);
    if (text) {
      const pasted = await weztermCli(['cli', 'send-text', '--pane-id', pane, text], mux.socket);
      if (!pasted?.ok) {
        throw new Error(
          weztermStepError(['cli', 'send-text', '--pane-id', pane, '<prompt text>'], mux.socket, pasted),
        );
      }
    }
    const submit = await weztermCli(['cli', 'send-text', '--pane-id', pane, '--no-paste', '\r'], mux.socket);
    if (!submit?.ok) {
      throw new Error(
        weztermStepError(['cli', 'send-text', '--pane-id', pane, '--no-paste', '<CR>'], mux.socket, submit),
      );
    }
  }

  /**
   * 裸键序进 pty（阻塞问答作答 / 会话中断的 ESC 共用这一条通道）：`--no-paste`
   * 绕过 bracketed paste，CR 字节即回车键、ESC 即中断。mux 定位口径与
   * sendPromptText 同。
   */
  override async sendKeys(paneId: string, keys: string): Promise<void> {
    const parsed = parsePromptPaneId(paneId);
    if (!parsed) throw new Error(`Invalid prompt pane "${paneId}"`);
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) throw new Error('wezterm instance is gone — cannot send keys to the pane');
    const pane = String(parsed.paneId);
    const sent = await weztermCli(
      ['cli', 'send-text', '--pane-id', pane, '--no-paste', keys],
      mux.socket,
    );
    if (!sent?.ok) {
      throw new Error(
        weztermStepError(['cli', 'send-text', '--pane-id', pane, '--no-paste', '<keys>'], mux.socket, sent),
      );
    }
  }

  /**
   * 关 pane（`wezterm cli kill-pane`）：宿主随 pane 一起退出——这就是「退出会话」
   * 的远程等价（harness 没有「请退出」这种信号，pane 没了它就没了）。mux 定位口径
   * 与 sendKeys 同；目标没了 throw，不静默假装关掉了。
   */
  override async closePane(paneId: string): Promise<void> {
    const parsed = parsePromptPaneId(paneId);
    if (!parsed) throw new Error(`Invalid prompt pane "${paneId}"`);
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) throw new Error('wezterm instance is gone — cannot close the pane');
    const pane = String(parsed.paneId);
    const killed = await weztermCli(['cli', 'kill-pane', '--pane-id', pane], mux.socket);
    if (!killed?.ok) {
      throw new Error(weztermStepError(['cli', 'kill-pane', '--pane-id', pane], mux.socket, killed));
    }
  }

  /** 读 pane 可视屏（`cli get-text`）：mux 定位口径与 sendKeys 同；失败 null（不猜）。 */
  override async getPaneText(paneId: string): Promise<string | null> {
    const parsed = parsePromptPaneId(paneId);
    if (!parsed) return null;
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) return null;
    const got = await weztermCli(
      ['cli', 'get-text', '--pane-id', String(parsed.paneId)],
      mux.socket,
    );
    return got?.ok ? got.out : null;
  }
}

/**
 * 定点附加（用户在会话终端弹窗里选的 tab）：实时重枚举定位目标，目标不在了
 * 就 throw——让前端报「该终端已关闭，请重选」，绝不静默换到别处（换了就是
 * 「我点了 A，命令进了 B」）；已长满同样明确拒绝（**不擅自另开窗口**，那也是
 * 换地方），前端同一事实置灰，用户自己决定开新终端还是挑别的。
 */
export async function runInWeztermAt(
  dir: string,
  argv: string[],
  targetId: string,
  platform: NodeJS.Platform = process.platform,
): Promise<LaunchOrigin | null> {
  const parsed = parseAttachTargetId(targetId);
  if (!parsed) throw new Error(`Invalid terminal target "${targetId}"`);
  const { muxes } = await weztermLiveMuxes();
  const mux = muxes.find((m) => weztermMuxKey(m.socket) === parsed.muxKey);
  if (!mux) throw new Error('wezterm instance is gone — pick a terminal again');
  const tabPanes = mux.panes.filter(
    (p) => p.windowId === parsed.windowId && p.tabId === parsed.tabId,
  );
  if (tabPanes.length === 0) throw new Error('terminal tab is gone — pick a terminal again');
  if (tabPanes.length >= MAX_PANES_PER_SCREEN) {
    throw new Error(
      `terminal is full (${MAX_PANES_PER_SCREEN} panes) — pick another terminal or open a new one`,
    );
  }
  return weztermSpawnAndSend(mux.socket, dir, argv, planWeztermGrid(tabPanes), mux.workspace, platform);
}

/** prompt pane id ↔ (mux, paneId) 解码；坏 id → null。 */
export function parsePromptPaneId(id: string): { muxKey: string; paneId: number } | null {
  const m = /^([0-9a-f]{8}):(\d+)$/.exec(id);
  if (!m) return null;
  return { muxKey: m[1]!, paneId: Number(m[2]) };
}
