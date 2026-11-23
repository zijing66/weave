import http from 'node:http';
import https from 'node:https';
import type { McpHttpContext } from './registry.js';

/**
 * 工具面唯一出口：把调用转回 daemon 自己的 REST API（`/api` 前缀之外的部分）。
 * daemon 是自签 HTTPS（HTTP 已下线），`ctx.ca` = 本机证书 PEM，当 CA 钉住自己；
 * 测试夹具可以是明文 http（不传 ca），故按有无 ca 选通道。
 */
export async function api<T>(
  ctx: McpHttpContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const { status, ok, text } = await new Promise<{ status: number; ok: boolean; text: string }>(
    (resolve, reject) => {
      const transport = ctx.ca ? https : http;
      const req = transport.request(
        {
          host: '127.0.0.1',
          port: ctx.port,
          path: `/api${path}`,
          method,
          ca: ctx.ca,
          headers: {
            'x-weave-origin': 'mcp',
            ...(ctx.token ? { 'x-weave-local': ctx.token } : {}),
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          },
        },
        (res) => {
          let out = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (out += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, text: out }),
          );
        },
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    },
  );
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  })();
  if (!ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${status}`;
    throw new Error(message);
  }
  return parsed as T;
}
