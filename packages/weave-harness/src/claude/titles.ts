import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionTitleSurface } from '../driver.js';

/**
 * claude 会话标题**读**面：`~/.claude/sessions/<pid>.json` 注册表的 `name` 字段。
 * 该注册表由宿主持续刷新，`nameSource` 三态——`derived` = 宿主派生的默认名
 * （`<目录>-<后缀>`，如 `vxspace-a0`）、`user` = 用户在宿主里 /rename、
 * `hook` = weave 经 hook 响应下发的 sessionTitle。读不区分来源：没上报过
 * `session_title` 的会话，derived 名是宿主侧唯一可读的名字。
 * 写仍走 hook 回执管线（本面无 `setSessionTitle`）——注册表是宿主的盘，
 * 改它不改变宿主内存态。
 */

/** 一个登记文件里判题名需要的字段；坏输入 null。 */
interface TitleReg {
  sessionId: string;
  name: string | null;
}

/** 文件名 → 解析结果；mtime+size 不变就复用（hook 每条事件都会查一次）。 */
const regCache = new Map<string, { mtimeMs: number; size: number; reg: TitleReg }>();

function claudeSessionsDir(home?: string): string | null {
  const base = home ?? (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME);
  return base ? join(base, '.claude', 'sessions') : null;
}

function parseTitleReg(text: string): TitleReg | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const reg = raw as { sessionId?: unknown; name?: unknown };
  if (typeof reg?.sessionId !== 'string' || !reg.sessionId) return null;
  const name = typeof reg.name === 'string' && reg.name.trim() ? reg.name.trim() : null;
  return { sessionId: reg.sessionId, name };
}

/** 宿主侧当前名；查无登记/无名/目录缺失一律 null。同一会话多份登记取最新一份。 */
export function claudeSessionTitleOf(sessionId: string, home?: string): string | null {
  const dir = claudeSessionsDir(home);
  if (!dir) return null;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { mtimeMs: number; name: string } | null = null;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const full = join(dir, file);
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const cached = regCache.get(full);
    let reg: TitleReg | null;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      reg = cached.reg;
    } else {
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      reg = parseTitleReg(text);
      if (!reg) {
        regCache.delete(full);
        continue;
      }
      regCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, reg });
    }
    if (reg.sessionId !== sessionId || !reg.name) continue;
    if (!best || st.mtimeMs >= best.mtimeMs) best = { mtimeMs: st.mtimeMs, name: reg.name };
  }
  return best?.name ?? null;
}

export const CLAUDE_TITLES: SessionTitleSurface = {
  harness: 'claude',
  async sessionTitleOf(sessionId) {
    return claudeSessionTitleOf(sessionId);
  },
};
