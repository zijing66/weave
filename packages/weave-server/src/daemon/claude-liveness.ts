import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * claude 会话存活判定：claude 自己维护 `~/.claude/sessions/<pid>.json`
 * 注册表（会话活动期持续刷新，进程死即停），sessionId↔pid 零埋点可得。
 * 判据 = 注册表存在 + `kill(pid, 0)`。pid 复用的残留误差（claude 死后
 * pid 被别的进程复用 → 误判活）用注册表里的 procStart 复核需要
 * WMI/NAPI 取进程启动时间，开销不值——留作已知残差。
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

function defaultClaudeSessionsDir(): string | null {
  const home = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  return home ? join(home, '.claude', 'sessions') : null;
}

/** 新会话启动竞态豁免：lastSeen 在此窗口内且查无登记 → 当未知，不判死。 */
export const CLAUDE_REG_GRACE_MS = 90_000;

/**
 * 单条会话的 pidAlive 三态：
 * - 登记命中 → 直接是 kill(pid,0) 的结果（true/false）；
 * - 查无登记 + harness=claude + lastSeen 已过豁免窗 → false——claude 的登记
 *   文件随进程死被清（正常退出自清/崩溃后由后续启动 GC），旧会话查无登记
 *   即进程已死；豁免窗内不猜（新会话文件可能还没落盘）；
 * - 「仅一条 SessionStart」的空壳行不判：/continue、compact 会各留一行
 *   幽灵会话（事件跟在新 id 后面流），判死会把活着的会谈错标 terminated；
 *   它们交给 SessionSweeper 清（宿主丢弃的见 shellDiscardedByClaude，其余保活期后）；
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
  liveness: Map<string, boolean>,
  now: number = Date.now(),
): boolean | null {
  const registered = liveness.get(row.sessionId);
  if (registered !== undefined) return registered;
  if (row.harness !== 'claude') return null;
  if (row.lastEventType === 'SessionStart' && (row.eventCount ?? 0) <= 1) return null;
  const seen = Date.parse(row.lastSeenAt);
  if (!Number.isFinite(seen) || now - seen < CLAUDE_REG_GRACE_MS) return null;
  return false;
}

/**
 * 空壳会话（仅一条 SessionStart）是否已被宿主整个丢弃：claude 一句没说就退出时会把
 * session id 连转录一起删——不发 SessionEnd、注册表自清。于是「查无登记 + 已过豁免窗」
 * 就是再没有进程会以这个 id 发事件的证据，不必等满 1 小时保活期（用户原话：claude 那边
 * 会话没了，weave 的会话列表却还留着）。
 * 与 pidAliveOf 的「空壳不判」不冲突：那是状态面不猜，这里只决定清扫时机。
 * 仍有登记的（活着的空闲会话 / 崩溃残留）一律不动，照旧走保活期。
 */
export function shellDiscardedByClaude(
  row: {
    sessionId: string;
    harness?: string | null;
    lastSeenAt: string;
    lastEventType?: string | null;
    eventCount?: number;
  },
  liveness: Map<string, boolean>,
  now: number = Date.now(),
): boolean {
  if (row.harness !== 'claude') return false;
  if (row.lastEventType !== 'SessionStart' || (row.eventCount ?? 0) > 1) return false;
  if (liveness.has(row.sessionId)) return false;
  const seen = Date.parse(row.lastSeenAt);
  return Number.isFinite(seen) && now - seen >= CLAUDE_REG_GRACE_MS;
}

/**
 * sessionId → 是否活着 的映射。只覆盖注册表里有登记的（claude 会话）；
 * codex/旧会话/他机会话不进图——上游把「查不到」当未知，不许误判死。
 * 目录读不到（claude 没装过）同样给空图。
 */
export function claudeLivenessById(dir: string | null = null): Map<string, boolean> {
  const target = dir ?? defaultClaudeSessionsDir();
  const map = new Map<string, boolean>();
  if (!target) return map;
  let names: string[];
  try {
    names = readdirSync(target);
  } catch {
    return map;
  }
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
