import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { DAEMON_HOST, readDaemonState, resolveStaticDir } from '@weavecode/server';
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

/** 绑非回环时的局域网访问地址（IPv4 非内部）；绑回环 / 无状态文件 → 空表。 */
export function lanUrls(port: number): string[] {
  const host = readDaemonState()?.host;
  if (!host || host === '127.0.0.1' || host === 'localhost') return [];
  const urls: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) urls.push(`http://${info.address}:${port}/`);
    }
  }
  return urls;
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
  // 绑非回环时同时给出局域网地址（另机用同一密码登录）。
  for (const lan of lanUrls(handle.port)) {
    logger.info(t('out.dash.lanUrl', { url: lan }));
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
