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
  const child = spawn(
    process.execPath,
    entry.isTs ? ['--import', 'tsx', entry.path] : [entry.path],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

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
