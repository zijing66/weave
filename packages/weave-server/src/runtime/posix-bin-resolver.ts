import { execFileSync } from 'node:child_process';

/**
 * POSIX 下解析 harness bin 的 spawn 形：PATH 上的 shebang 脚本/二进制都能被
 * execvp 直接跑（node-pty 走 execvp），不存在 Windows npm shim 那层问题——
 * `which` 命中即 direct；找不到回落 `/bin/sh -c`（让 shell 报「command not
 * found」给 TUI 看）。纯函数 + 调用方缓存。
 */
import type { ResolvedCommand } from './windows-bin-resolver.js';

type WhichFn = (bin: string) => string | null;

function defaultWhich(bin: string): string | null {
  try {
    const out = execFileSync('which', [bin], { encoding: 'utf8', timeout: 5_000 });
    return out.split('\n').find((l) => l.trim() !== '')?.trim() ?? null;
  } catch {
    return null;
  }
}

function shellQuote(s: string): string {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

/** bin + argv → 可交给 node-pty 的 spawn 形（POSIX）。which 可注入供测试。 */
export function resolvePosixCommand(
  bin: string,
  args: string[],
  which: WhichFn = defaultWhich,
): ResolvedCommand {
  if (bin.includes('/')) return { kind: 'direct', command: bin, args };
  const hit = which(bin);
  if (hit) return { kind: 'direct', command: hit, args };
  return { kind: 'shell', args: ['-c', [bin, ...args].map(shellQuote).join(' ')] };
}
