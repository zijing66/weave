import { spawn } from 'node:child_process';
import { accessUrls, DAEMON_HOST, readDaemonState, resolveStaticDir } from '@weavecode/server';
import { logger } from '@weavecode/core';
import { t } from '../i18n/index.js';
import { ensureDaemonRunning } from './daemon.js';
import { announceInitialPassword } from './daemon-auth.js';
import type { Command } from '../parser.js';

/**
 * `weave dashboard` — start the daemon if needed and open the web console.
 *
 * The daemon serves the built SPA (packages/weave-server/web/dist) on a single
 * origin; 绑定地址来自 settings（默认 0.0.0.0），访问需 dashboard 密码登录
 * （首启的初始密码在本命令输出里领取一次）。
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

/** The console URL for a daemon port. */
export function dashboardUrl(port: number): string {
  return `http://${DAEMON_HOST}:${port}/`;
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

  if (!resolveStaticDir()) {
    logger.warn(t('out.dash.noBundle'));
    logger.dim(t('out.dash.buildHint'));
  }

  const url = dashboardUrl(handle.port);
  logger.info(t('out.dash.url', { url }));
  // 全部访问地址（本机 + 局域网 × HTTP/HTTPS）：与 `weave daemon status`、设置页同源
  // （server 的 accessUrls）。原先只列 HTTP + 非回环 IPv4，把手机要的 https 那条漏了。
  const urls = accessUrls(handle.port, readDaemonState()?.tlsPort ?? 0);
  if (urls.length > 0) {
    logger.dim(t('out.daemon.urlsTitle'));
    logger.dim(urls.map((u) => `  ${u.url}`).join('\n'));
  }
  // 首启初始密码的一次性领取点（daemon 是 detached 启动，打印必丢）。
  announceInitialPassword();

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
