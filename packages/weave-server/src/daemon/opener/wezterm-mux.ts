import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { TERMINAL_LOCATOR_ENV } from '@weavecode/core';
import type { LaunchOrigin } from '../opener.js';
import { joinCmd } from './shared.js';

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
 */
export function attachTargetsFromMuxes(
  dir: string,
  muxes: readonly { socket: string; idleMs: number; panes: WeztermPaneInfo[] }[],
  platform: NodeJS.Platform = process.platform,
): AttachTarget[] {
  const key = normalizeDirKey(dir, platform);
  if (!key) return [];
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
      const mine = panes.filter((p) => normalizeDirKey(p.cwd, platform) === key);
      if (mine.length === 0) continue; // 非本项目终端 → 不进候选
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
        paneIds: mine.map((p) => `${muxKey}:${p.paneId}`),
      });
    }
    rows.sort((a, b) => Number(b.active) - Number(a.active) || b.tabId - a.tabId);
    out.push(...rows);
  }
  return out;
}

/** 目标列表（实时枚举，不吃探活缓存——用户手一划就可能关掉窗）。 */
export async function listAttachTargets(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<AttachTarget[]> {
  const { muxes } = await weztermLiveMuxes();
  return attachTargetsFromMuxes(dir, muxes, platform);
}

/** 活跃 client：workspace + idle 毫秒（idle 还用来在多个 mux 之间选最活跃的）。 */
interface WeztermActiveClient {
  workspace: string;
  idleMs: number;
}

/** list-clients JSON → idle 最小的 client；坏输入/无有效 client → null。 */
export function weztermActiveClient(jsonText: string | null): WeztermActiveClient | null {
  if (!jsonText) return null;
  let clients: unknown;
  try {
    clients = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!Array.isArray(clients)) return null;
  let best: WeztermActiveClient | null = null;
  for (const c of clients) {
    const client = c as { workspace?: unknown; idle_time?: { secs?: unknown; nanos?: unknown } };
    if (typeof client?.workspace !== 'string' || !client.workspace) continue;
    const idle = client.idle_time;
    const idleMs =
      (typeof idle?.secs === 'number' ? idle.secs * 1e3 : 0) +
      (typeof idle?.nanos === 'number' ? idle.nanos / 1e6 : 0);
    if (best === null || idleMs < best.idleMs) {
      best = { workspace: client.workspace, idleMs };
    }
  }
  return best;
}

/** list-clients JSON → 最近活跃（idle 最小）client 的 workspace；坏输入 null。 */
export function weztermActiveWorkspaceOf(jsonText: string | null): string | null {
  return weztermActiveClient(jsonText)?.workspace ?? null;
}

const CAPTURE_TIMEOUT_MS = 5000;

/** 捕获型子调用结果：ok=rc0 且未超时；out/err 供上层拼错误文案。 */
export interface CaptureResult {
  ok: boolean;
  out: string;
  err: string;
  timedOut: boolean;
}

/**
 * 捕获型子调用（与 fire-and-forget 的 trySpawn 相对）：null = 进程起不来
 * （ENOENT 等）；其余带 rc/stdout/stderr。daemon 侧查世界的通道都走它
 * （wezterm cli / osascript / ps / lsof / wt 进程表）。
 */
export function captureCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = CAPTURE_TIMEOUT_MS,
): Promise<CaptureResult | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, env: env ?? process.env });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (r: CaptureResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    // 计时到点即 resolve——kill 对卡死进程可能无效，不 resolve 会挂死；
    // 废料管+unref，免得杀不掉的孤儿子进程拖着 daemon 事件loop
    const timer = setTimeout(() => {
      child.stdout.destroy();
      child.stderr?.destroy();
      child.unref();
      child.kill();
      finish({ ok: false, out, err: err.trim(), timedOut: true });
    }, timeoutMs);
    timer.unref();
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      finish({ ok: code === 0, out, err: err.trim(), timedOut: false });
    });
  });
}

/**
 * wezterm cli 子调用：null = 进程起不来（ENOENT 等）；其余带 rc/stdout/stderr。
 * socket 非空时经 WEZTERM_UNIX_SOCKET 指定 mux——daemon 不在 pane 里，没有
 * wezterm 注入的这个 env，不显式点名就会去连默认 sock/残留 socket 而误判。
 *
 * 恒带 `--no-auto-start`：cli 缺省「连不上 socket 就原地拉起 wezterm-mux-server
 * --daemonize」——该进程永不退出、还继承调用方的 stdio 管道把探活挂到超时，对着
 * 陈旧/失联 socket 探一次就泄一个（实测攒过 16 个，复盘见 docs/DECISIONS.md）。
 * 带上后连不上是干净的 rc≠0，probeGate 据此判永久死。
 */
export function weztermCli(args: string[], socket: string): Promise<CaptureResult | null> {
  return captureCommand('wezterm', weztermCliArgs(args), { ...process.env, WEZTERM_UNIX_SOCKET: socket });
}

/** cli 子命令参数 → 补上 `--no-auto-start`（须落在 `cli` 与子命令之间）。 */
export function weztermCliArgs(args: readonly string[]): string[] {
  return args[0] === 'cli' ? ['cli', '--no-auto-start', ...args.slice(1)] : [...args];
}

/** cli 步骤失败的诊断文案：socket + 命令 + stderr/超时，经路由 400 → 前端 toast。 */
export function weztermStepError(args: string[], socket: string, r: CaptureResult | null): string {
  const cmd = `wezterm[${basename(socket)}] ${args.join(' ')}`;
  if (r === null) return `${cmd}: executable not found`;
  if (r.timedOut) return `${cmd}: timed out after ${CAPTURE_TIMEOUT_MS}ms`;
  return r.err ? `${cmd}: ${r.err}` : `${cmd}: exited with failure`;
}

/** gui-sock-<pid> 文件名自带 GUI 进程 pid，signal 0 探活。 */
function weztermPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `gui-sock-<pid>` 那个 pid 是否**真是它的 GUI**。pid 会被复用，`weztermPidAlive`
 * 只答「有进程占着这个号」——死 socket 因此能一直冒充活实例（实测 GUI 50172 死后，
 * daemon 仍每隔一分钟对着它的 socket spawn 一次 `wezterm cli`）。
 * 只在该 socket 探活已经失败后调用：这时多花一枪 tasklist 不算什么。
 */
export async function weztermGuiAlive(pid: number): Promise<boolean> {
  if (!weztermPidAlive(pid)) return false;
  if (process.platform !== 'win32') return true;
  const listed = await captureCommand(
    'tasklist',
    ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
    undefined,
    2000,
  );
  return listed?.ok === true && /wezterm-gui\.exe/i.test(listed.out);
}

/**
 * socket 路径 → 它绑定的 GUI 进程 pid（`gui-sock-<pid>`）；非该形态返回 null——
 * 判死无据时宁可只冷却，也不永久拉黑。
 */
export function weztermGuiPidOf(socket: string): number | null {
  const m = /gui-sock-(\d+)$/.exec(socket.replace(/\\/g, '/'));
  return m ? Number(m[1]) : null;
}

/** 目录下 pid 仍活的 gui-sock 完整路径（pid 大→小 ≈ 新→旧）；io 失败当空目录。
 * 排序不碰 stat：win 下 AF_UNIX socket 文件 statSync 一律 EACCES。 */
function weztermGuiSocksIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const live: { path: string; pid: number }[] = [];
  for (const name of names) {
    const m = /^gui-sock-(\d+)$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!weztermPidAlive(pid)) continue;
    live.push({ path: join(dir, name), pid });
  }
  return live.sort((a, b) => b.pid - a.pid).map((s) => s.path);
}

/**
 * socket 字符串 → 比较键。win 下 wezterm 注进 pane env 的路径是**混合分隔符**
 * （`D:\Users\x\.local/share/wezterm/gui-sock-<pid>`），而 join() 拼出候选时是
 * 全反斜杠——同一 socket 两种形态，裸 Set 去重失效会把同一 mux 记成两个候选，
 * 窗口计数按 (socket, windowId) 去重也随之翻倍。
 */
function socketCompareKey(path: string, platform: NodeJS.Platform): string {
  const s = path.replace(/\\/g, '/');
  return platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * 候选 mux socket：进程 env 显式指定的最优先（daemon 一般没有，pane 内才有），
 * 其次存活 GUI 的 gui-sock-*（新的在前 ≈ 最近开的 wezterm 实例）。
 * 跳过裸 `sock`：默认 socket 不按 GUI pid 命名、判活无据——历史教训是 cli 对它
 * 原地拉起幽灵 server 后 rc=0 返回空世界、假成功一轮接一轮（见 DECISIONS）；
 * wezterm 注进 pane env 的恒是 gui-sock-<pid>，跳过它不丢发现面。
 */
export function weztermSocketCandidates(platform: NodeJS.Platform): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (path: string): void => {
    const key = socketCompareKey(path, platform);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(path);
  };
  // env 那支与目录扫描同一条判据：`gui-sock-<pid>` 的 GUI 进程已死 = 这段路径永久
  // 失效。不过这一关，daemon 从旧 pane 继承来的死 socket 会一直留在候选里——探活闸
  // 挡不住 force（投递/作答按 mux 键点名时恒探它），实测每隔一分钟白 spawn 一次
  // `wezterm cli`。非 gui-sock 形态（自定义 socket）判死无据，照旧交给探活。
  const envSocket = process.env.WEZTERM_UNIX_SOCKET;
  if (envSocket) {
    const pid = weztermGuiPidOf(envSocket);
    if (pid === null || weztermPidAlive(pid)) push(envSocket);
  }
  const home = platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  if (home) weztermGuiSocksIn(join(home, '.local', 'share', 'wezterm')).forEach(push);
  if (platform !== 'win32' && process.env.XDG_RUNTIME_DIR) {
    weztermGuiSocksIn(join(process.env.XDG_RUNTIME_DIR, 'wezterm')).forEach(push);
  }
  return out;
}

/** 一个探活通过的 mux：socket + pane 世界 + 活跃 client（workspace 与 idle）。 */
export interface WeztermMux {
  socket: string;
  panes: WeztermPaneInfo[];
  workspace: string | null;
  idleMs: number;
}

/** 探活超时后回避多久（可能只是 GUI 忙，不是死了）。 */
const PROBE_TIMEOUT_COOLDOWN_MS = 60_000;

/**
 * 探活失败的 socket 记忆——避免对已知坏 socket 反复 spawn `wezterm cli`。
 *
 * 为什么需要：陈旧的 `gui-sock-<pid>` 不会自己消失（wezterm 退出不清理，实测
 * 攒到过 48 个），对它们反复 spawn 纯属浪费（`--no-auto-start` 后死 socket
 * 是快速 rc≠0，不再是当年「原地拉起幽灵 mux-server、探活 >250s 不返回」的
 * 自伤——复盘见 docs/DECISIONS.md）。
 *
 * 判据的分寸：socket 路径与 GUI 的 pid 绑定，**进程死则该路径永久失效**（新 GUI
 * 必然是新 pid → 新路径），所以「干净的非零退出 + 这个 GUI 进程真没了」可以永久
 * 记住；而**超时/起不来/进程还活着却答不上来只算可疑**（本机 GUI 常年在 4~6 核，
 * 5s 内答不上来是可能的），只短期回避，免得把活着的 GUI 误判死。
 */
export class SocketProbeGate {
  private readonly dead = new Set<string>();
  private readonly cooling = new Map<string, number>();

  /** 这一轮要不要探它。 */
  shouldProbe(socket: string, now: number = Date.now()): boolean {
    if (this.dead.has(socket)) return false;
    const until = this.cooling.get(socket);
    return until === undefined || now >= until;
  }

  /** 探活成功：它活着，清掉回避态。 */
  succeeded(socket: string): void {
    this.cooling.delete(socket);
  }

  /** 干净的非零退出（socket 层失败）→ 该路径永久失效。 */
  failed(socket: string): void {
    this.dead.add(socket);
    this.cooling.delete(socket);
  }

  /** 超时 / 可执行起不来 → 只回避一段时间。 */
  cooledDown(socket: string, now: number = Date.now()): void {
    if (this.dead.has(socket)) return;
    this.cooling.set(socket, now + PROBE_TIMEOUT_COOLDOWN_MS);
  }
}

/** 进程内的探活失败记忆（见 SocketProbeGate）。 */
export const probeGate = new SocketProbeGate();


/**
 * 逐候选探活（单次 5s 超时兜底挂死的 GUI）；返回活 mux 与候选清单（报错用）。
 * light = 只取计数要的字段（socket+panes）：跳过 `list-clients`（每 socket 省
 * 一半 spawn），workspace/idleMs 留空——仅供 `weztermLiveMuxesCached`（计数）用，
 * run/落点决策恒走全量。候选**并行**探：串行时 N 个 mux 的墙钟是 N×，
 * 事件循环饱和窗口里被排队放大成秒级。
 */
export async function weztermLiveMuxes(
  light = false,
  force: string | null = null,
): Promise<{ muxes: WeztermMux[]; candidates: string[] }> {
  const candidates = force ? [force] : weztermSocketCandidates(process.platform);
  const muxes = (
    await Promise.all(
      candidates.map(async (socket) => {
        // 已知坏的 socket 不再重探：省 spawn，半死的 GUI 也不必反复挂满 5s 超时。
        // force（投递路径已确定的那个 socket）不受闸约束：冷却期只为「扫全部候选」
        // 省 spawn，而投递一次只炸一发、且目标已知——让冷却挡住它 = 冷却窗口里
        // 所有会话的停止/作答全都 409（点了没反应）。
        if (!force && !probeGate.shouldProbe(socket)) return null;
        const listed = await weztermCli(['cli', 'list', '--format', 'json'], socket);
        if (!listed?.ok) {
          // 永久判死只认「这个 GUI 进程真没了」——路径与 GUI pid 绑定，pid 死则
          // 该路径永久失效（新 GUI 必然是新 pid → 新路径）。**不能用 existsSync**：
          // win 下 AF_UNIX socket 文件 statSync 一律 EACCES、existsSync 恒 false，
          // 一次偶发非零退出就会把活实例按到 daemon 重启为止（分块掉行、停止键
          // 全班失效的成因）。进程还在却退出非零 = GUI 忙 / 瞬时拒绝 → 只冷却。
          const guiPid = weztermGuiPidOf(socket);
          if (listed && !listed.timedOut && guiPid !== null && !(await weztermGuiAlive(guiPid))) {
            probeGate.failed(socket);
          } else probeGate.cooledDown(socket);
          return null;
        }
        probeGate.succeeded(socket);
        const panes = parseWeztermPanes(listed.out);
        if (light) return { socket, panes, workspace: null, idleMs: Number.POSITIVE_INFINITY } satisfies WeztermMux;
        const clients = await weztermCli(['cli', 'list-clients', '--format', 'json'], socket);
        const active = weztermActiveClient(clients?.ok ? clients.out : null);
        return {
          socket,
          panes,
          workspace: active?.workspace ?? null,
          idleMs: active?.idleMs ?? Number.POSITIVE_INFINITY,
        } satisfies WeztermMux;
      }),
    )
  ).filter((m): m is WeztermMux => m !== null);
  return { muxes, candidates };
}

/**
 * pane id 里的 mux 短标识 → 那个 mux。**只探它那一个 socket**（绕过探活闸）：
 * 击键/投递已知目标，全量扫是白花 spawn，且冷却期会把「实例还在」误判成
 * 「实例没了」→ 停止键静默失败。
 */
export async function weztermMuxForId(muxKey: string): Promise<WeztermMux | null> {
  const socket = weztermSocketCandidates(process.platform).find(
    (s) => weztermMuxKey(s) === muxKey,
  );
  if (!socket) return null;
  const { muxes } = await weztermLiveMuxes(true, socket);
  return muxes.find((m) => weztermMuxKey(m.socket) === muxKey) ?? null;
}

/**
 * 开终端（不带命令）的 mux 通道：有活实例 → 最活跃那个开新窗口；一个都没有
 * → false（调用方回落 legacy `start` 起新 GUI）。某步失败一律 throw——跟着
 * `run` 的口径，不静默落到另起一个 GUI 进程。
 */
export async function openInWezterm(dir: string): Promise<boolean> {
  const { muxes } = await weztermLiveMuxes();
  if (muxes.length === 0) return false;
  const chosen = muxes.reduce((a, b) => (b.idleMs < a.idleMs ? b : a));
  await weztermSpawnPane(chosen.socket, dir, null, chosen.workspace);
  return true;
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
  return weztermSpawnAndSend(chosen.socket, dir, argv, split, chosen.workspace);
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
  const spawnArgs = split
    ? ['cli', 'split-pane', '--pane-id', String(split.paneId), `--${split.direction}`, '--cwd', dir]
    : planWeztermNewWindow(dir, workspace);
  const spawned = await weztermCli(spawnArgs, socket);
  if (!spawned?.ok) throw new Error(weztermStepError(spawnArgs, socket, spawned));
  const paneId = spawned.out.trim();
  if (!/^\d+$/.test(paneId)) {
    throw new Error(`wezterm[${basename(socket)}] ${spawnArgs.join(' ')}: unexpected pane id "${paneId}"`);
  }
  return paneId;
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
  const [paneKey, socketKey] = TERMINAL_LOCATOR_ENV.wezterm;
  return { env: { [paneKey]: paneId, [socketKey]: socket } };
}
