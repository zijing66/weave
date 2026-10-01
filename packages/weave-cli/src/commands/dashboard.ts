import { spawn } from 'node:child_process';
import { DAEMON_HOST, resolveStaticDir } from '@weave/server';
import { logger } from '@weave/core';
import { ensureDaemonRunning } from './daemon.js';
import type { Command } from '../parser.js';

/**
 * `weave dashboard` — start the daemon if needed and open the web console.
 *
 * The daemon serves the built SPA (packages/weave-web/dist) on a single origin.
 * The console is opened with the daemon's own token in `?token=`, so it works
 * regardless of which token the running daemon minted — the build-time default
 * baked into the bundle is only a fallback.
 */

/** Open `url` in the platform's default browser. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? // `start` is a cmd builtin, so it needs a shell; the empty "" is the
        // window-title argument, without which a quoted URL is taken as one.
        ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // Headless machines and locked-down environments have no opener; the URL
    // is printed either way, so failing to launch is not fatal.
    logger.dim(`(could not launch a browser automatically — open it manually)`);
  });
  child.unref();
}

/** The console URL for a daemon handle, token included. */
export function dashboardUrl(port: number, token: string): string {
  const base = `http://${DAEMON_HOST}:${port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

async function dashboardAction(ctx: { flags: Record<string, unknown> }): Promise<void> {
  const noOpen = Boolean(ctx.flags['noOpen']);

  const handle = await ensureDaemonRunning();

  if (!handle.started) {
    logger.info(`Daemon already running on port ${handle.port}`);
  } else {
    logger.success(`Daemon started on http://${DAEMON_HOST}:${handle.port}`);
    logger.dim('Stop it later with `weave daemon stop`.');
  }

  if (!handle.token) {
    logger.error(
      'A daemon is running on the default port but its token is unknown, so the console cannot authenticate.',
    );
    logger.dim('  Restart it with `weave daemon stop` then `weave dashboard`.');
    process.exitCode = 1;
    return;
  }

  if (!resolveStaticDir()) {
    logger.warn('The web bundle is not built, so the daemon has nothing to serve.');
    logger.dim('  Build it with `pnpm build:web`, or run the Vite dev server: `pnpm dev:web` (http://localhost:9527).');
  }

  const url = dashboardUrl(handle.port, handle.token);
  logger.info(`\n  Dashboard: ${url}\n`);

  if (noOpen) {
    logger.dim('  (--no-open: not launching a browser)');
    return;
  }
  openBrowser(url);
}

export const dashboardCommand: Command = {
  name: 'dashboard',
  aliases: ['dash'],
  description: 'Open the web console in a browser (starts the daemon if needed)',
  options: [
    {
      name: 'no-open',
      description: 'Print the dashboard URL without opening a browser',
      type: 'boolean',
      default: false,
    },
  ],
  action: dashboardAction,
};
