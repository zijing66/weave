import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Windows 下解析 harness bin 的真实 spawn 形（PoC 定案：npm shim 不能被
 * CreateProcess 直接解析——`pty.spawn('claude')` error 2）。
 *
 * 解析链：裸 .exe 直接用；npm shim（.cmd/.ps1）读文本解析出真实 JS 入口用
 * `node <cli.js>` 跑（少一层 shell、拿真实 pid）；解析不出回落 `cmd /c`（PoC
 * 验证可行）。纯函数 + 调用方缓存。
 */

export type ResolvedCommand =
  | { kind: 'direct'; command: string; args: string[] }
  | { kind: 'node'; entry: string; args: string[] }
  | { kind: 'shell'; args: string[] };

/** `where <bin>` 的命中清单（PATH 上第一优先）；找不到 = null。 */
function whereHit(bin: string): string | null {
  try {
    const out = execFileSync('where', [bin], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    return out.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * 从 npm shim 文本里挖真实 JS 入口。`.cmd` 与 `.ps1` 的共同形态是结尾指向
 * `node(?) "<…>cli.js" %*`——取第一个 .js 路径字面量（相对路径按 shim 所在目录解）。
 */
export function shimEntryOf(shimPath: string): string | null {
  if (!existsSync(shimPath)) return null;
  const text = readFileSync(shimPath, 'utf8');
  const m = text.match(/"([^"\r\n]+\.js)"/) ?? text.match(/'([^'\r\n]+\.js)'/);
  if (!m?.[1]) return null;
  const entry = m[1];
  return /^[a-z]:[\\/]/i.test(entry) || entry.startsWith('\\\\') ? entry : resolveBeside(shimPath, entry);
}

function resolveBeside(shimPath: string, entry: string): string {
  if (entry.includes('%~dp0')) {
    // `%~dp0` = shim 所在目录（带尾分隔符）——替换后再判断
    const beside = shimPath.slice(0, shimPath.lastIndexOf('\\') + 1);
    const resolved = beside + entry.replace(/%~dp0\\?/i, '');
    return existsSync(resolved) ? resolved : entry;
  }
  const beside = shimPath.slice(0, shimPath.lastIndexOf('\\') + 1);
  const resolved = beside + entry.replace(/\//g, '\\');
  return existsSync(resolved) ? resolved : entry;
}

/** bin + argv → 可交给 node-pty 的 spawn 形。 */
export function resolveWindowsCommand(bin: string, args: string[]): ResolvedCommand {
  const hit = whereHit(bin);
  if (!hit) return { kind: 'shell', args: ['/c', bin, ...args] };
  if (hit.toLowerCase().endsWith('.exe')) return { kind: 'direct', command: hit, args };
  if (/\.(cmd|bat|ps1)$/i.test(hit)) {
    const entry = shimEntryOf(hit);
    if (entry) return { kind: 'node', entry, args };
  }
  return { kind: 'shell', args: ['/c', bin, ...args] };
}

/** ResolvedCommand → node-pty 的 (file, args)（`cmd.exe /c` 走 shell 形）。 */
export function ptySpawnOf(resolved: ResolvedCommand): { file: string; args: string[] } {
  switch (resolved.kind) {
    case 'direct':
      return { file: resolved.command, args: resolved.args };
    case 'node':
      return { file: process.execPath, args: [resolved.entry, ...resolved.args] };
    case 'shell':
      return { file: 'cmd.exe', args: resolved.args };
  }
}
