import { createHmac } from 'node:crypto';
import type { HookRule } from '@weavecode/core';

/** 事件摘要——出站 webhook body 只带这些字段（不透传全量 toolResponse，收窄外泄面）。 */
export interface EventSummary {
  ruleId: string;
  ruleName: string;
  projectId: number;
  sessionId: string | null;
  event: string;
  toolName: string | null;
  /** toolInput.file_path（若事件携带）。 */
  filePath: string | null;
  cwd: string | null;
  at: string;
}

export interface WebhookResult {
  ok: boolean;
  status: 'succeeded' | 'failed' | 'timeout';
  output?: string;
  error?: string;
}

const WEBHOOK_TIMEOUT_MS = 5_000;
const RESPONSE_TRUNCATE = 4_096;

/**
 * 出站 POST 的唯一 HTTP 边界（hook 规则与编排出口共用）：仅 http/https、5s 超时、
 * 响应体截断 4KB、可选 HMAC-SHA256 签名头 `X-Weave-Signature: sha256=<hex>`
 * （secret 即签名密钥）。body 为任意可序列化载荷（形状归调用方）。
 */
export async function postJson(
  rawUrl: string,
  secret: string | undefined,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 'failed', error: `invalid url: ${rawUrl}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, status: 'failed', error: `unsupported protocol: ${url.protocol}` };
  }

  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'weave-daemon',
  };
  if (secret) {
    headers['x-weave-signature'] = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  }

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    const text = (await res.text()).slice(0, RESPONSE_TRUNCATE);
    if (res.ok) {
      return { ok: true, status: 'succeeded', output: text || `HTTP ${res.status}` };
    }
    return { ok: false, status: 'failed', error: `HTTP ${res.status}`, output: text };
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      status: isTimeout ? 'timeout' : 'failed',
      error: isTimeout ? `webhook timed out after ${WEBHOOK_TIMEOUT_MS}ms` : String(err),
    };
  }
}

/**
 * hook 规则的出站 webhook 处理器：POST 事件摘要到外部系统。
 * 协议白名单、超时、签名等边界全在 {@link postJson}——这里只定载荷形状。
 */
export async function runWebhook(
  rule: HookRule,
  summary: EventSummary,
  fetchImpl: typeof fetch = fetch,
): Promise<WebhookResult> {
  const handler = rule.handler;
  if (handler.type !== 'webhook') {
    return { ok: false, status: 'failed', error: `rule ${rule.id} is not a webhook handler` };
  }
  return postJson(handler.url, handler.secret, summary, fetchImpl);
}
