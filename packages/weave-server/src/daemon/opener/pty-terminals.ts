import { captureCommand, normalizeDirKey } from './wezterm-mux.js';
import { joinCmd, quotePath } from './shared.js';
import type { AttachTarget } from './wezterm-mux.js';

// ---- Terminal.app 通道（macOS）：osascript 反查 + do script 落子 ----
//
// Terminal.app 无分屏，tab 即整面；AppleScript 的 `do script "…" in <窗口>`
// 在指定窗口开新 tab（`in` 缺省 = 新窗口）。反查走 tty 桥：tab 的 tty →
// `ps` 找该 tty 的进程树根（shell；被 exec 替换成 claude 时就是 claude 本身，
// cwd 口径不变）→ `lsof` 取根进程 cwd。daemon 控制 Terminal.app 需 macOS
// 自动化授权（TCC），未授权时 AppleEvent 失败 → 枚举空表/落子 false，不谎报。

/** Terminal.app 一个 tab（整面）：窗口/序号/tty + 窗口是否最前/tab 是否聚焦。 */
export interface TerminalAppSurface {
  /** AppleScript window id——会话期稳定，不受窗口顺序/焦点变化影响。 */
  windowId: number;
  /** 窗口内 tab 序号（1 起）。 */
  tabIndex: number;
  /** tty 设备路径（/dev/ttysNNN）——cwd 桥接键。 */
  tty: string;
  selected: boolean;
  frontmost: boolean;
  /** 根进程 cwd；取不到 = null（tab 在但不进任何目录匹配）。 */
  cwd: string | null;
}

/** 一次 osascript 拉全所有窗口的 tab 清单（Terminal 未运行 → 空串）。 */
const TERMINAL_APP_DUMP = [
  'if application "Terminal" is not running then return ""',
  'tell application "Terminal"',
  '  set out to ""',
  '  repeat with w in windows',
  '    set wid to id of w',
  '    set fm to frontmost of w as text',
  '    repeat with t in tabs of w',
  '      set out to out & wid & "\\t" & (index of t) & "\\t" & tty of t & "\\t" & (selected of t as text) & "\\t" & fm & linefeed',
  '    end repeat',
  '  end repeat',
  '  return out',
  'end tell',
].join('\n');

/** dump 文本 → surface 列表（cwd 另行桥接）；坏行跳过，不整体失败。 */
export function parseTerminalAppDump(text: string): Omit<TerminalAppSurface, 'cwd'>[] {
  const out: Omit<TerminalAppSurface, 'cwd'>[] = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split('\t');
    if (cols.length !== 5) continue;
    const windowId = Number(cols[0]);
    const tabIndex = Number(cols[1]);
    if (!Number.isInteger(windowId) || !Number.isInteger(tabIndex)) continue;
    out.push({
      windowId,
      tabIndex,
      tty: cols[2]!,
      selected: cols[3] === 'true',
      frontmost: cols[4] === 'true',
    });
  }
  return out;
}

/**
 * `ps -axo pid=,ppid=,tty=` → tty（ps 形如 ttys004，无 /dev/ 前缀）→ 进程树
 * 根 pid。根 = 父进程不在同一 tty 上的那个（shell 的父是 launchd，claude 的
 * 父是 shell）；被 exec 替换成 claude 时根就是 claude，cwd 口径不变。
 */
export function parsePsRootPids(psText: string): Map<string, number> {
  const pidsByTty = new Map<string, Set<number>>();
  const parentOf = new Map<number, number>();
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const tty = m[3]!;
    if (tty === '??') continue; // 无 tty 的进程不可能是终端 tab
    const set = pidsByTty.get(tty) ?? new Set<number>();
    set.add(pid);
    pidsByTty.set(tty, set);
    parentOf.set(pid, Number(m[2]));
  }
  const out = new Map<string, number>();
  for (const [tty, pids] of pidsByTty) {
    for (const pid of pids) {
      if (!pids.has(parentOf.get(pid) ?? -1)) {
        out.set(tty, pid);
        break;
      }
    }
  }
  return out;
}

/** `lsof -Fn` 输出 → pid → cwd（`p<pid>` 行后随 `n<路径>` 行）。 */
export function parseLsofCwds(lsofText: string): Map<number, string> {
  const out = new Map<number, string>();
  let currentPid = -1;
  for (const line of lsofText.split('\n')) {
    if (line.startsWith('p') && /^\d+$/.test(line.slice(1))) {
      currentPid = Number(line.slice(1));
    } else if (line.startsWith('n') && currentPid !== -1) {
      out.set(currentPid, line.slice(1));
      currentPid = -1;
    }
  }
  return out;
}

/** 实时枚举（不吃缓存——落点决策必须看实时世界，同 wezterm 口径）。 */
export async function listTerminalAppSurfaces(
  platform: NodeJS.Platform,
): Promise<TerminalAppSurface[]> {
  if (platform !== 'darwin') return []; // 通道只在 darwin 存在，别平台不试 osascript
  const dump = await captureCommand('osascript', ['-e', TERMINAL_APP_DUMP]);
  if (!dump?.ok) return [];
  const partial = parseTerminalAppDump(dump.out);
  if (partial.length === 0) return [];
  const ps = await captureCommand('ps', ['-axo', 'pid=,ppid=,tty=']);
  if (!ps?.ok) return partial.map((s) => ({ ...s, cwd: null }));
  const roots = parsePsRootPids(ps.out);
  const rootPids = [
    ...new Set(partial.map((s) => roots.get(s.tty.replace(/^\/dev\//, '')) ?? -1)),
  ].filter((pid) => pid !== -1);
  const lsof =
    rootPids.length > 0
      ? await captureCommand('lsof', ['-a', '-p', rootPids.join(','), '-d', 'cwd', '-Fn'])
      : null;
  const cwds = parseLsofCwds(lsof?.out ?? '');
  return partial.map((s) => ({
    ...s,
    cwd: cwds.get(roots.get(s.tty.replace(/^\/dev\//, '')) ?? -1) ?? null,
  }));
}

/** 探活结果短缓存（10s）：与 muxCache 同由——角标轮询每 30s 打多枪，一枪 =
 * osascript+ps+lsof 三个子进程。只给计数用。 */
let terminalAppCache: { at: number; surfaces: TerminalAppSurface[] } | null = null;

export async function terminalAppSurfacesCached(platform: NodeJS.Platform): Promise<TerminalAppSurface[]> {
  if (terminalAppCache && Date.now() - terminalAppCache.at < 10000) return terminalAppCache.surfaces;
  const surfaces = await listTerminalAppSurfaces(platform);
  terminalAppCache = { at: Date.now(), surfaces };
  return surfaces;
}

export function terminalAppTargetId(windowId: number, tabIndex: number): string {
  return `terminal:${windowId}:${tabIndex}`;
}

/** 目标 id ↔ (window, tab) 解码；坏 id → null。 */
export function parseTerminalAppTargetId(id: string): { windowId: number; tabIndex: number } | null {
  const m = /^terminal:(\d+):(\d+)$/.exec(id);
  if (!m) return null;
  return { windowId: Number(m[1]), tabIndex: Number(m[2]) };
}

export function terminalAppMatches(
  surfaces: readonly TerminalAppSurface[],
  dir: string,
  platform: NodeJS.Platform,
): TerminalAppSurface[] {
  const key = normalizeDirKey(dir, platform);
  if (!key) return [];
  return surfaces.filter((s) => s.cwd !== null && normalizeDirKey(s.cwd, platform) === key);
}

/**
 * 目标列表（纯函数）：只列本项目名下的 tab。排序（最近活跃从上往下）：
 * ① 最前窗口的 tab 在前（Terminal.app 无 mux idle 信号，frontmost 是最近
 * 活跃的最佳代理）；② 窗口内聚焦 tab 在前；③ 其余按 tabIndex 降序（越晚开
 * 越可能更近用过）。matchCount/paneCount 恒 1/1——一个 tab 就一个面。
 */
export function terminalAppTargets(
  dir: string,
  surfaces: readonly TerminalAppSurface[],
  platform: NodeJS.Platform = process.platform,
): AttachTarget[] {
  const matched = terminalAppMatches(surfaces, dir, platform);
  matched.sort(
    (a, b) =>
      Number(b.frontmost) - Number(a.frontmost) ||
      Number(b.selected) - Number(a.selected) ||
      b.tabIndex - a.tabIndex,
  );
  return matched.map((s) => ({
    id: terminalAppTargetId(s.windowId, s.tabIndex),
    windowId: s.windowId,
    tabId: s.tabIndex,
    title: null, // 取 tab 标题要另一次 AppleScript，不值：前端回落「窗口 W · Tab T」
    matchCount: 1,
    paneCount: 1,
    active: s.frontmost && s.selected,
    full: false, // 无分屏：一个会话一个 tab，没有挤满这回事
  }));
}

/** run 的落点：同项目已开的窗口（frontmost 优先，否则最大 windowId——越晚
 * 创建越可能更近用过）；tab 只用于定位窗口（do script 落点本来就是窗口级
 * 新 tab，tab 顺序变动无害）。没有 → null（走新窗）。 */
export function pickTerminalAppWindow(
  surfaces: readonly TerminalAppSurface[],
  dir: string,
  platform: NodeJS.Platform = process.platform,
): { windowId: number; tabIndex: number } | null {
  const matched = terminalAppMatches(surfaces, dir, platform);
  if (matched.length === 0) return null;
  matched.sort(
    (a, b) => Number(b.frontmost) - Number(a.frontmost) || b.windowId - a.windowId,
  );
  return { windowId: matched[0]!.windowId, tabIndex: matched[0]!.tabIndex };
}

/** 目标列表（实时枚举入口）。 */
export async function listTerminalAppTargets(dir: string, platform: NodeJS.Platform): Promise<AttachTarget[]> {
  return terminalAppTargets(dir, await listTerminalAppSurfaces(platform), platform);
}

/** 在指定窗口开新 tab 跑命令；false = AppleScript 失败（窗口没了/无授权）。 */
export async function doScriptInTerminalWindow(
  dir: string,
  argv: string[],
  windowId: number,
): Promise<boolean> {
  const shell = `cd ${quotePath(dir, 'darwin')} && ${joinCmd(argv, 'darwin')}`;
  const text = shell.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const r = await captureCommand('osascript', [
    '-e',
    `tell application "Terminal" to do script "${text}" in window id ${windowId}`,
  ]);
  return r?.ok === true;
}

