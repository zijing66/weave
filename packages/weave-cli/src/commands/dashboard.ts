import { spawn } from 'node:child_process';
import { DAEMON_HOST, resolveStaticDir } from '@weave/server';
import { logger } from '@weave/core';
import { t } from '../i18n/index.js';
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
    logger.dim(t('out.dash.browserFailed'));
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
    logger.info(t('out.daemon.alreadyRunning', { port: handle.port }));
  } else {
    logger.success(t('out.daemon.started', { host: DAEMON_HOST, port: handle.port }));
    logger.dim(t('out.dash.stopHint'));
  }

  if (!handle.token) {
    logger.error(t('out.dash.tokenUnknown'));
    logger.dim(t('out.dash.restartHint'));
    process.exitCode = 1;
    return;
  }

  if (!resolveStaticDir()) {
    logger.warn(t('out.dash.noBundle'));
    logger.dim(t('out.dash.buildHint'));
  }

  const url = dashboardUrl(handle.port, handle.token);
  logger.info(t('out.dash.url', { url }));

  if (noOpen) {
    logger.dim(t('out.dash.noOpen'));
    return;
  }
  openBrowser(url);
}

export const dashboardCommand: Command = {
  name: 'dashboard',
  aliases: ['dash'],
  description: 'cmd.dashboard.desc',
  options: [
    {
      name: 'no-open',
      description: 'flag.dashboard.noOpen',
      type: 'boolean',
      default: false,
    },
  ],
  action: dashboardAction,
};
