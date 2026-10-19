import { spawn } from 'node:child_process';
import {
  DEFAULT_PORT,
  DAEMON_HOST,
  isPortFree,
  findFreePort,
  readDaemonState,
  writeDaemonState,
  clearDaemonState,
  resolveDaemonEntry,
  accessUrls,
} from '@weavecode/server';
import { logger } from '@weavecode/core';
import { t } from '../i18n/index.js';
import type { Command } from '../parser.js';

/** True when a weave daemon answers /health on `port`. */
export async function probeDaemon(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${DAEMON_HOST}:${port}/health`);
    if (!res.ok) return false;
    const data = (await res.json()) as { service?: string };
    return data.service === 'weave-daemon';
  } catch {
    return false;
  }
}

export interface DaemonHandle {
  port: number;
  /** False when an already-running daemon was reused. */
  started: boolean;
}

/**
 * 等守护进程真能应答。/health 是它起好的标志：`spawn` 返回的只是子进程，此刻
 * 它连模块都还没加载完——首启的初始密码标记文件、auth.json 都是启动过程中才写
 * 出的，早一步问就扑空（`weave dashboard` 因此首次运行默默不打印密码），紧接着
 * 的 HTTP 请求也会连不上（`weave chpass`）。超时就不再等，让后续请求照常报错。
 */
export async function waitForDaemon(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probeDaemon(port))) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/**
 * Windows 上把 daemon 交给 Job 外面的创建者（WMI）拉起，成功返回 true。
 *
 * 直接 `spawn` 的进程会继承调用方所在终端 tab 的 Job（Windows Terminal 给每个
 * pane 建的是 kill-on-close 的 Job），而 libuv 的 detached 并不能真的逃离不允许
 * breakaway 的 Job：关掉那个 tab，daemon 和它开出的每个终端一起被带走。WMI 由
 * WmiPrvSE 创建进程，创建者本身在 Job 外，继承链由此断开。
 */
async function spawnOutsideJob(exe: string, args: string[]): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script =
    "$ErrorActionPreference='Stop';" +
    '$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{' +
    `CommandLine=${literal([exe, ...args].map(quote).join(' '))};` +
    `CurrentDirectory=${literal(process.cwd())}};` +
    'if($r.ReturnValue -ne 0){exit 1}';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore',
    });
    ps.on('error', () => resolve(false));
    ps.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * Ensure a daemon is running and return how to reach it.
 *
 * Reuses a live daemon (probing the default port, then whatever the state file
 * records) instead of spawning a second one — the daemon is single-instance by
 * design, and a second copy would fight over the SQLite file.
 */
export async function ensureDaemonRunning(): Promise<DaemonHandle> {
  // Reuse a live daemon, preferring the state file's port.
  const existing = readDaemonState();
  if (existing && (await probeDaemon(existing.port))) {
    return { port: existing.port, started: false };
  }
  if (await probeDaemon(DEFAULT_PORT)) {
    return { port: DEFAULT_PORT, started: false };
  }

  // Resolve port: default when free, otherwise scan forward.
  const port = (await isPortFree(DEFAULT_PORT))
    ? DEFAULT_PORT
    : await findFreePort(DEFAULT_PORT + 1);

  writeDaemonState({ pid: 0, port, startedAt: new Date().toISOString() });

  // dist 形（entry.js）直接跑——发布包里没有 tsx；源码态（entry.ts）才需要。
  const entry = resolveDaemonEntry();
  const args = entry.isTs ? ['--import', 'tsx', entry.path] : [entry.path];
  if (!(await spawnOutsideJob(process.execPath, args))) {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
    child.unref();
  }

  // 起好了才算「起了」：调用方紧接着就要读它写出的文件、打它的接口。
  await waitForDaemon(port);

  return { port, started: true };
}

async function startAction(): Promise<void> {
  const handle = await ensureDaemonRunning();
  if (!handle.started) {
    logger.info(t('out.daemon.alreadyRunning', { port: handle.port }));
    return;
  }
  logger.success(t('out.daemon.started', { host: DAEMON_HOST, port: handle.port }));
}

/** /health 的活体数据（probe 之后取 pid 等真实值）。 */
async function fetchHealth(port: number): Promise<{ pid: number; port: number; uptimeMs: number }> {
  const res = await fetch(`http://${DAEMON_HOST}:${port}/health`);
  return (await res.json()) as { pid: number; port: number; uptimeMs: number };
}

/**
 * 停止守护进程。活体优先：/health 报的是当前监听者的真实 pid；状态文件的
 * pid 可能陈尸（kill 它会误伤 pid 回收后的无关进程），只在探针失败时兜底。
 */
async function stopAction(): Promise<void> {
  const state = readDaemonState();
  const port = state?.port ?? DEFAULT_PORT;
  let pid = state?.pid;
  if (await probeDaemon(port)) {
    pid = (await fetchHealth(port)).pid;
  } else if (!state) {
    logger.info(t('out.daemon.statusNotRunning'));
    return;
  }

  let killedPid: number | undefined;
  if (pid) {
    try {
      process.kill(pid);
      killedPid = pid;
    } catch {
      // 已死/陈尸 pid——落空即清理状态。
    }
  }
  clearDaemonState();
  if (killedPid !== undefined) {
    logger.success(t('out.daemon.stopped', { pid: killedPid }));
  } else {
    logger.warn(t('out.daemon.statusStale', { pid: pid ?? 0, port }));
  }
}

/** 状态文件缺失不代表没在跑（上次 stop/异常退出可能清了它）——照探默认端口。 */
async function statusAction(): Promise<void> {
  const state = readDaemonState();
  const port = state?.port ?? DEFAULT_PORT;
  if (await probeDaemon(port)) {
    const health = await fetchHealth(port);
    logger.info(
      t('out.daemon.statusRunning', {
        pid: health.pid,
        port: health.port,
        uptime: Math.round(health.uptimeMs / 1000),
      }),
    );
    // 全部访问地址（IP × 协议）；与设置页同一事实源（server 的 accessUrls）。
    const urls = accessUrls(port, state?.tlsPort ?? 0);
    if (urls.length > 0) {
      logger.dim(t('out.daemon.urlsTitle'));
      logger.dim(urls.map((u) => `  ${u.url}`).join('\n'));
    }
  } else if (state) {
    logger.warn(t('out.daemon.statusStale', { pid: state.pid, port: state.port }));
  } else {
    logger.info(t('out.daemon.statusNotRunning'));
  }
}

export const daemonCommand: Command = {
  name: 'daemon',
  description: 'cmd.daemon.desc',
  subcommands: [
    {
      name: 'start',
      description: 'cmd.daemon.start.desc',
      action: startAction,
    },
    { name: 'stop', description: 'cmd.daemon.stop.desc', action: stopAction },
    { name: 'status', description: 'cmd.daemon.status.desc', action: statusAction },
  ],
};
