import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { generate } from 'selfsigned';
import { getDataDir } from '../db/paths.js';

/** 自签证书目录（`<dataDir>/certs`）。 */
export function daemonCertsDir(): string {
  return path.join(getDataDir(), 'certs');
}

/** 本机对外 IPv4：全部非 internal 地址（局域网访问面），去重排序求稳定序。 */
export function lanIps(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.add(ni.address);
    }
  }
  return [...out].sort();
}

export interface AccessUrl {
  url: string;
  protocol: 'http' | 'https';
  /** local = 本机回环；lan = 局域网其他设备可达。 */
  scope: 'local' | 'lan';
}

/**
 * 守护进程的全部访问地址（`daemon status` 与设置页同一事实源）：
 * 每个局域网 IP × 已开协议，外加 localhost。tlsPort 为 0/未开则只有 http。
 */
export function accessUrls(port: number, tlsPort: number): AccessUrl[] {
  const urls: AccessUrl[] = [{ url: `http://localhost:${port}`, protocol: 'http', scope: 'local' }];
  if (tlsPort > 0) {
    urls.push({ url: `https://localhost:${tlsPort}`, protocol: 'https', scope: 'local' });
  }
  for (const ip of lanIps()) {
    urls.push({ url: `http://${ip}:${port}`, protocol: 'http', scope: 'lan' });
    if (tlsPort > 0) urls.push({ url: `https://${ip}:${tlsPort}`, protocol: 'https', scope: 'lan' });
  }
  return urls;
}

export interface DaemonCert {
  key: string;
  cert: string;
}

/** SAN 集合（X509Certificate.subjectAltName 的 "DNS:localhost, IP Address:1.2.3.4" 形）。 */
function sanIps(cert: X509Certificate): Set<string> {
  const raw = cert.subjectAltName ?? '';
  const ips = new Set<string>();
  for (const entry of raw.split(',')) {
    const m = entry.trim().match(/^IP Address:(.+)$/);
    if (m) ips.add(m[1]);
  }
  return ips;
}

/**
 * 取自签证书：落盘件可直接复用（未过期 + 私钥匹配 + 当前 IP 仍在 SAN 内——
 * DHCP 换 IP 后重签，手机按旧 IP 授权过的一旦 IP 变更本来就得重新访问）；
 * 否则重新生成。纯 JS（selfsigned），不依赖 openssl。
 */
export async function ensureDaemonCert(
  dir: string = daemonCertsDir(),
  opts: { ips?: string[]; hostname?: string; now?: Date } = {},
): Promise<DaemonCert> {
  const ips = opts.ips ?? ['127.0.0.1', ...lanIps()];
  const hostname = opts.hostname ?? os.hostname();
  const now = opts.now ?? new Date();
  const keyPath = path.join(dir, 'host.key');
  const certPath = path.join(dir, 'host.crt');

  if (existsSync(keyPath) && existsSync(certPath)) {
    try {
      const key = readFileSync(keyPath, 'utf-8');
      const x509 = new X509Certificate(readFileSync(certPath, 'utf-8'));
      const coversIps = ips.every((ip) => sanIps(x509).has(ip));
      // 7 天缓冲：临期证书直接换，不留「昨天还好今天过期」的窗口。
      if (x509.checkPrivateKey(createPrivateKey(key)) && Date.parse(x509.validTo) > now.getTime() + 7 * 86400_000 && coversIps) {
        return { key, cert: readFileSync(certPath, 'utf-8') };
      }
    } catch {
      // 坏文件（半个写入/被截断）→ 落到重签
    }
  }

  const pems = await generate([{ name: 'commonName', value: 'weave-daemon' }], {
    keySize: 2048,
    notAfterDate: new Date(now.getTime() + 825 * 86400_000),
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 2, value: hostname },
          ...ips.map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

export interface TlsListener {
  server: https.Server;
  /** 实际监听端口（与请求的相同）。 */
  port: number;
}

/**
 * 起局域网 HTTPS 监听（与 6420 的 HTTP 并存，同一认证/路由面）。
 * 端口被占等失败**不致命**：警告后放弃 HTTPS（HTTP 不受影响）。
 */
export async function startTlsServer(opts: {
  port: number;
  bindHost: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** 证书目录（测试注入临时目录）；缺省 `<dataDir>/certs`。 */
  certDir?: string;
}): Promise<TlsListener | null> {
  if (opts.port <= 0) return null;
  try {
    const { key, cert } = await ensureDaemonCert(opts.certDir);
    const server = https.createServer({ key, cert }, opts.handler);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, opts.bindHost, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return { server, port: opts.port };
  } catch (e) {
    console.warn(
      `[weave] https listener disabled (port ${opts.port}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
