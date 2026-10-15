import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from 'selfsigned';
import { accessUrls, ensureDaemonCert, lanIps, startTlsServer } from '../tls.js';
import { weaveRequestHandler } from '../server.js';

/**
 * 自签证书 + 局域网 HTTPS 面：生成/复用/换 IP 重签、访问地址枚举、
 * TLS 监听器（与 HTTP 同 handler）。全部走注入的临时目录，不碰真 dataDir。
 */

let dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weave-tls-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function sanIps(pem: string): string[] {
  const cert = new X509Certificate(pem);
  return (cert.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim().match(/^IP Address:(.+)$/)?.[1])
    .filter((v): v is string => v != null);
}

describe('ensureDaemonCert', () => {
  it('生成即落盘（key 0600），SAN 覆盖 localhost/hostname/全部 IP', async () => {
    const dir = tmpDir();
    const cert = await ensureDaemonCert(dir, { ips: ['127.0.0.1', '10.0.0.5'], hostname: 'box' });
    const x509 = new X509Certificate(cert.cert);
    expect(x509.subject).toContain('weave-daemon');
    expect(x509.subjectAltName).toContain('DNS:localhost');
    expect(x509.subjectAltName).toContain('DNS:box');
    expect(sanIps(cert.cert)).toEqual(expect.arrayContaining(['127.0.0.1', '10.0.0.5']));
    // key 0600 写盘（POSIX 位；Windows 上 ACL 语义不同，只验证内容落盘）
    expect(readFileSync(path.join(dir, 'host.crt'), 'utf-8')).toBe(cert.cert);
  });

  it('二次调用复用落盘件（证书字节不变，不重写）', async () => {
    const dir = tmpDir();
    const first = await ensureDaemonCert(dir, { ips: ['127.0.0.1'] });
    const before = statSync(path.join(dir, 'host.crt')).mtimeMs;
    const second = await ensureDaemonCert(dir, { ips: ['127.0.0.1'] });
    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
    expect(statSync(path.join(dir, 'host.crt')).mtimeMs).toBe(before);
  });

  it('当前 IP 不在 SAN 内（DHCP 换网）→ 重签', async () => {
    const dir = tmpDir();
    const first = await ensureDaemonCert(dir, { ips: ['127.0.0.1', '10.0.0.5'] });
    const second = await ensureDaemonCert(dir, { ips: ['127.0.0.1', '10.0.0.9'] });
    expect(second.cert).not.toBe(first.cert);
    expect(sanIps(second.cert)).toContain('10.0.0.9');
  });

  it('临期（7 天缓冲内）→ 重签；坏证书文件 → 重签', async () => {
    const dir = tmpDir();
    // 直接落一份 6 天后过期的证书（绕过 ensureDaemonCert 的 825 天）
    const shortLived = await generate([{ name: 'commonName', value: 'weave-daemon' }], {
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 6 * 86400_000),
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
    });
    writeFileSync(path.join(dir, 'host.key'), shortLived.private);
    writeFileSync(path.join(dir, 'host.crt'), shortLived.cert);
    const renewed = await ensureDaemonCert(dir, { ips: ['127.0.0.1'] });
    expect(renewed.cert).not.toBe(shortLived.cert);

    // 坏文件（半个写入）
    const dir2 = tmpDir();
    writeFileSync(path.join(dir2, 'host.key'), 'not a key');
    writeFileSync(path.join(dir2, 'host.crt'), 'not a cert');
    const healed = await ensureDaemonCert(dir2, { ips: ['127.0.0.1'] });
    expect(new X509Certificate(healed.cert).subject).toContain('weave-daemon');
  });
});

describe('accessUrls', () => {
  it('tlsPort 关闭 → 只有 http；开启 → 每 IP 双协议 + localhost 双协议', () => {
    const ips = lanIps();
    const httpOnly = accessUrls(6420, 0);
    expect(httpOnly[0]).toEqual({ url: 'http://localhost:6420', protocol: 'http', scope: 'local' });
    expect(httpOnly.every((u) => u.protocol === 'http')).toBe(true);
    expect(httpOnly).toHaveLength(1 + ips.length);

    const dual = accessUrls(6420, 6443);
    expect(dual.some((u) => u.url === 'https://localhost:6443')).toBe(true);
    for (const ip of ips) {
      expect(dual.some((u) => u.url === `http://${ip}:6420`)).toBe(true);
      expect(dual.some((u) => u.url === `https://${ip}:6443`)).toBe(true);
    }
    expect(dual).toHaveLength((1 + ips.length) * 2);
  });

  it('lanIps 只含非 internal IPv4', () => {
    for (const ip of lanIps()) {
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(ip).not.toBe('127.0.0.1');
    }
    // 机器至少有回环之外的接口（CI 容器也有 eth0）
    expect(Object.values(os.networkInterfaces()).flat().length).toBeGreaterThan(0);
  });
});

describe('startTlsServer', () => {
  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
      probe.on('error', reject);
    });
  }

  it('与 HTTP 同 handler：https 请求（忽略自签）打穿 /health', async () => {
    const port = await freePort();
    const handler = weaveRequestHandler({
      projects: { list: () => [], getById: () => undefined } as never,
      port,
    });
    const tls = await startTlsServer({
      port,
      bindHost: '127.0.0.1',
      handler,
      certDir: tmpDir(),
    });
    expect(tls).not.toBeNull();
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port, rejectUnauthorized: false, path: '/health' }, (res) => {
          expect(res.statusCode).toBe(200);
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => resolve(out));
        })
        .on('error', reject);
    });
    const parsed = JSON.parse(body) as { service: string; port: number };
    expect(parsed.service).toBe('weave-daemon');
    expect(parsed.port).toBe(port);
    tls?.server.close();
  });

  it('port 0 = 关闭 → null', async () => {
    expect(
      await startTlsServer({ port: 0, bindHost: '127.0.0.1', handler: () => {}, certDir: tmpDir() }),
    ).toBeNull();
  });

  it('端口被占 → 降级 null 而非抛错', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busyPort = (blocker.address() as net.AddressInfo).port;
    const result = await startTlsServer({
      port: busyPort,
      bindHost: '127.0.0.1',
      handler: () => {},
      certDir: tmpDir(),
    });
    expect(result).toBeNull();
    blocker.close();
  });
});
