import { existsSync, readFileSync, rmSync } from 'node:fs';
import { getAuthPath, getInitialPasswordPath } from '@weavecode/server';
import { logger } from '@weavecode/core';
import { t } from '../i18n/index.js';

/**
 * CLI 侧的认证材料读取：本机令牌（auth.json，0600）与首启初始密码标记。
 * 二者都是「本机即管理员」的实现——同机同用户可读 auth.json，故 CLI 免密码
 * 即可改密（服务端认 `x-weave-local`，见 weave-server/src/daemon/dashboard-auth.ts）。
 */

/** 本机令牌请求头；auth.json 缺失/损坏（daemon 未首启）→ 空对象（调用方按 401 报错）。 */
export function localTokenHeader(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(getAuthPath(), 'utf8')) as { localToken?: unknown };
    return typeof parsed.localToken === 'string' && parsed.localToken
      ? { 'x-weave-local': parsed.localToken }
      : {};
  } catch {
    return {};
  }
}

/**
 * 领取首启初始密码：读标记文件 → 打印一次 → 删除。没领到就什么都不做。
 * 领取即销毁是有意的——初始密码只该出现一次；错过用 `weave chpass` 重设。
 */
export function announceInitialPassword(): void {
  const file = getInitialPasswordPath();
  if (!existsSync(file)) return;
  let password: string;
  try {
    password = readFileSync(file, 'utf8').trim();
  } catch {
    return;
  }
  rmSync(file, { force: true });
  if (!password) return;
  logger.info(t('out.dash.initialPassword', { password }));
}
