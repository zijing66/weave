import { basename } from 'node:path';
import { spawn } from 'node:child_process';
import { pidAlive } from '../claude-liveness.js';
import { countWindowsByDir, normalizeDirKey } from './wezterm-mux.js';
import {
  parseWtPaneId,
  parseWtTargetId,
  wtHwndDiff,
  wtInjectKeys,
  invalidateWtPaneCache,
  wtOwnedHwnds,
  wtPanePidFromEnv,
  wtPanesAsWindows,
  wtPanesCached,
  wtPanesDetailed,
  wtPickRealWindow,
  wtWindowSlug,
} from './wt.js';
import {
  normTitle,
  winListOwnedWindows,
  winRaiseTerminalWindow,
  winSetVisibilityByHwnd,
  winWindowVisibility,
} from './win-raise.js';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START, throughCmd } from './shared.js';
import {
  PRESET_CANDIDATES,
  TerminalBackend,
  chunkByUtf8Bytes,
  hasPasteMarkers,
  pasteKeyChunks,
  type LaunchOrigin,
  type PromptPaneTarget,
  type TerminalLaunch,
} from './backend.js';

/** 单枪原文上限（原文 → base64 进环境块，整块 ~32k 字符，留出继承 env 的余量）。 */
const WT_PROMPT_CHUNK_BYTES = 12_288;
import type { AttachTarget } from './wezterm-mux.js';

/**
 * cwd → 最近落子的 OS 窗 HWND（自动隐藏的查询入口；三个 hide 调用点只有 cwd）。
 * 同 wezterm 的 spawnedPaneByCwd 同形：最新覆盖、超量裁旧。内存账——daemon 重启
 * 丢账只是退标题老路，不值得落盘。
 */
const spawnedHwndByCwd = new Map<string, { hwnd: number; at: number }>();
const SPAWNED_CWD_MAX = 32;

function noteWtSpawnedWindow(dir: string, hwnd: number): void {
  const key = normalizeDirKey(dir, 'win32');
  if (!key) return;
  spawnedHwndByCwd.set(key, { hwnd, at: Date.now() });
  if (spawnedHwndByCwd.size > SPAWNED_CWD_MAX) {
    const oldest = [...spawnedHwndByCwd.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) spawnedHwndByCwd.delete(oldest[0]);
  }
}

/**
 * Windows Terminal（win32）：无官方枚举 API，反查走进程树——每个 pane 的
 * shell 是 `WindowsTerminal.exe` 的直接子进程（`OpenConsole.exe` 是 ConPTY
 * 宿主、兄弟进程），shell 的 PEB cwd 即 pane 实时工作目录。pane 归属不到
 * 具体窗口（多窗口共进程、窗口名不外露），角标口径 = 本项目 pane 数（前端
 * 文案「N 个终端已打开」对窗口/pane 皆成立）。开窗/落点走 wt 命名窗口：
 * `-w <name>` 在则进 tab、不在则重建——天然就是「复用项目窗口」的落点语义，
 * 零簿记；定点附加 = 命名窗口里 split-pane（分屏）。
 */
export class WtBackend extends TerminalBackend {
  constructor(platform: NodeJS.Platform) {
    // wt 没有 per-pane 文本通道，但有 console 输入记录通道（见 sendKeys）。
    super('wt', platform === 'win32', platform, platform === 'win32');
  }

  candidates(dir: string, run?: string[]): TerminalLaunch[] {
    return PRESET_CANDIDATES.wt(dir, run, this.platform);
  }

  /**
   * 带命令落子（覆写）：**先拍 HWND 快照**再 spawn——现代 wt 是「多窗一进程」
   * （monarch，实测一个 WindowsTerminal.exe 进程名下挂多个顶层 OS 窗），标题认窗
   * 恒歧义，自动隐藏只能靠 spawn 前后差集认出刚开那个窗（HWND 直打，见
   * hideSpawnedWindow）。候选路径（wt 不可用回落 powershell/cmd）拿不到差集，
   * 让 scheduleHideWindow 退标题老路。
   */
  override async run(dir: string, argv: string[]): Promise<LaunchOrigin | null> {
    if (this.platform !== 'win32') return super.run(dir, argv);
    // 快照对象 = 当前全部 WT 宿主进程名下的窗（新窗可能落进任一实例）
    const wtProcs = (await wtPanesDetailed()).filter((r) => r.name === 'windowsterminal.exe');
    const before: number[] = [];
    for (const wt of wtProcs) before.push(...(await wtOwnedHwnds(wt.pid)));
    await this.spawnFirst(
      this.candidates(dir, argv),
      `Terminal preset "${this.preset}" cannot run a command here — pick another preset in settings`,
    );
    // spawn 后重拍：新增的 HWND 就是刚开的窗，记账给 hideSpawnedWindow 直打。
    // 窗口期短——宿主 OSC / shell 的 title 命令会很快改写窗标题——短轮询抢在改写前认。
    void (async () => {
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 2000));
          const after: number[] = [];
          const wtProcsAfter = (await wtPanesDetailed()).filter(
            (r) => r.name === 'windowsterminal.exe',
          );
          for (const wt of wtProcsAfter) after.push(...(await wtOwnedHwnds(wt.pid)));
          let hwnd = await wtPickRealWindow(wtHwndDiff(before, after));
          // 复用窗（命名窗已存在 → new-tab 进 tab、无新 OS 窗）：差集恒空。退一步按
          // 「new-tab 后新 tab 即活动 tab ⇒ OS 窗口标题 = 刚设的 tab 标题」认——
          // tab 标题带 spinner/状态前缀（`✳ wt-hide`），标题认取「剥前缀后等于
          // basename」的唯一命中（monarch 多窗下歧义即弃，宁缺毋错藏）。
          if (hwnd === null) {
            const want = normTitle(basename(dir));
            const titled: number[] = [];
            for (const wt of wtProcsAfter) {
              for (const w of await winListOwnedWindows(wt.pid)) {
                if (normTitle(w.title) === want) titled.push(w.hwnd);
              }
            }
            if (titled.length === 1) hwnd = titled[0]!;
          }
          if (hwnd !== null) {
            noteWtSpawnedWindow(dir, hwnd);
            return;
          }
        }
      } catch {
        // 差集认窗失败 = 退标题老路（scheduleHideWindow 的 setTimeout 分支）
      }
    })();
    return null;
  }

  override async countWindows(dirs: readonly string[]): Promise<Map<string, number>> {
    if (dirs.length === 0 || this.platform !== 'win32') return new Map(dirs.map((d) => [d, 0]));
    const panes = await wtPanesCached();
    if (panes.length === 0) return new Map(dirs.map((d) => [d, 0]));
    return countWindowsByDir(dirs, wtPanesAsWindows(panes));
  }

  /**
   * 目标列表 = 项目命名窗口一条（pane 反查只判「项目有没有 wt 终端」，归属
   * 不了用户手开的未命名窗口——那些列了也无处落子）。走缓存：wt 的落点
   * 自愈（命名窗口不在则重建），不像 wezterm 分屏会落进刚关掉的 pane。
   */
  override async listTargets(dir: string): Promise<AttachTarget[]> {
    if (this.platform !== 'win32') return [];
    const panes = await wtPanesCached();
    const count = countWindowsByDir([dir], wtPanesAsWindows(panes)).get(dir) ?? 0;
    if (count === 0) return [];
    return [
      {
        id: `wt:${wtWindowSlug(dir)}`,
        windowId: 0, // 无窗口号通道；title 非空，前端不回落窗口/Tab 文案
        tabId: 0,
        title: basename(dir),
        matchCount: count,
        paneCount: count,
        active: false, // pane 归属不了窗口，无从判定聚焦，不谎报
        full: false, // pane 数反查不到 → 定不了满，不谎报（可达性由落子自愈）
      },
    ];
  }

  /** 定点附加：命名窗口里分屏跑命令；窗口已关则 wt 重建（原生语义，落点自愈）。 */
  override async runAt(dir: string, argv: string[], targetId: string): Promise<LaunchOrigin | null> {
    if (this.platform !== 'win32') {
      throw new Error(`Terminal preset "${this.preset}" is unavailable on this platform`);
    }
    if (!parseWtTargetId(targetId)) throw new Error(`Invalid terminal target "${targetId}"`);
    await this.spawnFirst(
      [
        {
          command: 'wt.exe',
          args: [
            '-w',
            wtWindowSlug(dir),
            'split-pane',
            '-d',
            dir,
            ...(throughCmd(argv, true) ?? []),
          ],
        },
      ],
      `Terminal preset "${this.preset}" is unavailable on this platform`,
    );
    return null;
  }

  /**
   * 唤出：wt 的 CLI 只有 stdin 通道、进程本身也拿不到窗口号，所以按「这个项目的
   * pane 进程」反查窗口——往上找到宿主 `WindowsTerminal.exe`（wt 一窗一进程），
   * 那个进程的顶层窗口就是要抬的那个；进程和窗口对不上就抛真相，不瞎抬。
   */
  override async focusTarget(dir: string, targetId: string): Promise<void> {
    if (!parseWtTargetId(targetId)) throw new Error(`Invalid terminal target "${targetId}"`);
    const pids = await this.projectPanePids(dir);
    await winRaiseTerminalWindow({ panePids: pids, exe: 'windowsterminal.exe' });
  }

  /** 本项目 pane 的 console 客户端 pid 表（唤出/隐藏/查可见性共用的认窗抓手）。 */
  private async projectPanePids(dir: string): Promise<readonly number[]> {
    const key = normalizeDirKey(dir, this.platform);
    const pids = (await wtPanesCached())
      .filter((p) => key !== null && normalizeDirKey(p.cwd, this.platform) === key)
      .map((p) => p.pid);
    if (!pids.length) throw new Error('That terminal is gone — reopen the list');
    return pids;
  }

  override async setTargetVisibility(
    dir: string,
    targetId: string,
    visibility: 'hide' | 'show',
  ): Promise<{ visibility: 'visible' | 'hidden' }> {
    if (this.platform !== 'win32') {
      throw new Error(`Terminal preset "${this.preset}" cannot hide or show windows on this platform`);
    }
    if (!parseWtTargetId(targetId)) throw new Error(`Invalid terminal target "${targetId}"`);
    const pids = await this.projectPanePids(dir);
    await winRaiseTerminalWindow({ panePids: pids, exe: 'windowsterminal.exe', visibility });
    const vis = await winWindowVisibility({ panePids: pids, exe: 'windowsterminal.exe' });
    return { visibility: vis ?? (visibility === 'hide' ? 'hidden' : 'visible') };
  }

  override async targetVisibility(dir: string, targetId: string): Promise<'visible' | 'hidden' | null> {
    if (this.platform !== 'win32' || !parseWtTargetId(targetId)) return null;
    const key = normalizeDirKey(dir, this.platform);
    const pids = (await wtPanesCached())
      .filter((p) => key !== null && normalizeDirKey(p.cwd, this.platform) === key)
      .map((p) => p.pid);
    if (!pids.length) return null;
    return winWindowVisibility({ panePids: pids, exe: 'windowsterminal.exe' });
  }

  /**
   * 层② 定位：会话自己上报的 `CLAUDE_PID` 就是那个 pane 的 console 客户端
   * （hook 是它的子进程，跑在同一个 ConPTY 里）。WT 没有 pane 号通道，故 pane
   * id = 该 pid；存在性校验 = pid 还活着（死了宁可 null，回落标题+cwd）。
   */
  override async locatePane(env: Record<string, string>): Promise<string | null> {
    const pid = wtPanePidFromEnv(env);
    if (pid == null || !pidAlive(pid)) return null;
    return `wt:${pid}`;
  }

  /** 本后端的 pane id 表示法 = `wt:<pid>`（见 parseWtPaneId）。 */
  override ownsPaneId(paneId: string): boolean {
    return parseWtPaneId(paneId) !== null;
  }

  /** 目标 id（命名窗形 `wt:weave-…`）归本后端；与 pane pid 形分家。 */
  override ownsTargetId(targetId: string): boolean {
    return parseWtTargetId(targetId) !== null;
  }

  /**
   * prompt 层② 注入：bracketed paste 打原文（内含 CR 是字面内容、不提交）→
   * 补一记 CR 提交。与 wezterm 那条通道同语义，只是键记录直写 console。
   * 键串走 env（base64 进环境块，整块上限 ~32k 字符）⇒ 超长按字节分块：
   * 首块带起标记、末块带止标记 + CR，同一 paste 会话内多枪就是续排。
   */
  override async sendPromptText(paneId: string, text: string): Promise<void> {
    const pid = parseWtPaneId(paneId);
    if (pid == null) throw new Error(`Invalid prompt pane "${paneId}"`);
    if (hasPasteMarkers(text)) {
      // 分段会提前闭合（见 hasPasteMarkers）：整段一枪，装不下就让通道如实失败
      await wtInjectKeys(pid, `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}\r`);
      return;
    }
    const chunks = chunkByUtf8Bytes(text, WT_PROMPT_CHUNK_BYTES);
    if (chunks.length === 0) {
      await wtInjectKeys(pid, `${BRACKETED_PASTE_START}${BRACKETED_PASTE_END}\r`);
      return;
    }
    for (const keys of pasteKeyChunks(chunks)) await wtInjectKeys(pid, keys);
  }

  /** 裸键序（阻塞问答作答 / 中断 ESC）：控制字符按真键记录下发（见 wtInjectKeys）。 */
  override async sendKeys(paneId: string, keys: string): Promise<void> {
    const pid = parseWtPaneId(paneId);
    if (pid == null) throw new Error(`Invalid prompt pane "${paneId}"`);
    await wtInjectKeys(pid, keys);
  }

  /**
   * prompt 层② 枚举：进程表即 pane 表。pid 就是 pane id（与 locatePane 同一
   * 表示法），cwd 来自 shell 链尾的 PEB；标题拿不到（wt 无通道）= null——
   * 层② 回落标题匹配时只剩 cwd 一条腿，枚举照常给全。
   */
  override async listPromptPanes(): Promise<PromptPaneTarget[]> {
    if (this.platform !== 'win32') return [];
    const panes = await wtPanesCached();
    return panes.map((p) => ({ id: `wt:${p.pid}`, title: null, cwd: p.cwd }));
  }

  /**
   * 关 pane（会话生命周期收尾 / 项目关终端）：对 pane 根进程**整树** taskkill。
   * **只杀 CLAUDE_PID 会留空 shell pane**（claude 死了 cmd 还在、pane 不关、cwd
   * 仍指项目根——实测 bswmanager 攒 4 个残留）；回溯到 WT 直接子进程再把整树收掉，
   * pane 才真消失。pane 已没了（pid 不在进程表）按成功收——收尾语义是「pane 关掉」，
   * 不是「杀一个正在跑的进程」。
   */
  override async closePane(paneId: string): Promise<void> {
    const pid = parseWtPaneId(paneId);
    if (pid == null) throw new Error(`Invalid prompt pane "${paneId}"`);
    const rows = await wtPanesDetailed();
    const paneRow = rows.find((r) => r.pid === pid);
    if (!paneRow) return; // pane 已没了：按成功收
    // 根 = 该进程向上第一个「WT 直接子进程」；pane pid 自己就是根时直接用
    const wtPids = new Set(rows.filter((r) => r.name === 'windowsterminal.exe').map((r) => r.pid));
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    let root = paneRow;
    for (let i = 0; i < 8 && root.parentPid !== 0 && !wtPids.has(root.parentPid); i++) {
      const parent = byPid.get(root.parentPid);
      if (!parent) break;
      root = parent;
    }
    // 根定了：/T 收整树、/F 强杀——pane 的 shell 树里可能有挂着的宿主进程（claude
    // 跑着长命令），优雅关不掉只会留下更多的残留 pane——这里是会话生命周期收尾。
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'taskkill',
        ['/PID', String(root.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      child.on('error', reject);
      child.on('close', (code) => {
        invalidateWtPaneCache();
        code === 0 ? resolve() : reject(new Error(`taskkill exited ${code}`));
      });
    });
  }

  /**
   * 自动隐藏精确通道（win32）：run() 落子时 HWND 差集认出的窗直打 SW_HIDE——
   * 不读标题。现代 wt「多窗一进程」下标题认窗恒歧义（实测一进程 4 顶层窗），
   * 这条是唯一可靠的自动隐藏路径。差集例程要两枪进程表（~3.4s×2），比 spawn
   * 慢一拍 ⇒ **带轮询等账**（同 wezterm 的 hideSpawnedWeztermWindow 形状）。
   * 返回 true = 已藏掉；false = 无账（回落路径的 spawn / 复用窗 / 等超时），
   * 调用方退标题认窗。
   */
  override async hideSpawnedWindow(dir: string): Promise<boolean> {
    if (this.platform !== 'win32') return false;
    const key = normalizeDirKey(dir, 'win32');
    if (!key) return false;
    const deadline = Date.now() + 12_000;
    for (;;) {
      const spawned = spawnedHwndByCwd.get(key);
      if (spawned) {
        try {
          await winSetVisibilityByHwnd(spawned.hwnd, 'hide');
          return true;
        } catch {
          // 窗已关 / 句柄失效：摘账退老路
          spawnedHwndByCwd.delete(key);
          return false;
        }
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
