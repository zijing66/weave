import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 系统关机哨兵托管：spawn `res/shutdown-sentinel/weave-shutdown-sentinel.exe`
 * （仅消息窗口的 .NET 小进程，tools/shutdown-sentinel/）。Windows 关机/注销会向
 * 每个顶层窗口广播 WM_QUERYENDSESSION——node 进程没有窗口收不到，SIGTERM 在
 * 关机路径上也不送达控制台进程；哨兵代收，stdout 打一行 "shutdown"，本模块
 * 读到即触发 daemon 的 shutdown 链（WAL checkpoint 并回主库再退）。
 *
 * 生命周期 = daemon 生命周期：daemon 退出 stdin EOF → 哨兵自退；哨兵崩了重启
 * 一次（与宠物窗同口径防抖）。哨兵与宠物窗互不相干——宠物窗关着它照样工作。
 */

const RES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../res/shutdown-sentinel',
);

/** 崩溃重启防抖窗：连续崩不再拉（坏环境反复 spawn 比没有更糟）。 */
const CRASH_RESTART_COOLDOWN_MS = 30_000;

let proc: ChildProcess | null = null;
let lastCrashAt: number | null = null;
let onShutdown: (() => void) | null = null;

export function sentinelExePath(): string {
  return path.join(RES_DIR, 'weave-shutdown-sentinel.exe');
}

export function canStartSentinel(): boolean {
  return process.platform === 'win32' && existsSync(sentinelExePath());
}

/**
 * 启动哨兵并注册关机回调（幂等：已在跑只换回调）。win32 且产物在位才真起；
 * 其他平台静默跳过（macOS/linux 有 SIGTERM 路径，不需要哨兵）。
 */
export function startShutdownSentinel(onShutdownCb: () => void): void {
  onShutdown = onShutdownCb;
  if (!canStartSentinel() || proc) return;
  try {
    proc = spawn(sentinelExePath(), [], {
      detached: false,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return;
  }
  proc.stdout?.on('data', (d: Buffer) => {
    if (d.toString().includes('shutdown')) onShutdown?.();
  });
  proc.on('exit', () => {
    const crashed = proc !== null;
    proc = null;
    if (!crashed) return;
    const now = Date.now();
    if (lastCrashAt !== null && now - lastCrashAt < CRASH_RESTART_COOLDOWN_MS) return;
    lastCrashAt = now;
    setTimeout(() => {
      if (onShutdown !== null && canStartSentinel()) startShutdownSentinel(onShutdown);
    }, 1_000).unref();
  });
}

/** daemon 关停钩子：stdin EOF 让哨兵自退。 */
export function stopShutdownSentinel(): void {
  const p = proc;
  proc = null; // 先摘：exit 回调看到非自身在位即不重启
  onShutdown = null;
  if (!p) return;
  try {
    p.stdin?.end();
  } catch {
    p.kill();
  }
}
