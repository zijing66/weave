import { TERMINAL_LOCATOR_ENV } from '@weavecode/core';
import { getTerminalVisLedgerPath } from '../../db/paths.js';
import { readJsonLedger, writeJsonLedger } from '../../db/json-ledger.js';
import {
  MAX_PANES_PER_SCREEN,
  countWindowsByDir,
  hideSpawnedWeztermWindow,
  listAttachTargets,
  maximizeWeztermWindow,
  openInWezterm,
  parseAttachTargetId,
  parseWeztermPanes,
  planWeztermGrid,
  runInWezterm,
  weztermMuxKey,
  weztermPaneFromEnv,
  sessionScreensFromEnvs,
  weztermSpawnAndSend,
  type AttachTarget,
  type SessionTerminal,
} from './wezterm-mux.js';
import {
  weztermCli,
  weztermGuiPidOf,
  weztermLiveMuxes,
  weztermLiveMuxesCached,
  weztermMuxForId,
  weztermSocketPathDead,
  weztermStepError,
  type WeztermMux,
} from './wezterm-probe.js';
import {
  matchWindowsToMuxIds,
  normTitle,
  winListOwnedWindows,
  winRaiseOnce,
  winRaiseTerminalWindow,
  winSetVisibilityByHwnd,
  winWindowVisibility,
} from './win-raise.js';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, throughCmd } from './shared.js';
import {
  TerminalBackend,
  chunkByUtf8Bytes,
  hasPasteMarkers,
  type LaunchOrigin,
  type PromptPaneTarget,
  type TerminalLaunch,
} from './backend.js';

/** 单枪原文上限（走 argv，命令行上限 ~32k）；按字节切，中文一字三字节。 */
const WEZTERM_PROMPT_CHUNK_BYTES = 16_384;

/**
 * send-text 超时自动补一枪（实测 5s 超时偶发命中：mux IPC 停顿可达秒级甚至几十秒、
 * 空闲 pane 也中——首枪超时通常只是连接没建起来、文本没写进去，重发不会重复注入；
 * rc≠0 不重试，那是明确的失败语义，交给上层报错）。
 */
async function retryOnTimeout(
  fire: () => ReturnType<typeof weztermCli>,
): Promise<ReturnType<typeof weztermCli>> {
  const first = await fire();
  if (first?.timedOut !== true) return first;
  return fire();
}

/**
 * wezterm 后端：唯一满能力后端（枚举/附加/唤出/注入/读屏/关 pane 全有）。
 * run 走 mux 通道（legacy `start -- PROG` 绕过 default_prog，且 mux 在时会挂死
 * 出无窗僵尸而 trySpawn 假成功）；窗口/pane 反查走 `cli list`；prompt 文本走
 * send-text。
 */
export class WeztermBackend extends TerminalBackend {
  /** `<muxKey>:<windowId>` → 上次已知可见性（切换回包、查询命中都记账）；对称残局
   *  （两窗同题）的互证信号——账面 hidden ↔ 实况隐藏窗。key 带 muxKey：多个 GUI
   *  实例的 windowId 各自从 0 编号，纯数字 key 跨实例互染（旧实例的 hidden 账被
   *  拿去证新实例的窗）。**落盘**（cache 档 JSON，原子写）：daemon 随时重启可恢复，
   *  不留内存孤账。 */
  private readonly visLedger: Map<string, 'visible' | 'hidden'>;

  constructor(platform: NodeJS.Platform) {
    super('wezterm', true, platform, true);
    this.visLedger = loadVisLedger();
  }

  /**
   * 记账即落盘（原子写；失败静默——账是消歧的增强信号，丢了退标题老路）。
   * 顺手淘汰已消失实例的 key：GUI 进程死了它的 windowId 空间整体作废，账面
   * 留着只会随实例换防越滚越多（探活用 light 缓存，不加 spawn）。
   */
  private async noteVisibility(muxKey: string, windowId: number, vis: 'visible' | 'hidden'): Promise<void> {
    const key = `${muxKey}:${windowId}`;
    if (this.visLedger.get(key) !== vis) this.visLedger.set(key, vis);
    try {
      const { muxes } = await weztermLiveMuxesCached();
      if (muxes.length > 0) {
        const live = new Set(muxes.map((m) => weztermMuxKey(m.socket)));
        for (const k of [...this.visLedger.keys()]) {
          if (!live.has(k.slice(0, k.indexOf(':')))) this.visLedger.delete(k);
        }
      }
    } catch {
      // 探活失败不淘汰（宁多勿误删）
    }
    writeJsonLedger(getTerminalVisLedgerPath(), Object.fromEntries(this.visLedger));
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
    const paneId = await openInWezterm(dir);
    if (paneId !== null) {
      const { muxes } = await weztermLiveMuxes(true);
      const mux = muxes[0];
      if (mux && this.platform === 'win32') await maximizeWeztermWindow(mux.socket, paneId);
      return;
    }
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

  override listTargets(dir: string, includeForeign = false, realtime = true): Promise<AttachTarget[]> {
    return listAttachTargets(dir, this.platform, includeForeign, realtime);
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
    await winRaiseTerminalWindow({
      guiPid: weztermGuiPidOf(mux.socket) ?? undefined,
      titles: await this.windowTitlesOf(parsed.muxKey, parsed.windowId, pane.paneId),
    });
  }

  /** 目标 tab 所在 OS 窗口的标题候选：目标 pane 的标题最可信，同窗口其它 pane 次之
   *  （OS 标题可能停在别的 tab 上一次上报的那一帧）。认窗（抬/隐/查）共用一份。 */
  private async windowTitlesOf(
    muxKey: string,
    windowId: number,
    paneId: number,
  ): Promise<string[]> {
    const after = (await weztermMuxForId(muxKey))?.panes ?? [];
    const fresh = after.find((p) => p.paneId === paneId);
    return [fresh?.title, ...after.filter((p) => p.windowId === windowId).map((p) => p.title)]
      .filter((t): t is string => !!t);
  }

  /**
   * 目标 mux windowId → OS 窗口 HWND：标题认窗歧义时的消歧层——guiPid 名下全部
   * 顶层窗与全部 mux 窗的 pane 标题集一一配对（OS 标题 = 活动 pane 标题，故配对
   * 必命中），唯一配对即 HWND。配不出 = null（退标题认窗老路）。
   */
  private async hwndOfWindow(mux: WeztermMux, windowId: number): Promise<number | null> {
    const resolved = await this.hwndAndVisOfWindow(mux, windowId);
    return resolved && 'hwnd' in resolved ? resolved.hwnd : null;
  }

  /**
   * hwndOfWindow 的完整形：配对成功回 `{hwnd}`；配对失败（多窗同题且互证不出）
   * 但**全部候选 OS 窗的实况可见性一致**时回 `{vis}`——答案与具体配对无关（两个
   * 同题 Claude Code 窗同隐同显是常态），按一致值答，不再让可见性查询陪葬于
   * 认窗歧义（实测成因：badge 把 null 当可见计，显隐账对不上）。全不一致 = null。
   */
  private async hwndAndVisOfWindow(
    mux: WeztermMux,
    windowId: number,
  ): Promise<{ hwnd: number } | { vis: 'visible' | 'hidden' } | null> {
    const guiPid = weztermGuiPidOf(mux.socket);
    if (guiPid === null) return null;
    const windows = await winListOwnedWindows(guiPid);
    const byId = new Map<number, readonly string[]>();
    for (const w of new Set(mux.panes.map((p) => p.windowId))) {
      byId.set(
        w,
        mux.panes
          .filter((p) => p.windowId === w)
          .flatMap((p) => [p.title ?? '', p.windowTitle ?? '']),
      );
    }
    // 对称残局的互证：OS 窗实况可见性现查（一次脚本全查完，不加 spawn 轮次）。
    // 只带本 mux 的账（windowId 是实例内编号，别的实例的同号账不参与互证）。
    const muxKey = weztermMuxKey(mux.socket);
    const muxVis = new Map<number, 'visible' | 'hidden'>();
    for (const [k, v] of this.visLedger) {
      const id = Number(k.slice(k.indexOf(':') + 1));
      if (k.startsWith(`${muxKey}:`) && Number.isInteger(id)) muxVis.set(id, v);
    }
    const hwndVis = new Map<number, 'visible' | 'hidden'>();
    if (muxVis.size > 0) {
      for (const w of windows) {
        const r = await winRaiseOnce({ hwnd: w.hwnd, visibility: 'query' }, []);
        const m = /vis\|(visible|hidden)/.exec(r.out);
        if (m) hwndVis.set(w.hwnd, m[1] as 'visible' | 'hidden');
      }
    }
    const pairing = matchWindowsToMuxIds(windows, byId, muxVis, (h) => hwndVis.get(h) ?? null);
    const hwnd = pairing.get(windowId);
    if (hwnd !== undefined) return { hwnd };
    // 配对失败：本窗的候选（标题命中且未被别的 mux 窗认走）实况一致 → 按一致值答。
    const titles = byId.get(windowId);
    if (!titles || titles.length === 0) return null;
    const normed = new Set(titles.map((t) => normTitle(t)));
    const paired = new Set(pairing.values());
    const cands = windows
      .filter((w) => normed.has(normTitle(w.title)) && !paired.has(w.hwnd))
      .map((w) => hwndVis.get(w.hwnd))
      .filter((v): v is 'visible' | 'hidden' => v !== undefined);
    if (cands.length === 0) return null;
    return cands.every((v) => v === cands[0]) ? { vis: cands[0]! } : null;
  }

  /**
   * 系统级隐藏/恢复（SW_HIDE / SW_SHOW）：优先 HWND 直打（标题认窗在多窗同题时
   * 恒歧义——两个 mux 窗的活动 pane 同题是常态），配不出 HWND 退标题认窗老路。
   * hide 前若窗口已最小化，SW_HIDE 照样生效；show 解隐藏同时解最小化。
   */
  override async setTargetVisibility(
    _dir: string,
    targetId: string,
    visibility: 'hide' | 'show',
  ): Promise<{ visibility: 'visible' | 'hidden' }> {
    const parsed = parseAttachTargetId(targetId);
    if (!parsed) throw new Error(`Invalid terminal target "${targetId}"`);
    if (this.platform !== 'win32') {
      throw new Error(`Terminal preset "${this.preset}" cannot hide or show windows on this platform`);
    }
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) throw new Error('wezterm instance is gone');
    const pane = mux.panes.find(
      (p) => p.windowId === parsed.windowId && p.tabId === parsed.tabId,
    );
    if (!pane) throw new Error('That terminal is gone — reopen the list');
    const guiPid = weztermGuiPidOf(mux.socket) ?? undefined;
    const titles = await this.windowTitlesOf(parsed.muxKey, parsed.windowId, pane.paneId);
    const hwnd = await this.hwndOfWindow(mux, parsed.windowId);
    if (hwnd !== null) {
      await winSetVisibilityByHwnd(hwnd, visibility);
    } else {
      await winRaiseTerminalWindow({ guiPid, titles, visibility });
    }
    // 切换后复读实况（hide 后 IsWindowVisible 即假），不回显意图。
    if (hwnd !== null) {
      const r = await winRaiseOnce({ hwnd, visibility: 'query' }, []);
      const m = /vis\|(visible|hidden)/.exec(r.out);
      if (m) {
        await this.noteVisibility(parsed.muxKey, parsed.windowId, m[1] as 'visible' | 'hidden');
        return { visibility: m[1] as 'visible' | 'hidden' };
      }
    }
    const vis = await winWindowVisibility({ guiPid, titles });
    await this.noteVisibility(
      parsed.muxKey,
      parsed.windowId,
      vis ?? (visibility === 'hide' ? 'hidden' : 'visible'),
    );
    return { visibility: vis ?? (visibility === 'hide' ? 'hidden' : 'visible') };
  }

  override async targetVisibility(_dir: string, targetId: string): Promise<'visible' | 'hidden' | null> {
    const parsed = parseAttachTargetId(targetId);
    if (!parsed || this.platform !== 'win32') return null;
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) return null;
    const pane = mux.panes.find(
      (p) => p.windowId === parsed.windowId && p.tabId === parsed.tabId,
    );
    if (!pane) return null;
    // HWND 配对可信时直查（多窗同题时标题认窗恒歧义 → null → 前端不摆态）；
    // 配对失败但候选窗实况一致（同题窗同隐同显）按一致值答，不让查询陪葬于歧义。
    const resolved = await this.hwndAndVisOfWindow(mux, parsed.windowId);
    if (resolved && 'hwnd' in resolved) {
      const r = await winRaiseOnce({ hwnd: resolved.hwnd, visibility: 'query' }, []);
      const m = /vis\|(visible|hidden)/.exec(r.out);
      if (m) {
        await this.noteVisibility(parsed.muxKey, parsed.windowId, m[1] as 'visible' | 'hidden');
        return m[1] as 'visible' | 'hidden';
      }
    }
    if (resolved && 'vis' in resolved) return resolved.vis;
    return winWindowVisibility({
      guiPid: weztermGuiPidOf(mux.socket) ?? undefined,
      titles: await this.windowTitlesOf(parsed.muxKey, parsed.windowId, pane.paneId),
    });
  }

  /** 自动隐藏精确通道（win32）：spawn 差集认出的 HWND 直打，不读标题。 */
  override hideSpawnedWindow(dir: string): Promise<boolean> {
    if (this.platform !== 'win32') return Promise.resolve(false);
    return hideSpawnedWeztermWindow(dir);
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
    // 死实例（GUI pid 没了 = 路径永久失效）直接判不中，交调用方回落标题+cwd——
    // force 探死 socket 是白等一枪 5s 超时（mux 迟滞窗里回落也被拖住，409 成因）。
    if (weztermSocketPathDead(socket)) return null;
    // 只探会话自己上报的那个 socket（绕过探活闸）：投递路径已知目标，全量扫一遍
    // both slow and cooled-down gates can misfire as "pane not found".
    const { muxes } = await weztermLiveMuxes(true, socket);
    return weztermPaneFromEnv(env, muxes, this.platform);
  }

  /** 本后端的 pane id 表示法 = `<mux 短哈希>:<paneId>`（见 parsePromptPaneId）。 */
  override ownsPaneId(paneId: string): boolean {
    return parsePromptPaneId(paneId) !== null;
  }

  /** 目标 id（attach 形三段 `<mux>:<win>:<tab>`）归本后端；与 prompt 两段形分家。 */
  override ownsTargetId(targetId: string): boolean {
    return parseAttachTargetId(targetId) !== null;
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
   *
   * 原文走 argv（命令行上限 ~32k），超长自己分段：手工补 paste 起止标记、
   * 8 段一枪逐段 `--no-paste` 发（直写 pty 不经 paste 包装、序列天然保序）。
   * 宿主看到的仍是一次粘贴（折叠成 paste 块）。任何一枪失败立即抛——半截
   * 正文进输入框比失败更糟。
   */
  override async sendPromptText(paneId: string, text: string): Promise<void> {
    const parsed = parsePromptPaneId(paneId);
    if (!parsed) throw new Error(`Invalid prompt pane "${paneId}"`);
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) throw new Error('wezterm instance is gone — cannot deliver prompt');
    const pane = String(parsed.paneId);
    const send = async (payload: string, noPaste: boolean) => {
      const args = ['cli', 'send-text', '--pane-id', pane, ...(noPaste ? ['--no-paste'] : []), payload];
      const r = await retryOnTimeout(() => weztermCli(args, mux.socket));
      if (!r?.ok) {
        const shown = ['cli', 'send-text', '--pane-id', pane, ...(noPaste ? ['--no-paste'] : []), '<prompt text>'];
        throw new Error(weztermStepError(shown, mux.socket, r));
      }
    };
    if (text) {
      if (!hasPasteMarkers(text) && Buffer.byteLength(text, 'utf8') > WEZTERM_PROMPT_CHUNK_BYTES) {
        await send(BRACKETED_PASTE_START, true);
        for (const chunk of chunkByUtf8Bytes(text, WEZTERM_PROMPT_CHUNK_BYTES)) {
          await send(chunk, true);
        }
        await send(BRACKETED_PASTE_END, true);
      } else {
        // 整段交给 wezterm 自己包 paste（标记落在正文里时也只有这一条路，见 hasPasteMarkers）
        await send(text, false);
      }
    }
    await send('\r', true);
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
    const sent = await retryOnTimeout(() =>
      weztermCli(['cli', 'send-text', '--pane-id', pane, '--no-paste', keys], mux.socket),
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
   * 超时 ≠ 失败（mux 迟滞实测可拖到分钟级、pane 早已关掉）：超时后复查一次枚举，
   * pane 真不在了按成功收；还在 = 真失败，如实 throw。
   */
  override async closePane(paneId: string): Promise<void> {
    const parsed = parsePromptPaneId(paneId);
    if (!parsed) throw new Error(`Invalid prompt pane "${paneId}"`);
    const mux = await weztermMuxForId(parsed.muxKey);
    if (!mux) throw new Error('wezterm instance is gone — cannot close the pane');
    const pane = String(parsed.paneId);
    const args = ['cli', 'kill-pane', '--pane-id', pane];
    const killed = await weztermCli(args, mux.socket);
    if (killed?.ok) return;
    if (killed?.timedOut) {
      const listed = await weztermCli(['cli', 'list', '--format', 'json'], mux.socket);
      const still = parseWeztermPanes(listed?.ok ? listed.out : null).some(
        (p) => String(p.paneId) === pane,
      );
      if (listed?.ok && !still) return; // pane 已没了 = 关成了（回执被迟滞截断）
    }
    throw new Error(weztermStepError(args, mux.socket, killed));
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

/** 可见性账面读盘（坏值/缺文件 = 空账；key = `<muxKey>:<windowId>`，windowId 从
 *  0 起编号——历史版的纯数字 key（跨实例互染）读不匹配即弃，靠重探重建）。 */
function loadVisLedger(): Map<string, 'visible' | 'hidden'> {
  const out = new Map<string, 'visible' | 'hidden'>();
  const raw = readJsonLedger<Record<string, unknown>>(getTerminalVisLedgerPath());
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const m = /^([0-9a-f]{8}):(\d+)$/.exec(k);
      if (m && (v === 'visible' || v === 'hidden')) {
        out.set(k, v);
      }
    }
  }
  return out;
}
