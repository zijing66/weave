/**
 * Daemon API client 基座：前缀、fetch 包装、错误取文，外加两枚连接层端点。
 * 各域文件（lib/api/ 下其余文件）只经 apiFetch / 裸 fetch 访问 daemon。
 */

import { markUnauthorized } from '../auth';

/** daemon API 前缀：dev 由 vite 代理剥离，prod 由 daemon 自剥（web 侧只此一处）。 */
export const API_BASE = '/api';

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    // 会话失效/未登录：置匿名 → App 随即渲染登录页；错误照抛（调用方仍可读文案）。
    markUnauthorized();
    throw new Error(await errorText(res));
  }
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

/** 错误信息取 daemon 的 {error|message} 字段；非 JSON / 无字段回落状态码+原文。 */
export async function errorText(res: Response): Promise<string> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // 非 JSON 错误体（代理/网络层）→ 保留状态码前缀
  }
  return body ? `${res.status} ${body}` : String(res.status);
}

/** 仪表盘挂载时让服务端重推一次快照（空载荷；数据本身仍走 SSE）。 */
export const refreshDashboard = (): Promise<{ ok: boolean }> =>
  apiFetch('/dashboard/refresh', { method: 'POST' });

/** 事件流地址；`since` = 上次收到的帧 id，服务端据此补发断流期间漏掉的帧。 */
export const eventsUrl = (since: string | null = null): string =>
  since === null ? `${API_BASE}/events` : `${API_BASE}/events?since=${encodeURIComponent(since)}`;
