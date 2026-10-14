import type { IncomingMessage, ServerResponse } from 'node:http';
import { clearedSessionCookie, sessionCookie } from './dashboard-auth.js';
import { readJson, sendJson } from './http.js';
import type { WeaveServerDeps } from './server.js';

/**
 * /auth/* 路由——认证子系统自身（门豁免），登录页与 CLI 的凭据入口。
 * 未装配 auth（存量测试口径）→ 503；非 /auth 路径 → false 交回主链。
 */

/** 登录失败的人为延迟：LAN 暴露面下拖慢暴力尝试（不做计数状态，够用即可）。 */
const FAILED_LOGIN_DELAY_MS = 300;
/** 密码最短长度（仅防呆，不做强度策略）。 */
const MIN_PASSWORD_LENGTH = 6;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function handleAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WeaveServerDeps,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/auth' && !pathname.startsWith('/auth/')) return false;
  const auth = deps.auth;
  if (!auth) {
    sendJson(res, 503, { error: 'Auth subsystem unavailable' });
    return true;
  }

  if (pathname === '/auth/status' && req.method === 'GET') {
    sendJson(res, 200, {
      passwordSet: auth.isPasswordSet(),
      authenticated: auth.isAuthenticated(req.headers),
    });
    return true;
  }

  if (pathname === '/auth/login' && req.method === 'POST') {
    let body: { password?: unknown };
    try {
      body = (await readJson(req)) as { password?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || !auth.verifyPassword(password)) {
      await delay(FAILED_LOGIN_DELAY_MS);
      sendJson(res, 401, { error: 'Invalid password' });
      return true;
    }
    res.setHeader('set-cookie', sessionCookie(auth.issueSession()));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/auth/logout' && req.method === 'POST') {
    res.setHeader('set-cookie', clearedSessionCookie());
    sendJson(res, 200, { ok: true });
    return true;
  }

  // 改密：需已认证（面板 cookie 或本机令牌 = `weave chpass` 走的通道）。改密会
  // 轮换会话密钥，给调用方回发一枚新 cookie——免得操作者把自己踢下线。
  if (pathname === '/auth/password' && req.method === 'PUT') {
    if (!auth.isAuthenticated(req.headers)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return true;
    }
    let body: { next?: unknown };
    try {
      body = (await readJson(req)) as { next?: unknown };
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const next = typeof body.next === 'string' ? body.next : '';
    if (next.length < MIN_PASSWORD_LENGTH) {
      sendJson(res, 400, { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return true;
    }
    auth.setPassword(next);
    res.setHeader('set-cookie', sessionCookie(auth.issueSession()));
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 404, { error: 'Not found' });
  return true;
}
