import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * claude peer 注册表（`~/.claude/sessions/<pid>.json`，会话活动期持续刷新、
 * 进程死即停）：prompt 中继的寻址面——SendMessage 按注册名寻址，查无登记
 * = 会话未开或已死。判活复用 server 的 claude-liveness（同源不同读：那是
 * sessionId→alive，这是 sessionId→name）。
 */

/** sessionId → 在册 peer 寻址名；null = 未登记（未开或已死）。dir 参数供测试注入。 */
export function resolveClaudePeer(
  sessionId: string,
  dir: string = join(homedir(), '.claude', 'sessions'),
): { name: string } | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const file of names) {
    if (!/^\d+\.json$/.test(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    const reg = raw as { sessionId?: unknown; name?: unknown };
    if (reg?.sessionId === sessionId && typeof reg.name === 'string' && reg.name) {
      return { name: reg.name };
    }
  }
  return null;
}
