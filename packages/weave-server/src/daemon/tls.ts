import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { generate } from 'selfsigned';
import { getCertsDir } from '../db/paths.js';

/** 自签证书目录（`<dataDir>/local/certs`：本机身份，不随数据迁移）。 */
export function daemonCertsDir(): string {
  return getCertsDir();
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
 * 守护进程的全部访问地址（`daemon status` 与设置页同一事实源）：单端口 HTTPS
 *（2026-11-23 裁决 HTTP 下线）——localhost + 每个局域网 IP 各一条。
 */
export function accessUrls(port: number): AccessUrl[] {
  const urls: AccessUrl[] = [{ url: `https://localhost:${port}`, protocol: 'https', scope: 'local' }];
  for (const ip of lanIps()) {
    urls.push({ url: `https://${ip}:${port}`, protocol: 'https', scope: 'lan' });
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

/**
 * 建主 HTTPS 监听（daemon 的唯一网络面，2026-11-23 裁决 HTTP 下线）。证书取
 * 自签盘件（缺失/过期/IP 变了会重签）。返回的 server 由调用方 listen。
 */
export async function createDaemonServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  opts: { certDir?: string } = {},
): Promise<https.Server> {
  const { key, cert } = await ensureDaemonCert(opts.certDir);
  return https.createServer({ key, cert }, handler);
}

// ---- 本机信任安装（用户级、无提权，daemon 启动期跑一次） ----

export interface TrustCmd {
  cmd: string;
  args: string[];
}

const NSS_DB = () => `sql:${path.join(os.homedir(), '.pki', 'nssdb')}`;

/** 已在库/已信任的探测：命中就不再调用安装命令——安装命令每次都会弹系统
 *  授权框（Windows 安全警告、macOS 钥匙串提示），「只在首次提示」全靠这一步。 */
function trustProbeFor(platform: NodeJS.Platform, certPath: string, thumbprintSha1: string): TrustCmd | null {
  switch (platform) {
    case 'win32':
      // -verifystore 只查不写，无弹框；当前用户 Root store。
      return { cmd: 'certutil', args: ['-user', '-verifystore', 'Root', thumbprintSha1] };
    case 'darwin':
      // 真正问「这份证书是否被信任」（库里存在 ≠ 信任标了 root）。
      return { cmd: 'security', args: ['verify-cert', '-c', certPath, '-p', 'ssl'] };
    case 'linux':
      return { cmd: 'certutil', args: ['-d', NSS_DB(), '-L', '-n', 'weave-daemon'] };
    default:
      return null;
  }
}

/** 安装到**用户级**受信任根（免管理员/root；失败只警告不拦启动）。 */
function trustInstallFor(platform: NodeJS.Platform, certPath: string): TrustCmd | null {
  switch (platform) {
    case 'win32':
      // certutil -user：当前用户 Root store，无 UAC（首次会有一次安全警告框）。
      return { cmd: 'certutil', args: ['-user', '-addstore', 'Root', certPath] };
    case 'darwin':
      // 用户登录钥匙串 + 用户域信任标；不带 -d（-d 是系统域，要 root）。
      return {
        cmd: 'security',
        args: ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db'), certPath],
      };
    case 'linux':
      // NSS 共享库（Chrome/Firefox 用户库）；certutil 来自 libnss3-tools。
      return { cmd: 'certutil', args: ['-d', NSS_DB(), '-A', '-t', 'C,,', '-n', 'weave-daemon', '-i', certPath] };
    default:
      return null;
  }
}

/** 记录已安装的证书指纹（兜底探测之外的快路径）。 */
function trustMarkerPath(dir: string): string {
  return path.join(dir, 'trust-installed');
}

export type TrustRunner = (spec: TrustCmd, timeoutMs: number) => Promise<number | null>;

function runTrustCmd(spec: TrustCmd, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    void (async () => {
      const { spawn } = await import('node:child_process');
      const child = spawn(spec.cmd, spec.args, { stdio: 'ignore', windowsHide: true });
      let settled = false;
      const done = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code);
      };
      const timer = setTimeout(() => {
        child.kill();
        done(null);
      }, timeoutMs);
      timer.unref();
      child.on('error', () => done(null)); // 命令不存在（如 linux 未装 libnss3-tools）
      child.on('close', (code) => done(code));
    })();
  });
}

/**
 * 把自签证书装进本机**用户级**受信任根（2026-11-23 用户裁决：daemon 启动时自动装，
 * 本机访问不报「证书不受信任」）。先探测（指纹标记 → 平台探测），只在确实没装过
 * 时才调用安装命令——系统授权框只在首次出现。平台差异收在本文件两处命令表里；
 * 任何失败都只警告，不影响 HTTPS 监听本身（浏览器可回落手动信任一次）。
 */
export async function installCertTrust(
  certPath: string,
  dir: string = daemonCertsDir(),
  deps: { run?: TrustRunner; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const run = deps.run ?? runTrustCmd;
  const platform = deps.platform ?? process.platform;
  const install = trustInstallFor(platform, certPath);
  if (!install) return;
  let fp = '';
  let thumbprint = '';
  try {
    const x509 = new X509Certificate(readFileSync(certPath));
    fp = x509.fingerprint256;
    thumbprint = x509.fingerprint.replace(/:/g, '');
  } catch {
    return; // 证书都读不了：监听侧会重签，信任这拍等下一轮
  }

  const marker = trustMarkerPath(dir);
  try {
    if (readFileSync(marker, 'utf8').trim() === fp) return;
  } catch {
    /* 首次：往下走 */
  }

  const markDone = (): void => {
    try {
      writeFileSync(marker, fp);
    } catch {
      /* 标记写不进无所谓：下次探测兜住 */
    }
  };

  const probe = trustProbeFor(platform, certPath, thumbprint);
  if (probe && (await run(probe, 10_000)) === 0) {
    markDone();
    return;
  }

  // 安装可能等用户点一次系统授权框，给足时间；daemon 启动不等它（调用方 void）。
  const code = await run(install, 120_000);
  if (code === 0) markDone();
  else console.warn(`[weave] cert trust install failed (${install.cmd} exit ${code ?? 'timeout'}) — 浏览器可手动信任一次 ${certPath}`);
}
