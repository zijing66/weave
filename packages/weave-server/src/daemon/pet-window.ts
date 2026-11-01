import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthService } from './dashboard-auth.js';
import { PET_SIZE_PRESETS, readDaemonSettingsSync } from './settings.js';

/**
 * 桌面宠物窗托管：spawn `res/pet-window/weave-pet-window.exe`（WebView2 壳，
 * 见 tools/pet-window/），会话 cookie 种进独立 profile——pet.html 与 dashboard
 * 同一条认证。生命周期 = daemon 生命周期（detached:false，daemon 退出统一回收，
 * 与中继同法）；崩溃自动重启一次（防抖计时器，连续崩不再拉）。
 */

const RES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../res/pet-window',
);

/** 崩溃重启的防抖窗：窗内第二次崩不再拉（坏环境反复弹窗比没有更糟）。 */
const CRASH_RESTART_COOLDOWN_MS = 30_000;

interface PetWindowState {
  proc: ChildProcess | null;
  /** 上次崩溃时刻（防抖）；null = 冷却窗外。 */
  lastCrashAt: number | null;
}

const state: PetWindowState = { proc: null, lastCrashAt: null };

/** exe 落点（发布产物随包分发；开发仓在 packages/weave-server/res/）。 */
export function petWindowExePath(): string {
  return path.join(RES_DIR, 'weave-pet-window.exe');
}

/** 当前是否具备拉起条件（Windows + 产物在位）。 */
export function canOpenPetWindow(): boolean {
  return process.platform === 'win32' && existsSync(petWindowExePath());
}

/**
 * 拉起宠物窗（幂等：已在跑就不动）。返回是否真的拉起了；不具备条件返回
 * false——调用方如实反馈，不静默。
 */
export function openPetWindow(opts: {
  baseUrl: string;
  auth: AuthService | null;
}): boolean {
  if (!canOpenPetWindow() || state.proc) return false;
  const settings = readDaemonSettingsSync().pet;
  if (!settings?.enabled) return false;

  const size = PET_SIZE_PRESETS[settings.size] ?? PET_SIZE_PRESETS.small;
  const pos = settings.pos;
  const args = [
    `${opts.baseUrl}/pet.html`,
    '--size', `${size.width}x${size.height}`,
    // 记忆位（上次拖到的屏幕坐标）；没记过交给 exe 落默认位（右下角）
    ...(pos ? ['--pos', `${pos.x},${pos.y}`] : []),
    ...(opts.auth ? ['--cookie', opts.auth.issueSession()] : []),
  ];

  let proc: ChildProcess;
  try {
    proc = spawn(petWindowExePath(), args, {
      detached: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return false;
  }
  state.proc = proc;

  proc.on('exit', () => {
    const crashed = state.proc === proc;
    state.proc = null;
    if (!crashed) return; // 我们主动 close 的（stdin 关闭），不重启
    // 崩溃重启一次：冷却窗内不重复拉（防坏环境无限弹）
    const now = Date.now();
    if (state.lastCrashAt !== null && now - state.lastCrashAt < CRASH_RESTART_COOLDOWN_MS) return;
    state.lastCrashAt = now;
    setTimeout(() => {
      const cur = readDaemonSettingsSync().pet;
      if (cur?.enabled) openPetWindow(opts);
    }, 1_000).unref();
  });

  return true;
}

/** 关闭宠物窗：stdin 发一行（exe 收到即优雅退出）。 */
export function closePetWindow(): void {
  const proc = state.proc;
  if (!proc) return;
  state.proc = null; // 先摘：exit 回调看到非自身在位即不重启
  try {
    proc.stdin?.end('close\n');
  } catch {
    proc.kill();
  }
}

/** daemon 关停钩子：宠物窗随 daemon 一起走。 */
export function shutdownPetWindow(): void {
  closePetWindow();
}
