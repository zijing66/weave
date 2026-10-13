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
} from '@weavecode/server';
import { logger } from '@weavecode/core';
import { t } from '../i18n/index.js';
import type { Command } from '../parser.js';

/** True when a weave daemon answers /health on `port`. */
async function probeDaemon(port: number): Promise<boolean> {
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

async function stopAction(): Promise<void> {
  const state = readDaemonState();
  if (!state) {
    logger.warn(t('out.daemon.noState'));
    return;
  }
  try {
    process.kill(state.pid);
  } catch {
    // Stale pid — fall through to clear state.
  }
  clearDaemonState();
  logger.success(t('out.daemon.stopped', { pid: state.pid }));
}

async function statusAction(): Promise<void> {
  const state = readDaemonState();
  if (!state) {
    logger.info(t('out.daemon.statusNotRunning'));
    return;
  }
  if (await probeDaemon(state.port)) {
    const res = await fetch(`http://${DAEMON_HOST}:${state.port}/health`);
    const health = (await res.json()) as { pid: number; port: number; uptimeMs: number };
    logger.info(
      t('out.daemon.statusRunning', {
        pid: health.pid,
        port: health.port,
        uptime: Math.round(health.uptimeMs / 1000),
      }),
    );
  } else {
    logger.warn(
      t('out.daemon.statusStale', { pid: state.pid, port: state.port }),
    );
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
