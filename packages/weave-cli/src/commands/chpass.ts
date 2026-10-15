import { DAEMON_HOST } from '@weavecode/server';
import { logger } from '@weavecode/core';
import { t } from '../i18n/index.js';
import { ensureDaemonRunning } from './daemon.js';
import { localTokenHeader } from './daemon-auth.js';
import type { Command } from '../parser.js';

/**
 * `weave chpass` —— 修改 dashboard 登录密码。走 daemon 的 `PUT /auth/password`：
 * 本机令牌即认证（同机同用户 = 管理员），无需旧密码。改密会轮换会话密钥——
 * 所有已登录浏览器下次请求即要求重新登录。
 */

/** 与服务端 MIN_PASSWORD_LENGTH 对齐（服务端是权威，这里只是提前报错）。 */
const MIN_LENGTH = 6;

async function chpassAction(ctx: { positional: string[] }): Promise<void> {
  const next = ctx.positional[0];
  if (typeof next !== 'string' || next.length < MIN_LENGTH) {
    logger.warn(t('out.chpass.usage'));
    process.exitCode = 1;
    return;
  }

  const handle = await ensureDaemonRunning();
  try {
    const res = await fetch(`http://${DAEMON_HOST}:${handle.port}/auth/password`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...localTokenHeader() },
      body: JSON.stringify({ next }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (!res.ok) {
      throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
    }
    logger.success(t('out.chpass.ok'));
  } catch (e) {
    logger.warn(t('out.chpass.fail', { error: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  }
}

export const chpassCommand: Command = {
  name: 'chpass',
  description: 'cmd.chpass.desc',
  action: chpassAction,
  maxPositionals: 1,
};
