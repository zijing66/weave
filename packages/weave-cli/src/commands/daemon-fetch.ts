import https from 'node:https';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { DAEMON_HOST, daemonCertsDir } from '@weavecode/server';

/**
 * CLI → daemon 的 HTTPS 请求（2026-11-23 裁决 HTTP 下线，daemon 唯一面是自签
 * HTTPS）。fetch 不认自签 ⇒ 用 node:https 并把盘上证书当 CA 钉住——证书就是
 * daemon 启动期写的那份（`<dataDir>/local/certs/host.crt`），SAN 含 localhost
 * 与 127.0.0.1，等于是本机身份校验而非「关掉校验」。
 */
export interface DaemonResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

export interface DaemonRequestOptions {
  port: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export function daemonCaPem(): string | undefined {
  try {
    return readFileSync(path.join(daemonCertsDir(), 'host.crt'), 'utf8');
  } catch {
    // 证书还没落盘 = daemon 还没起来过，请求本身也会失败，交给调用方按离线处理
    return undefined;
  }
}

export function daemonFetch(pathname: string, opts: DaemonRequestOptions): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: DAEMON_HOST,
        port: opts.port,
        path: pathname,
        method: opts.method ?? 'GET',
        headers: opts.headers,
        ca: daemonCaPem(),
        signal: opts.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
            json: async () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
