import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from 'selfsigned';
import { accessUrls, createDaemonServer, ensureDaemonCert, installCertTrust, lanIps } from '../tls.js';
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
    // sha256 显式给（selfsigned 缺省 sha1，Chromium 判 ERR_CERT_INVALID）：
    // DER 里算法 OID 是 1.2.840.113549.1.1.11（sha256WithRSAEncryption）；
    // sha1 是 1.2.840.113549.1.1.5。比对 PEM 解码后的 OID 首部。
    const der = Buffer.from(cert.cert.replace(/-----[^-]+-----/g, ''), 'base64');
    expect(der.includes(Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]))).toBe(true);
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

  it('签出来的是可当信任锚的 CA 证书（手机装 CA 槽位要 basicConstraints CA:true）', async () => {
    const dir = tmpDir();
    const cert = await ensureDaemonCert(dir, { ips: ['127.0.0.1'] });
    const x509 = new X509Certificate(cert.cert);
    expect(x509.ca).toBe(true);
    expect(x509.keyUsage).toEqual(expect.arrayContaining(['1.3.6.1.5.5.7.3.1'])); // serverAuth
  });

  it('存量 CA:false 的叶子证书 → 重签成 CA 证书', async () => {
    const dir = tmpDir();
    const legacy = await generate([{ name: 'commonName', value: 'weave-daemon' }], {
      keySize: 2048,
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }],
    });
    expect(new X509Certificate(legacy.cert).ca).toBe(false);
    writeFileSync(path.join(dir, 'host.key'), legacy.private);
    writeFileSync(path.join(dir, 'host.crt'), legacy.cert);
    const renewed = await ensureDaemonCert(dir, { ips: ['127.0.0.1'] });
    expect(renewed.cert).not.toBe(legacy.cert);
    expect(new X509Certificate(renewed.cert).ca).toBe(true);
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
  it('单端口 HTTPS：localhost + 每个局域网 IP 各一条（2026-11-23 HTTP 下线）', () => {
    const ips = lanIps();
    const urls = accessUrls(6420);
    expect(urls[0]).toEqual({ url: 'https://localhost:6420', protocol: 'https', scope: 'local' });
    expect(urls.every((u) => u.protocol === 'https')).toBe(true);
    for (const ip of ips) {
      expect(urls.some((u) => u.url === `https://${ip}:6420`)).toBe(true);
    }
    expect(urls).toHaveLength(1 + ips.length);
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

describe('createDaemonServer', () => {
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

  it('唯一网络面：https 请求（忽略自签）打穿 /health', async () => {
    const port = await freePort();
    const handler = weaveRequestHandler({
      projects: { list: () => [], getById: () => undefined } as never,
      port,
    });
    const server = await createDaemonServer(handler, { certDir: tmpDir() });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
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
    server.close();
  });

  it('/cert 出服务器证书本体（手机装锚用），没证书时 404', async () => {
    const port = await freePort();
    const { cert } = await ensureDaemonCert(tmpDir(), { ips: ['127.0.0.1'] });
    const handler = weaveRequestHandler({
      projects: { list: () => [], getById: () => undefined } as never,
      port,
      ownCertPem: cert,
    });
    const server = await createDaemonServer(handler, { certDir: tmpDir() });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const res = await new Promise<{ status: number | undefined; type?: string; disp?: string; body: string }>(
      (resolve, reject) => {
        https
          .get({ host: '127.0.0.1', port, rejectUnauthorized: false, path: '/cert' }, (r) => {
            let out = '';
            r.on('data', (c) => (out += c));
            r.on('end', () =>
              resolve({
                status: r.statusCode,
                type: r.headers['content-type'],
                disp: r.headers['content-disposition'] as string | undefined,
                body: out,
              }),
            );
          })
          .on('error', reject);
      },
    );
    expect(res.status).toBe(200);
    expect(res.type).toBe('application/x-x509-ca-cert');
    expect(res.disp).toContain('weave-daemon.crt');
    expect(res.body).toBe(cert);
    server.close();

    // 没配证书（老装配）→ 404，不给空文件
    const port2 = await freePort();
    const bare = weaveRequestHandler({
      projects: { list: () => [], getById: () => undefined } as never,
      port: port2,
    });
    const server2 = await createDaemonServer(bare, { certDir: tmpDir() });
    await new Promise<void>((resolve) => server2.listen(port2, '127.0.0.1', resolve));
    const status = await new Promise<number | undefined>((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port: port2, rejectUnauthorized: false, path: '/cert' }, (r) => {
          r.resume();
          r.on('end', () => resolve(r.statusCode));
        })
        .on('error', reject);
    });
    expect(status).toBe(404);
    server2.close();
  });
});

describe('installCertTrust', () => {
  // 注入 runner：测试绝不真跑 certutil/security（那会弹系统授权框并改本机信任库）。
  const fakeRunner = (codes: Array<number | null>) => {
    const calls: string[][] = [];
    const run = async (spec: { cmd: string; args: string[] }): Promise<number | null> => {
      calls.push([spec.cmd, ...spec.args]);
      return codes.shift() ?? 0;
    };
    return { calls, run };
  };

  it('首次：探测未命中 → 安装一次 → 写指纹标记；同证书再调直接跳过', async () => {
    const dir = tmpDir();
    const { cert } = await ensureDaemonCert(dir, { ips: ['127.0.0.1'] });
    const certPath = path.join(dir, 'host.crt');
    const { calls, run } = fakeRunner([1, 0]); // 探测说未信任，安装成功
    await installCertTrust(certPath, dir, { run, platform: 'win32' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.join(' ')).toContain('-verifystore');
    expect(calls[1]!.join(' ')).toContain('-addstore');
    const marker = readFileSync(path.join(dir, 'trust-installed'), 'utf8');
    expect(marker.trim()).toBe(new X509Certificate(cert).fingerprint256);

    const again = fakeRunner([1, 0]);
    await installCertTrust(certPath, dir, { run: again.run, platform: 'win32' });
    expect(again.calls).toHaveLength(0); // 标记命中：一个命令都不跑
  });

  it('探测说已信任 → 不装，只补标记（授权框只在首次）', async () => {
    const dir = tmpDir();
    await ensureDaemonCert(dir, { ips: ['127.0.0.1'] });
    const certPath = path.join(dir, 'host.crt');
    const { calls, run } = fakeRunner([0]);
    await installCertTrust(certPath, dir, { run, platform: 'darwin' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['security', 'verify-cert', '-c', certPath, '-p', 'ssl']);
    expect(readFileSync(path.join(dir, 'trust-installed'), 'utf8').trim()).not.toBe('');
  });

  it('安装失败 → 不写标记（下次还会再试一次）', async () => {
    const dir = tmpDir();
    await ensureDaemonCert(dir, { ips: ['127.0.0.1'] });
    const certPath = path.join(dir, 'host.crt');
    const { run } = fakeRunner([1, 1]);
    await installCertTrust(certPath, dir, { run, platform: 'linux' });
    expect(existsSync(path.join(dir, 'trust-installed'))).toBe(false);
  });
});
