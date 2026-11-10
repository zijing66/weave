import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LivenessSurface } from '../driver.js';

/**
 * claude 会话存活判定：claude 自己维护 `~/.claude/sessions/<pid>.json`
 * 注册表（会话活动期持续刷新，进程死即停），sessionId↔pid 零埋点可得。
 * 判据 = 注册表存在 + `kill(pid, 0)`。pid 复用的残留误差（claude 死后
 * pid 被别的进程复用 → 误判活）用注册表里的 procStart 复核需要
 * WMI/NAPI 取进程启动时间，开销不值——留作已知残差。
 *
 * **读挂 ≠ 没装**：`claudeLivenessById` 的结果带 `readable` 位——目录
 * readdir 失败（权限/占用/瞬时抖动）时兜底「查无登记 → 判死」整拍失效
 * （当未知），下一拍自愈；只有「目录读得到但确实查无此登记」才走兜底。
 * 没有这一位，一次读挂会让所有过豁免窗的 claude 会话同拍集体「已终止」
 * （2026-11-09 晚实机：过夜 TUI 全显已停止、进程从未退出）。
 */

/** 注册表一行（只取判活相关字段）。 */
export interface ClaudeSessionReg {
  pid: number;
  sessionId: string;
}

/** 解析一个登记文件；坏输入 null。 */
export function parseClaudeSessionReg(jsonText: string): ClaudeSessionReg | null {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const reg = raw as { pid?: unknown; sessionId?: unknown };
  if (typeof reg?.pid !== 'number' || !Number.isInteger(reg.pid) || reg.pid < 0) return null;
  if (typeof reg.sessionId !== 'string' || !reg.sessionId) return null;
  return { pid: reg.pid, sessionId: reg.sessionId };
}

/** signal 0 探活：ESRCH = 进程不在；EPERM 等 = 存在但无权，按活算。 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 新会话启动竞态豁免：lastSeen 在此窗口内且查无登记 → 当未知，不判死。 */
export const CLAUDE_REG_GRACE_MS = 90_000;

/**
 * 单条会话的 pidAlive 三态：
 * - 登记命中 → 直接是 kill(pid,0) 的结果（true/false）；
 * - 查无登记 + harness=claude + lastSeen 已过豁免窗 → false——claude 的登记
 *   文件随进程死被清（正常退出自清/崩溃后由后续启动 GC），旧会话查无登记
 *   即进程已死；豁免窗内不猜（新会话文件可能还没落盘）；
 * - **注册表这一拍读挂**（`readable:false`）→ 恒 null：兜底的前提是「确实读到了
 *   注册表且无此登记」，读挂时整拍不判，下一拍自愈；
 * - 「仅一条 SessionStart」的空壳行不判：/continue、compact 会各留一行
 *   幽灵会话（事件跟在新 id 后面流），判死会把活着的会谈错标 terminated；
 *   它们交给 SessionSweeper 清（宿主丢弃的见 shellDiscardedByHost，其余保活期后）；
 * - 其余（codex/未知 harness/新鲜会话）→ null，上游不判。
 */
export function pidAliveOf(
  row: {
    sessionId: string;
    harness?: string | null;
    lastSeenAt: string;
    lastEventType?: string | null;
    eventCount?: number;
  },
  liveness: Map<string, boolean> & { readable?: boolean },
  now: number = Date.now(),
): boolean | null {
  const registered = liveness.get(row.sessionId);
  if (registered !== undefined) return registered;
  if (liveness.readable === false) return null;
  if (row.harness !== 'claude') return null;
  if (row.lastEventType === 'SessionStart' && (row.eventCount ?? 0) <= 1) return null;
  const seen = Date.parse(row.lastSeenAt);
  if (!Number.isFinite(seen) || now - seen < CLAUDE_REG_GRACE_MS) return null;
  return false;
}

/** 带可读位的存活图：`readable:false` = 目录 readdir 失败（读挂，非「没装」）——
 *  消费方 `pidAliveOf` 据此把兜底判死整拍降级为未知。普通 Map 的子类，存量
 *  消费方（按 Map 用）不受影响。 */
export class LivenessMap extends Map<string, boolean> {
  constructor(
    entries?: readonly [string, boolean][],
    /** 注册表目录这一拍是否读成功；缺省 true（图本身可靠）。 */
    readonly readable: boolean = true,
  ) {
    super(entries);
  }
}

/**
 * sessionId → 是否活着 的映射。只覆盖注册表里有登记的（claude 会话）；
 * codex/旧会话/他机会话不进图——上游把「查不到」当未知，不许误判死。
 * 目录读不到分两种：路径不存在（claude 没装过）= 可靠空图；readdir 失败
 * （权限/占用/瞬时抖动）= `readable:false`，兜底判死整拍降级为未知。
 */
export function claudeLivenessById(dir: string | null = null): LivenessMap {
  const target = dir ?? defaultClaudeSessionsDir();
  if (!target) return new LivenessMap();
  let names: string[];
  try {
    names = readdirSync(target);
  } catch (e) {
    // ENOENT = 目录还没建（claude 没装/没跑过）——可靠空图，兜底照常
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new LivenessMap();
    return new LivenessMap([], false);
  }
  const map = new LivenessMap();
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let text: string;
    try {
      text = readFileSync(join(target, name), 'utf8');
    } catch {
      continue;
    }
    const reg = parseClaudeSessionReg(text);
    if (!reg) continue;
    map.set(reg.sessionId, pidAlive(reg.pid));
  }
  return map;
}

function defaultClaudeSessionsDir(): string | null {
  const home = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  return home ? join(home, '.claude', 'sessions') : null;
}

/**
 * claude 的存活面：注册表 + kill 0 全同步（零 spawn），`alive` 直接现算。
 * 只回注册表里有登记的条目——查无登记的 claude 会话走 `pidAliveOf` 的
 * 豁免窗三态（那是消费方的合成判据，surface 只答「登记怎么说」）。
 */
export const CLAUDE_LIVENESS: LivenessSurface = {
  harness: 'claude',
  async alive(ids) {
    const map = claudeLivenessById();
    if (map.readable === false) return map; // 读挂：整拍不判（空图会骗兜底判死）
    if (!ids) return map;
    const out = new LivenessMap();
    for (const id of ids) {
      const v = map.get(id);
      if (v !== undefined) out.set(id, v);
    }
    return out;
  },
};
