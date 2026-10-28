/**
 * Standalone daemon entry point, spawned by `weave daemon start`.
 * Runs the daemon in this (detached) process.
 *
 * 启动崩溃的 stderr 会跟着 stdio:ignore / 闪没的控制台一起消失（用户只见
 * 「已启动」却没有 daemon）——崩溃时落一份到 cache/logs/daemon-boot.log，
 * 那台机上才有得取证。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getLogsDir } from '../db/paths.js';
import { startDaemon } from './start.js';

try {
  startDaemon();
} catch (err) {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    const dir = getLogsDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, 'daemon-boot.log'),
      `[${new Date().toISOString()}] boot crash:\n${message}\n\n`,
      'utf8',
    );
  } catch {
    // 日志也写不进（盘满/权限）：没有更好的出口了，进程照常退出
  }
  process.exit(1);
}
