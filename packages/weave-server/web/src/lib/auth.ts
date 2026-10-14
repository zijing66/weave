import { useSyncExternalStore } from 'react';

/**
 * dashboard 认证态（客户端）：`unknown`（未探测）→ `anonymous`（登录页）/
 * `authenticated`（应用本体）。单一模块级 store——apiFetch 的 401 钩子、SSE
 * 的连接开关、App 的门都读它一个来源，不各自维护副本。
 *
 * 登录页只有一个密码框；**不提供改密**（改密只走 CLI `weave chpass <新密码>`）。
 */

export type AuthState = 'unknown' | 'anonymous' | 'authenticated';

/** 带 HTTP 状态的认证错误（401 = 密码错，UI 好给本地化文案，不透英文原文）。 */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const BASE = '/api';

let state: AuthState = 'unknown';
const listeners = new Set<() => void>();

function setState(next: AuthState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

export function authState(): AuthState {
  return state;
}

/** 订阅认证态（React 走 useAuthState；SSE 的连接开关也用它）。 */
export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAuthState(): AuthState {
  return useSyncExternalStore(subscribeAuth, authState);
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
  } catch {
    // 非 JSON 错误体：回落原文/状态码
  }
  return body || String(res.status);
}

/** 探测会话态（GET /auth/status 免认证）。网络不可达时保持现状——daemon 没起来
 *  不该把用户甩到登录页，连接回来后自会再探。 */
export async function refreshAuth(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/auth/status`);
    if (!res.ok) {
      setState('anonymous');
      return;
    }
    const body = (await res.json()) as { authenticated?: unknown };
    setState(body.authenticated === true ? 'authenticated' : 'anonymous');
  } catch {
    // 保持现状
  }
}

/** 登录（仅密码）；失败抛 AuthError。成功后 store 翻态，App 旋即渲染应用本体。 */
export async function login(password: string): Promise<void> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new AuthError(await errorText(res), res.status);
  setState('authenticated');
}

/** 退出登录：清 cookie → 回登录页（断网也照样本地登出）。 */
export async function logout(): Promise<void> {
  try {
    await fetch(`${BASE}/auth/logout`, { method: 'POST' });
  } catch {
    // 清 cookie 失败不影响本地翻态
  }
  setState('anonymous');
}

/** 401 钩子：任一 API / SSE 被拒即回登录页。 */
export function markUnauthorized(): void {
  setState('anonymous');
}

/** SSE 出错时轻量复核（可能是被 401 顶掉，也可能只是网络抖动）。 */
export function recheckAuth(): void {
  void refreshAuth();
}
