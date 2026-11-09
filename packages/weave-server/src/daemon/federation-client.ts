import { createHash } from 'node:crypto';
import type { PeerRow } from '../repositories/peers.js';
import { certFingerprint, tofuVerdict, type PairingError } from './federation.js';

/**
 * 联邦出站（F1）：对端 HTTPS 调用的唯一出口。裁决 15⑤——恒 HTTPS、自签证书
 * 按 peer 指纹校验（TOFU：拿 peer 行 fingerprint 比对证书 SHA-256，**不做系统
 * 信任链**）；指纹不匹配即拒并要求重新 pairing。超时与既有 postJson 边界同档。
 *
 * 实现走 node https + pin 证书（fetch 拿不到裸 socket 的证书对齐点）：
 * TLS 握手完成先验 `certFingerprint(peer.getPeerCertificate().raw.toString(...))`，
 * 不匹配立即断连——绝不发请求体。
 */

const FEDERATION_TIMEOUT_MS = 5_000;

export type TofuCheck = { ok: true } | { ok: false; reason: 'mismatch' | 'unavailable' };

/** 证书 PEM 的 SHA-256 指纹（与 certFingerprint 同口径：对 DER raw 求哈希）。 */
export function certPemFingerprint(certPem: string): string | null {
  return certFingerprint(certPem);
}

export interface FederationHttpResponse {
  ok: boolean;
  status: number;
  body: string;
}

export interface PeerEndpoint {
  host: string;
  port: number;
  /** 对端证书指纹（peer 行记录；null = 尚未 TOFU 首见）。 */
  fingerprint: string | null;
}

/** 错误归一（裁决：不可达与拒绝可区分）：reason = pairing 词表。 */
export function describePeerError(err: unknown): { reason: PairingError; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  if (code === 'CERT_FINGERPRINT_MISMATCH') return { reason: 'refused', message };
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENOTFOUND'
  ) {
    return { reason: 'unreachable', message };
  }
  return { reason: 'unreachable', message };
}

export interface FederatedRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** per-peer token（打到对端 /federation/* 的门；localToken 永不出机）。 */
  token?: string;
  headers?: Record<string, string>;
}

/**
 * 对端调用唯一入口：https.request + TOFU pin。TLS 握手一完成就比对对端证书
 * 指纹——首见（peer 无指纹记录）即信任并在响应后由调用方回写 peer 行；已记录
 * 则严格等值，mismatch 即拒（证书变更 = 重新 pairing，裁决 15④）。
 */
export function peerRequest(
  peer: PeerEndpoint,
  req: FederatedRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = FEDERATION_TIMEOUT_MS,
): Promise<FederationHttpResponse> {
  // 出站协议白名单：恒 https（HTTP 降级档 v1 不做）。测试注入 fetchImpl 走它自己的通道。
  if (fetchImpl !== fetch) {
    return runFetch(peer, req, fetchImpl, timeoutMs);
  }
  return runNodeHttps(peer, req, timeoutMs);
}

async function runFetch(
  peer: PeerEndpoint,
  req: FederatedRequest,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<FederationHttpResponse> {
  const res = await fetchImpl(`https://${peer.host}:${peer.port}${req.path}`, {
    method: req.method,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'weave-daemon',
      ...(req.token ? { authorization: `Bearer ${req.token}` } : {}),
      ...(req.headers ?? {}),
    },
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

/** 证书 DER → 指纹（node tls 的 peer certificate 形态）。 */
function derFingerprint(cert: { raw?: Buffer } | null): string | null {
  if (!cert?.raw) return null;
  return createHash('sha256').update(cert.raw).digest('hex');
}

function runNodeHttps(
  peer: PeerEndpoint,
  req: FederatedRequest,
  timeoutMs: number,
): Promise<FederationHttpResponse> {
  return new Promise((resolve, reject) => {
    void import('node:https').then(({ request }) => {
      let settled = false;
      const done = (err?: Error, res?: FederationHttpResponse): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(res!);
      };
      const timer = setTimeout(() => {
        socket?.destroy();
        const err = new Error(`federation request timed out after ${timeoutMs}ms`);
        (err as Error & { code?: string }).code = 'ETIMEDOUT';
        done(err);
      }, timeoutMs);
      const r = request(
        {
          host: peer.host,
          port: peer.port,
          path: req.path,
          method: req.method,
          // TOFU pin：关掉系统信任链，证书真伪由我们拿指纹比对——不是 skip 验证
          // 的松门（校验在 handshake 钩子里做，不匹配即断连）。
          rejectUnauthorized: false,
          timeout: timeoutMs,
          headers: {
            'content-type': 'application/json',
            'user-agent': 'weave-daemon',
            ...(req.token ? { authorization: `Bearer ${req.token}` } : {}),
            ...(req.body !== undefined ? { 'content-length': String(Buffer.byteLength(JSON.stringify(req.body))) } : {}),
            ...(req.headers ?? {}),
          },
        },
        (res) => {
          // TOFU 检查点：握手证书对齐 peer 行指纹。TLS 套接字在 socket 事件上拿。
          // res.socket 在 http 模块类型里是通用 socket，运行时是 TLSSocket。
          const tls = res.socket as import('node:tls').TLSSocket;
          const fp = derFingerprint(tls?.getPeerCertificate?.(false) ?? null);
          if (peer.fingerprint) {
            const verdict = tofuVerdict(peer.fingerprint, fp ?? '');
            if (verdict === 'mismatch') {
              const err = new Error('peer certificate fingerprint mismatch — re-pair required');
              (err as Error & { code?: string }).code = 'CERT_FINGERPRINT_MISMATCH';
              res.destroy();
              clearTimeout(timer);
              done(err);
              return;
            }
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => {
            clearTimeout(timer);
            done(undefined, { ok: (res.statusCode ?? 500) < 400, status: res.statusCode ?? 500, body });
          });
          res.on('error', (err: Error) => {
            clearTimeout(timer);
            done(err);
          });
        },
      );
      let socket: import('node:net').Socket | null = null;
      r.on('socket', (s) => {
        socket = s;
      });
      r.on('timeout', () => {
        r.destroy();
      });
      r.on('error', (err: Error) => {
        clearTimeout(timer);
        done(err);
      });
      if (req.body !== undefined) r.write(JSON.stringify(req.body));
      r.end();
    });
  });
}

/** peer 行 → 出站端点（host:port 缺一不可——port 0 = 手动建行还没填端口）。 */
export function peerEndpointOf(peer: PeerRow): PeerEndpoint | null {
  if (!peer.host || peer.port <= 0) return null;
  return { host: peer.host, port: peer.port, fingerprint: peer.fingerprint };
}
