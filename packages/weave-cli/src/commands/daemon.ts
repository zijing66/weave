import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT,
  DAEMON_HOST,
  isPortFree,
  findFreePort,
  readDaemonState,
  writeDaemonState,
  clearDaemonState,
  generateToken,
  daemonEntryUrl,
} from '@weave/server';
import { logger } from '@weave/core';
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

async function startAction(): Promise<void> {
  // Single-instance: reuse an already-running daemon.
  if (await probeDaemon(DEFAULT_PORT)) {
    logger.info(`Daemon already running on port ${DEFAULT_PORT}`);
    return;
  }
  const existing = readDaemonState();
  if (existing && (await probeDaemon(existing.port))) {
    logger.info(`Daemon already running on port ${existing.port}`);
    return;
  }

  // Resolve port: default when free, otherwise scan forward.
  const port = (await isPortFree(DEFAULT_PORT))
    ? DEFAULT_PORT
    : await findFreePort(DEFAULT_PORT + 1);

  const token = generateToken();
  writeDaemonState({ pid: 0, port, token, startedAt: new Date().toISOString() });

  const entryPath = fileURLToPath(daemonEntryUrl);
  const child = spawn(process.execPath, ['--import', 'tsx', entryPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  logger.success(`Daemon started on http://${DAEMON_HOST}:${port}`);
  logger.dim(`Token: ${token}`);
}

async function stopAction(): Promise<void> {
  const state = readDaemonState();
  if (!state) {
    logger.warn('No daemon state found — daemon is not running.');
    return;
  }
  try {
    process.kill(state.pid);
  } catch {
    // Stale pid — fall through to clear state.
  }
  clearDaemonState();
  logger.success(`Daemon stopped (pid ${state.pid}).`);
}

async function statusAction(): Promise<void> {
  const state = readDaemonState();
  if (!state) {
    logger.info('Daemon: not running');
    return;
  }
  if (await probeDaemon(state.port)) {
    const res = await fetch(`http://${DAEMON_HOST}:${state.port}/health`);
    const health = (await res.json()) as { pid: number; port: number; uptimeMs: number };
    logger.info(
      `Daemon: running (pid ${health.pid}, port ${health.port}, up ${Math.round(health.uptimeMs / 1000)}s)`,
    );
  } else {
    logger.warn(`Daemon: stale state (pid ${state.pid}, port ${state.port} not responding)`);
  }
}

export const daemonCommand: Command = {
  name: 'daemon',
  description: 'Manage the weave daemon',
  subcommands: [
    { name: 'start', description: 'Start the daemon in the background', action: startAction },
    { name: 'stop', description: 'Stop the running daemon', action: stopAction },
    { name: 'status', description: 'Show daemon status', action: statusAction },
  ],
};
