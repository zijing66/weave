import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { TERMINAL_LOCATOR_ENV } from '@weavecode/core';
import { getTerminalHwndLedgerPath } from '../../db/paths.js';
import { readJsonLedger, writeJsonLedger } from '../../db/json-ledger.js';
import type { LaunchOrigin } from '../opener.js';
import { joinCmd } from './shared.js';
import {
  weztermCli,
  weztermGuiPidOf,
  weztermLiveMuxes,
  weztermLiveMuxesCached,
  weztermStepError,
  probeGate,
  type WeztermMux,
} from './wezterm-probe.js';
import {
  winListOwnedHwnds,
  winMaximizeByHwnd,
  winMaximizeTerminalWindow,
  winSetVisibilityByHwnd,
} from './win-raise.js';

export interface WeztermPaneInfo {
  windowId: number;
  tabId: number;
  paneId: number;
  cwd: string | null;
  left: number;
  top: number;
  /** 该 pane 是否当前聚焦（多终端弹窗的排序信号之一）。 */
  isActive: boolean;
  /** pane 标题（claude 的 OSC 标题）——弹窗标签的素材，缺省回落窗口/Tab 号。 */
  title: string | null;
  /** OS 窗口级标题（wezterm 自报，同窗全体 pane 同值）。 */
  windowTitle: string | null;
}

export type WeztermDirection = 'right' | 'bottom';

/** 分屏落点：把哪个 pane 往哪个方向切。 */
export interface WeztermSplitTarget {
  paneId: number;
  direction: WeztermDirection;
}

/** 解析 `cli list --format json`；坏输入安全落空（上层转新窗口/回退）。 */
export function parseWeztermPanes(jsonText: string | null): WeztermPaneInfo[] {
  if (!jsonText) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const panes: WeztermPaneInfo[] = [];
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    if (typeof row?.pane_id !== 'number' || typeof row?.tab_id !== 'number') continue;
    panes.push({
      windowId: typeof row.window_id === 'number' ? row.window_id : 0,
      tabId: row.tab_id,
      paneId: row.pane_id,
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      left: typeof row.left_col === 'number' ? row.left_col : 0,
      top: typeof row.top_row === 'number' ? row.top_row : 0,
      isActive: row.is_active === true,
      title: typeof row.title === 'string' && row.title ? row.title : null,
      // OS 窗口级标题（wezterm 自报的窗口标题，全体 pane 同值）：标题认窗的
      // 窗口级信号——比「活动 pane 标题」稳一拍（pane 切换时 OS 标题停旧帧，
      // window_title 反映窗口自认的标题）。
      windowTitle:
        typeof row.window_title === 'string' && row.window_title ? row.window_title : null,
    });
  }
  return panes;
}

/** file:/// URL/本地路径 → 规范比较键：统一斜杠、去尾斜杠，win 下压大小写。 */
export function normalizeDirKey(raw: string | null, platform: NodeJS.Platform): string | null {
  if (!raw) return null;
  let s = raw;
  if (s.startsWith('file://')) {
    s = s.slice('file://'.length);
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
    // win：file:///D:/x → D:/x；posix：file:///tmp/x → /tmp/x
    if (platform === 'win32') s = s.replace(/^\//, '');
  }
  s = s.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s) return null;
  return platform === 'win32' ? s.toLowerCase() : s;
}

/** 跨 mux 摊平的 pane 行：计数只需 (mux 判别键, windowId, tabId, cwd)。 */
export interface WeztermMuxPane {
  muxKey: string;
  windowId: number;
  /** tab 号（可见屏幕）；不给 = 该后端没有 tab 概念，按窗口计。 */
  tabId?: number;
  cwd: string | null;
}

/**
 * 已打开终端计数，单位 = 各后端的**可见屏幕**（与会话终端选择弹窗的选项同一
 * 口径）：distinct (mux, windowId, tabId)、任一 pane cwd 命中即计——不是分屏
 * pane 数、也不是会话数。同一屏多个 pane 同属一目录只计 1。
 */
export function countWindowsByDir(
  dirs: readonly string[],
  panes: readonly WeztermMuxPane[],
  platform: NodeJS.Platform = process.platform,
): Map<string, number> {
  const keys = dirs.map((d) => normalizeDirKey(d, platform));
  const screens = dirs.map(() => new Set<string>());
  for (const pane of panes) {
    const cwdKey = normalizeDirKey(pane.cwd, platform);
    if (!cwdKey) continue;
    const screen = pane.tabId == null
      ? `${pane.muxKey}#${pane.windowId}`
      : `${pane.muxKey}#${pane.windowId}#${pane.tabId}`;
    for (let i = 0; i < dirs.length; i++) {
      if (keys[i] !== null && keys[i] === cwdKey) screens[i]!.add(screen);
    }
  }
  return new Map(dirs.map((d, i) => [d, screens[i]!.size]));
}

/**
 * 单个终端（一个**可见屏幕** = wezterm 的一个 tab）的 pane 上限：网格 1 2 /
 * 3 4 / 5 6 长满即停，再要新会话就只能新开窗口。各终端后端的「可见屏幕」定义
 * 不同——不支持分屏的后端（Terminal.app / 纯 shell preset）没有「挤在同一个
 * 可见屏幕里」这回事，不设限：每个会话各占一个窗口/tab。
 */
export const MAX_PANES_PER_SCREEN = 6;

/** 匹配 pane 最多、且还放得下的 tab 复用（平手取最早 tab）；满的 tab 跳过，
 *  于是「同一个可见屏幕长满了」自然落到新窗口。tab 内完整 pane 集合参与布局。 */
function pickWeztermTab(key: string, panes: WeztermPaneInfo[], platform: NodeJS.Platform) {
  const matches = new Map<number, number>();
  const totals = new Map<number, number>();
  for (const p of panes) {
    totals.set(p.tabId, (totals.get(p.tabId) ?? 0) + 1);
    if (normalizeDirKey(p.cwd, platform) === key) {
      matches.set(p.tabId, (matches.get(p.tabId) ?? 0) + 1);
    }
  }
  let bestTab: number | null = null;
  let bestCount = 0;
  for (const [tabId, count] of matches) {
    if ((totals.get(tabId) ?? 0) >= MAX_PANES_PER_SCREEN) continue;
    if (bestTab === null || count > bestCount || (count === bestCount && tabId < bestTab)) {
      bestTab = tabId;
      bestCount = count;
    }
  }
  return bestTab;
}

/**
 * 一个 tab 内的网格生长：网格按 1 2 / 3 4 / 5 6 生长 —— 首个分屏向右开列，
 * 之后矮列的底格向下延伸，等高取左列。坐标用 `cli list` 报的 left_col/top_row，
 * 用户手工增删 pane 后依旧推导得出，不落持久状态。长满 `MAX_PANES_PER_SCREEN`
 * 即无落点（null）——调用方据此新开窗口。
 */
export function planWeztermGrid(tabPanes: WeztermPaneInfo[]): WeztermSplitTarget | null {
  if (tabPanes.length === 0 || tabPanes.length >= MAX_PANES_PER_SCREEN) return null;
  if (tabPanes.length === 1) return { paneId: tabPanes[0]!.paneId, direction: 'right' };
  // 列 = left 值分组（升序）；单列 → 底格向右开第二列；多列 → 矮列底格向下
  const columns = new Map<number, WeztermPaneInfo[]>();
  for (const p of tabPanes) {
    const col = columns.get(p.left) ?? [];
    col.push(p);
    columns.set(p.left, col);
  }
  const ordered = [...columns.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, ps]) => [...ps].sort((a, b) => b.top - a.top));
  if (ordered.length === 1) {
    return { paneId: ordered[0]![0]!.paneId, direction: 'right' };
  }
  let target = ordered[0]!;
  for (const col of ordered) {
    if (col.length < target.length) target = col;
  }
  return { paneId: target[0]!.paneId, direction: 'bottom' };
}

/**
 * 同项目复用布局：挑「cwd 匹配该项目的 pane 最多、且有空间」的 tab（平手取最早
 * tab），再按 tab 内网格生长推导落点；匹配的 tab 全满 = 无落点（null → 新窗口）。
 */
export function planWeztermReuse(
  dir: string,
  panes: WeztermPaneInfo[],
  platform: NodeJS.Platform = process.platform,
): WeztermSplitTarget | null {
  const key = normalizeDirKey(dir, platform);
  if (!key) return null;
  const tabId = pickWeztermTab(key, panes, platform);
  if (tabId === null) return null;
  return planWeztermGrid(panes.filter((p) => p.tabId === tabId));
}

/** 新项目窗：最近活跃 client 的 workspace（拿不到就省略，进 mux 默认 workspace）。 */
export function planWeztermNewWindow(dir: string, workspace: string | null): string[] {
  const args = ['cli', 'spawn', '--new-window', '--cwd', dir];
  if (workspace) args.push('--workspace', workspace);
  return args;
}

/**
 * 会话终端可附加目标（多终端弹窗的选项）：一个终端窗口内的一个 tab（wezterm
 * 的 tab 含分屏 pane，即一个可见屏幕；Terminal.app 的 tab 即整面）。id 不透明、
 * 格式归各后端（wezterm `<mux 短哈希>:<windowId>:<tabId>`，Terminal.app
 * `terminal:<win>:<tab>`）。
 */
export interface AttachTarget {
  id: string;
  windowId: number;
  tabId: number;
  /** tab 聚焦 pane 的标题（claude 的 OSC 标题）；null 由前端回落「窗口 W · Tab T」文案。 */
  title: string | null;
  /** cwd 命中请求目录的 pane 数 / 该 tab 总 pane 数。 */
  matchCount: number;
  paneCount: number;
  /** 该 tab 内含聚焦 pane（窗口正看着它）。 */
  active: boolean;
  /** 这个可见屏幕已长满（pane 数到上限）：前端置灰，后端定点附加明确拒绝。 */
  full: boolean;
  /** 本卡片上 cwd 命中本项目的 pane（可关的那几个，表示法同 prompt pane id）；
   *  给不出 = 该后端关不了远程 pane，前端不摆关闭键。 */
  paneIds?: string[];
  /** 该 tab 聚焦 pane 的 cwd（opt-in 全量清单里识别别的项目用；缺省不给）。 */
  cwd?: string | null;
}

/**
 * mux socket → 不透明短标识（不回传本机路径）。**按比较键取哈希**：同一 socket
 * 有两种形态（wezterm 注进 pane env 的是混合分隔符，目录拼出来的是全反斜杠），
 * 裸串哈希会给同一实例发两个 id，投递时按 id 反查就落空。
 */
export function weztermMuxKey(socket: string): string {
  return createHash('sha256')
    .update(normalizeDirKey(socket, process.platform) ?? socket)
    .digest('hex')
    .slice(0, 8);
}

/**
 * 层② 定位（纯函数）：hook 上报的 pane env × 活 mux 表 → prompt pane id。
 * 键缺、socket 对不上活 mux、pane 号已不在 = null（宁可回落，不猜）。
 */
export function weztermPaneFromEnv(
  env: Record<string, string>,
  muxes: readonly { socket: string; panes: readonly { paneId: number }[] }[],
  platform: NodeJS.Platform,
): string | null {
  const [paneKey, socketKey] = TERMINAL_LOCATOR_ENV.wezterm;
  const pane = env[paneKey];
  const socket = env[socketKey];
  if (!pane || !socket) return null;
  const key = normalizeDirKey(socket, platform);
  const mux = muxes.find((m) => normalizeDirKey(m.socket, platform) === key);
  if (!mux || !mux.panes.some((p) => String(p.paneId) === pane)) return null;
  return `${weztermMuxKey(mux.socket)}:${pane}`;
}

/**
 * 会话所在的**可见屏幕**（终端里的一块屏 = wezterm 一个 tab）：会话列表按它分块
 * ——同一块屏上的会话聚在一起。id 不透明、格式归后端，只作分组键；窗口/Tab 号
 * 与同窗口 tab 数供块头文案（Tab 号只在同窗口多 tab 时有意义）。
 */
export interface SessionTerminal {
  id: string;
  windowId: number;
  tabId: number;
  tabsInWindow: number;
  /** 多 wezterm 实例并存时的实例序号（1 起，socket 候选序 = 新→旧）；单实例缺席
   *  ——块头「终端 0」在双实例下会重名，靠它区分。 */
  instance?: number;
}

/**
 * 会话 → 可见屏幕（纯函数）：hook 上报的 pane env × 活 mux 表 × 这轮的候选清单。
 * 三态各司其职——屏幕 = 反查到了；`null` = **确认不在了**（pane 已关 / 换了 mux /
 * 整个 GUI 没了）；**缺键 = 这轮没探到但实例还活着**（探活闸跳过、冷却、超时），
 * web 据此保留上次分块。探活闸的冷却窗与偶发失败都会让 mux 短暂不在枚举表里，
 * 把它们写成 null 就是「同一个终端的会话莫名掉出分块」的成因——分不清「没查」
 * 与「查了没有」。
 */
export function sessionScreensFromEnvs(
  envs: Record<string, Record<string, string>>,
  muxes: readonly { socket: string; panes: readonly WeztermPaneInfo[] }[],
  /** 这轮认定还活着的 socket（`weztermSocketCandidates` 口径 = 枚举成功 ∪ 探活
   *  失败/被闸跳过）：不在枚举表里却在这里面 = 只是这轮没探到。 */
  candidates: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Record<string, SessionTerminal | null> {
  const [paneKey, socketKey] = TERMINAL_LOCATOR_ENV.wezterm;
  const aliveKeys = new Set(candidates.map((s) => normalizeDirKey(s, platform)));
  // 多实例并存时块头「终端 0」会重名：socket 候选序（新→旧）派实例号。
  const instanceOf = new Map(
    candidates.map((socket, i) => [normalizeDirKey(socket, platform), i + 1] as const),
  );
  const multiInstance = muxes.length > 1;
  const out: Record<string, SessionTerminal | null> = {};
  for (const [sessionId, env] of Object.entries(envs)) {
    const paneId = env[paneKey];
    const socket = env[socketKey];
    const mux = socket
      ? muxes.find((m) => normalizeDirKey(m.socket, platform) === normalizeDirKey(socket, platform))
      : undefined;
    const pane = mux?.panes.find((p) => String(p.paneId) === paneId);
    if (mux) {
      out[sessionId] = pane
        ? {
            id: `${weztermMuxKey(mux.socket)}:${pane.windowId}:${pane.tabId}`,
            windowId: pane.windowId,
            tabId: pane.tabId,
            tabsInWindow: new Set(
              mux.panes.filter((p) => p.windowId === pane.windowId).map((p) => p.tabId),
            ).size,
            ...(multiInstance
              ? { instance: instanceOf.get(normalizeDirKey(mux.socket, platform)) }
              : {}),
          }
        : null;
      continue;
    }
    if (socket && aliveKeys.has(normalizeDirKey(socket, platform))) continue;
    out[sessionId] = null;
  }
  return out;
}

/** 目标 id ↔ (mux, window, tab) 解码；坏 id → null。 */
export function parseAttachTargetId(
  id: string,
): { muxKey: string; windowId: number; tabId: number } | null {
  const m = /^([0-9a-f]{8}):(\d+):(\d+)$/.exec(id);
  if (!m) return null;
  return { muxKey: m[1]!, windowId: Number(m[2]), tabId: Number(m[3]) };
}

/**
 * 目标列表（纯函数）：**只列本项目名下的 tab**（至少一个 pane 的 cwd 命中该目录）
 * ——别的项目的终端不进来，用户不必在一堆无关窗口里挑。空表语义 = 该项目没有
 * 终端开着（调用方据此直接开新窗，而不是弹一个空选择框）。
 *
 * 排序（最近活跃从上往下）：① 整个 wezterm 实例更近活跃（mux 的 client idle
 * 更小）在前；② 同实例内含聚焦 pane 的 tab 在前；③ 其余按 tabId 降序（tab 越晚
 * 创建越可能更近用过）。`cli list` 不报任何时间戳，这是可得信号下的最佳近似。
 *
 * `includeForeign`（opt-in）：非本项目 tab 也进候选（本项目的排前、附带 cwd）——
 * 跨项目分屏（演示双会话并排）的落点选择用；默认关，弹窗现状一概不变。
 */
export function attachTargetsFromMuxes(
  dir: string,
  muxes: readonly { socket: string; idleMs: number; panes: WeztermPaneInfo[] }[],
  platform: NodeJS.Platform = process.platform,
  includeForeign = false,
): AttachTarget[] {
  const key = normalizeDirKey(dir, platform);
  if (!key && !includeForeign) return [];
  const out: AttachTarget[] = [];
  for (const mux of [...muxes].sort((a, b) => a.idleMs - b.idleMs)) {
    const muxKey = weztermMuxKey(mux.socket);
    const byTarget = new Map<string, WeztermPaneInfo[]>();
    for (const p of mux.panes) {
      const k = `${p.windowId}:${p.tabId}`;
      const list = byTarget.get(k) ?? [];
      list.push(p);
      byTarget.set(k, list);
    }
    const rows: AttachTarget[] = [];
    for (const [k, panes] of byTarget) {
      const mine = key ? panes.filter((p) => normalizeDirKey(p.cwd, platform) === key) : [];
      if (mine.length === 0 && !includeForeign) continue; // 非本项目终端 → 不进候选
      const windowId = Number(k.slice(0, k.indexOf(':')));
      const tabId = Number(k.slice(k.indexOf(':') + 1));
      const focus = panes.find((p) => p.isActive) ?? panes[0]!;
      rows.push({
        id: `${muxKey}:${windowId}:${tabId}`,
        windowId,
        tabId,
        title: focus.title,
        matchCount: mine.length,
        paneCount: panes.length,
        active: panes.some((p) => p.isActive),
        full: panes.length >= MAX_PANES_PER_SCREEN,
        // 与 listProjectPanes 同一表示法（`<mux 短哈希>:<paneId>`）：关卡片时原样喂给
        // closeTerminalsIn，项目外的 pane 不动。
        ...(mine.length > 0 ? { paneIds: mine.map((p) => `${muxKey}:${p.paneId}`) } : {}),
        // opt-in 全量清单里带聚焦 pane 的 cwd：调用方识别别的项目用
        ...(includeForeign ? { cwd: focus.cwd } : {}),
      });
    }
    rows.sort((a, b) => Number(b.active) - Number(a.active) || b.tabId - a.tabId);
    out.push(...rows);
  }
  return out;
}

/**
 * 目标列表：默认吃 10s 探活缓存（30s 对账的可见性探测同用——每项目一枚实时
 * `cli list` 是整轮探测的延迟大头）；`realtime = true` 才实时枚举（用户手一划
 * 就可能关掉窗的弹窗路径）。
 */
export async function listAttachTargets(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  includeForeign = false,
  realtime = false,
): Promise<AttachTarget[]> {
  const { muxes } = realtime
    ? await weztermLiveMuxes()
    : await weztermLiveMuxesCached();
  return attachTargetsFromMuxes(dir, muxes, platform, includeForeign);
}

/**
 * 开终端（不带命令）的 mux 通道：有活实例 → 最活跃那个开新窗口；一个都没有
 * → null（调用方回落 legacy `start` 起新 GUI）。某步失败一律 throw——跟着
 * `run` 的口径，不静默落到另起一个 GUI 进程。成功回新 pane id（新窗最大化
 * 的收尾要用）。
 */
export async function openInWezterm(dir: string): Promise<string | null> {
  const { muxes } = await weztermLiveMuxes();
  if (muxes.length === 0) return null;
  const chosen = muxes.reduce((a, b) => (b.idleMs < a.idleMs ? b : a));
  return weztermSpawnPane(chosen.socket, dir, null, chosen.workspace);
}

/**
 * wezterm run 主通道：同项目 → 分屏复用（复用目标长满 = 没有可复用落点）；
 * 否则 → 最活跃 mux 开新窗口；命令一律 send-text。**一个活 mux 都没有 → 返回
 * null**（调用方回落 legacy `start` 起新 GUI——那是另一套流程，不在这条里猜）。
 * 有 mux 之后的任何失败（某步 rc≠0 / 超时）一律 throw：错误经路由 400 转 toast，
 * 绝不静默落到假成功的 legacy start。成功带回落子的起点 pane（spawn 回执），
 * paneEnvSource='launch' 的 harness 据此定位会话。
 */
export async function runInWezterm(dir: string, argv: string[]): Promise<LaunchOrigin | null> {
  const platform = process.platform;
  const { muxes } = await weztermLiveMuxes();
  if (muxes.length === 0) return null;
  // 同项目分屏：任一 mux 里 cwd 对上就在那里切；多 mux 命中取更活跃的那个
  let chosen: WeztermMux | null = null;
  let split: WeztermSplitTarget | null = null;
  for (const mux of muxes) {
    const s = planWeztermReuse(dir, mux.panes, platform);
    if (s && (chosen === null || mux.idleMs < chosen.idleMs)) {
      chosen = mux;
      split = s;
    }
  }
  // 无命中 → 在最近活跃（idle 最小）的 mux 开新窗
  chosen ??= muxes.reduce((a, b) => (b.idleMs < a.idleMs ? b : a));
  try {
    return await weztermSpawnAndSend(chosen.socket, dir, argv, split, chosen.workspace);
  } catch (err) {
    // 半死实例（进程活着但 mux 答不上话，实测 cli 挂 120s+、GUI 日志刷
    // os error 10054）会吃满 5s 超时——落点决策是按「探活通过」选的，超时
    // 说明探活的结论已过期。换下一个健康实例重试一次（分屏换新窗），再失败
    // 才把真相抛给上层（投递路径报「自动打开失败」，前端可手动重发）。
    const others = muxes.filter((m) => m.socket !== chosen!.socket);
    if (others.length === 0) throw err;
    const next = others.reduce((a, b) => (b.idleMs < a.idleMs ? b : a));
    probeGate.cooledDown(chosen.socket);
    return weztermSpawnAndSend(next.socket, dir, argv, null, next.workspace);
  }
}

/**
 * spawn 落 pane（分屏 / 新窗）：runInWezterm、开终端、定点附加共用的前半步。
 * split = null → 开新窗口。返回新 pane id；任何一步失败一律 throw。
 */
export async function weztermSpawnPane(
  socket: string,
  dir: string,
  split: WeztermSplitTarget | null,
  workspace: string | null,
): Promise<string> {
  // win32 新窗场景：spawn 前先拍 HWND 快照——spawn 后新增的那个就是刚开的窗，
  // 差集唯一命中即锁定（自动隐藏按 HWND 直打的依据，见 hideSpawnedWeztermWindow）。
  const hwndBefore =
    !split && process.platform === 'win32'
      ? await ownedHwndSnapshot(socket)
      : null;
  const spawnArgs = split
    ? ['cli', 'split-pane', '--pane-id', String(split.paneId), `--${split.direction}`, '--cwd', dir]
    : planWeztermNewWindow(dir, workspace);
  const spawned = await weztermCli(spawnArgs, socket);
  if (!spawned?.ok) throw new Error(weztermStepError(spawnArgs, socket, spawned));
  const paneId = spawned.out.trim();
  if (!/^\d+$/.test(paneId)) {
    throw new Error(`wezterm[${basename(socket)}] ${spawnArgs.join(' ')}: unexpected pane id "${paneId}"`);
  }
  noteSpawnedPane(socket, paneId, dir, hwndBefore);
  if (split) noteSplitPane(socket, paneId);
  return paneId;
}

/** spawn 差集认窗（win32 新窗）：pane → OS 窗口 HWND。标题认窗的病根是宿主 OSC
 *  持续改写窗口标题（spinner 前缀、会话名），认窗时对不上 = 自动隐藏时灵时不灵、
 *  角标隐藏小标时隐时现的真凶——差集在落子那一刻锁定 HWND，此后永不读标题。 */
const paneHwnds = new Map<string, number>();
/** mux window → OS 窗口 HWND（新窗记账时从 mux 枚举顺手登记 windowId；split 落进
 *  已有窗时按 windowId 命中窗级记账——同窗任一 pane 认过窗，整窗可用）。 */
const windowHwnds = new Map<string, number>();
/** cwd → 最近落子的 pane（自动隐藏的查询入口：三个 hide 调用点只有 cwd，/open
 *  的 openTerminal 不回 spawn 回执）。最新覆盖，超量裁旧。 */
const spawnedPaneByCwd = new Map<string, { socket: string; paneId: string; at: number }>();
const SPAWNED_CWD_MAX = 32;

/** 账面落盘（cache 档 JSON；记账即写、值没变不重写；失败静默——丢了退标题路径）。 */
let lastHwndLedgerJson = '';
function persistHwndLedger(): void {
  const next = JSON.stringify({
    paneHwnds: Object.fromEntries(paneHwnds),
    windowHwnds: Object.fromEntries(windowHwnds),
    spawnedPaneByCwd: Object.fromEntries(spawnedPaneByCwd),
  });
  if (next === lastHwndLedgerJson) return;
  lastHwndLedgerJson = next;
  writeJsonLedger(getTerminalHwndLedgerPath(), JSON.parse(next));
}

function loadHwndLedger(): void {
  const o = readJsonLedger<Record<string, unknown>>(getTerminalHwndLedgerPath());
  if (!o || typeof o !== 'object') return;
  const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
  if (o.paneHwnds && typeof o.paneHwnds === 'object') {
    for (const [k, v] of Object.entries(o.paneHwnds as Record<string, unknown>)) {
      if (int(v)) paneHwnds.set(k, v);
    }
  }
  if (o.windowHwnds && typeof o.windowHwnds === 'object') {
    for (const [k, v] of Object.entries(o.windowHwnds as Record<string, unknown>)) {
      if (int(v)) windowHwnds.set(k, v);
    }
  }
  if (o.spawnedPaneByCwd && typeof o.spawnedPaneByCwd === 'object') {
    for (const [k, v] of Object.entries(o.spawnedPaneByCwd as Record<string, unknown>)) {
      const e = v as { socket?: unknown; paneId?: unknown; at?: unknown } | null;
      if (e && typeof e.socket === 'string' && typeof e.paneId === 'string' && typeof e.at === 'number') {
        spawnedPaneByCwd.set(k, { socket: e.socket, paneId: e.paneId, at: e.at });
      }
    }
  }
}
loadHwndLedger();

function ownedHwndSnapshot(socket: string): Promise<number[]> {
  const guiPid = weztermGuiPidOf(socket);
  if (guiPid === null) return Promise.resolve([]);
  return winListOwnedHwnds(guiPid).catch(() => []);
}

function trimPaneHwnds(): void {
  if (paneHwnds.size > 128) {
    const first = paneHwnds.keys().next().value;
    if (first !== undefined) paneHwnds.delete(first);
  }
  if (windowHwnds.size > 128) {
    const first = windowHwnds.keys().next().value;
    if (first !== undefined) windowHwnds.delete(first);
  }
}

function noteSpawnedPane(
  socket: string,
  paneId: string,
  dir: string,
  hwndBefore: readonly number[] | null,
): void {
  const key = normalizeDirKey(dir, process.platform);
  if (key) {
    spawnedPaneByCwd.set(key, { socket, paneId, at: Date.now() });
    if (spawnedPaneByCwd.size > SPAWNED_CWD_MAX) {
      const oldest = [...spawnedPaneByCwd.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) spawnedPaneByCwd.delete(oldest[0]);
    }
    persistHwndLedger();
  }
  if (hwndBefore === null || hwndBefore.length === 0) return; // 非 win32 / split（不开新窗）/ 快照失败不认窗
  void (async () => {
    try {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const guiPid = weztermGuiPidOf(socket);
        if (guiPid === null) continue;
        const added = (await winListOwnedHwnds(guiPid)).filter((h) => !hwndBefore.includes(h));
        if (added.length === 1) {
          paneHwnds.set(`${socket}|${paneId}`, added[0]!);
          // 窗级记账：split 到这扇窗的后续 pane 直接命中（split 自己无差集可用）
          const listed = await weztermCli(['cli', 'list', '--format', 'json'], socket);
          const panes = parseWeztermPanes(listed?.ok ? listed.out : null);
          const windowId = panes.find((p) => String(p.paneId) === paneId)?.windowId;
          if (windowId !== undefined) windowHwnds.set(`${socket}|w${windowId}`, added[0]!);
          trimPaneHwnds();
          persistHwndLedger();
          return;
        }
        if (added.length > 1) return; // 歧义（用户同拍手开窗）不猜，退标题路径
      }
    } catch {
      // 认不出就退标题路径，尽力而为
    }
  })();
}

/** split 落子（复用窗）：新 pane 无差集（窗已存在），窗的 HWND 从窗级记账继承。 */
function noteSplitPane(socket: string, paneId: string): void {
  void (async () => {
    try {
      const listed = await weztermCli(['cli', 'list', '--format', 'json'], socket);
      const panes = parseWeztermPanes(listed?.ok ? listed.out : null);
      const windowId = panes.find((p) => String(p.paneId) === paneId)?.windowId;
      if (windowId === undefined) return;
      const hwnd = windowHwnds.get(`${socket}|w${windowId}`);
      if (hwnd !== undefined) {
        paneHwnds.set(`${socket}|${paneId}`, hwnd);
        trimPaneHwnds();
        persistHwndLedger();
      }
    } catch {
      // 继承不到就退标题路径
    }
  })();
}

/**
 * 自动隐藏的精确通道：按 cwd 找最近落子的 pane，用 spawn 差集认出的 HWND 直打
 * SW_HIDE——不枚举、不读标题、不受 cwd 上报延迟与 OSC 改写影响。返回 true =
 * 已藏掉（调用方到此为止）；false = 无精确通道（复用窗 / 认窗未成 / 非 wezterm
 * 落子），调用方退标题认窗的旧路径。轮询上限盖过认窗的差集窗口。
 */
export async function hideSpawnedWeztermWindow(dir: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const key = normalizeDirKey(dir, process.platform);
  const spawned = key ? spawnedPaneByCwd.get(key) : undefined;
  if (!spawned) return false;
  const deadline = Date.now() + 8_000;
  for (;;) {
    const hwnd = paneHwnds.get(`${spawned.socket}|${spawned.paneId}`);
    if (hwnd !== undefined) {
      await winSetVisibilityByHwnd(hwnd, 'hide');
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * spawn + send-text 投递：runInWezterm 与定点附加共用的尾部。任何一步失败一律
 * throw（路由 400 → 前端报因）。成功回起点 pane 的定位 env（键形出 core 表，
 * paneEnvSource='launch' 的 harness 据此反查这块屏）。
 */
export async function weztermSpawnAndSend(
  socket: string,
  dir: string,
  argv: string[],
  split: WeztermSplitTarget | null,
  workspace: string | null,
  platform: NodeJS.Platform = process.platform,
): Promise<LaunchOrigin> {
  const paneId = await weztermSpawnPane(socket, dir, split, workspace);
  await renameWeztermTab(socket, paneId, dir, !split);
  const sendArgs = [
    'cli',
    'send-text',
    '--pane-id',
    paneId,
    '--no-paste',
    `${joinCmd(argv, platform)}\r`,
  ];
  const sent = await weztermCli(sendArgs, socket);
  if (!sent?.ok) throw new Error(weztermStepError(sendArgs, socket, sent));
  if (!split && platform === 'win32') await maximizeWeztermWindow(socket, paneId);
  const [paneKey, socketKey] = TERMINAL_LOCATOR_ENV.wezterm;
  return { env: { [paneKey]: paneId, [socketKey]: socket } };
}

/**
 * spawn 后给新 pane 所在 tab（新窗时连 window 一起）命名 = 项目目录名。wezterm
 * pane 标题要等宿主 shell 的 OSC 序列上报，启动后有几秒空窗——期间 OS 窗口标题
 * 停在「未命名」，多个窗口并排时人眼与抬窗认窗都抓瞎。这里在落子那一刻就用
 * `cli set-tab-title` 先写上项目名（窗口标题跟随活动 tab），宿主第一帧 OSC 到达
 * 后自然覆盖，不冲突。失败尽力而为：命名是锦上添花，不影响落子。
 */
async function renameWeztermTab(
  socket: string,
  paneId: string,
  dir: string,
  newWindow: boolean,
): Promise<void> {
  const title = basename(dir);
  try {
    await weztermCli(['cli', 'set-tab-title', '--pane-id', paneId, title], socket);
    if (newWindow) await weztermCli(['cli', 'set-window-title', '--pane-id', paneId, title], socket);
  } catch {
    /* 尽力而为 */
  }
}

/**
 * 新窗最大化收尾（win32）：`gui-startup` 的 maximize 钩子只在 GUI 冷启动时触发、
 * 吃不到 `cli spawn --new-window`，只能事后按 HWND 补一刀。认窗 = 「OS 窗口标题 =
 * 该窗口某个 pane 的标题」（与 win-raise 同一关系），等 pane 标题上报（shell 起
 * 来要一两拍）→ 标题在该 GUI 进程的顶层窗口里唯一命中才 maximize；歧义/等不到
 * 静默放弃（最大化是锦上添花，不值得为它猜窗）。
 */
export async function maximizeWeztermWindow(socket: string, paneId: string): Promise<void> {
  try {
    const guiPid = weztermGuiPidOf(socket);
    if (guiPid === null) return;
    // 兜底快照先拍：spawn 已发生、新 HWND 出现得比 pane 标题上报早得多，
    // 一记快照 diff 命中就免去后面整段标题轮询（命中 = 竞态已被绕开）。
    const before = await winListOwnedHwnds(guiPid);
    let title: string | null = null;
    for (let i = 0; i < 10 && !title; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const panes = await weztermCli(['cli', 'list', '--format', 'json'], socket);
      const found = parseWeztermPanes(panes?.ok ? panes.out : null).find((p) => String(p.paneId) === paneId);
      title = found?.title ?? null;
    }
    if (title) {
      await winMaximizeTerminalWindow({ guiPid, titles: [title] });
      return;
    }
    // 标题等不到（上报延迟/格式异常）：按快照 diff 认新窗——新增的那个 HWND
    // 就是刚 spawn 的窗口，按 HWND 直打最大化，不再依赖标题时序。
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const added = (await winListOwnedHwnds(guiPid)).filter((h) => !before.includes(h));
      if (added.length === 1) {
        await winMaximizeByHwnd(added[0]!);
        return;
      }
    }
  } catch {
    // 尽力而为： maximize 失败不影响落子结果
  }
}
