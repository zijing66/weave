import { describe, expect, it } from 'vitest';
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import { generate } from 'selfsigned';
import {
  MDNS_SERVICE_TYPE,
  OFFLINE_AFTER_MS,
  PAIRING_CODE_TTL_MS,
  advertisable,
  certFingerprint,
  consumeOffer,
  createOffer,
  capsSummary,
  mdnsInstanceName,
  mdnsTxt,
  peerLiveness,
  tofuVerdict,
} from '../federation.js';

describe('mDNS 广播载荷', () => {
  it('服务类型 = _weave-fed._tcp；TXT 带版本/caps/机器名/指纹前 16 hex', async () => {
    const pems = await generate([{ name: 'commonName', value: 'weave-daemon' }], { keySize: 2048 });
    const txt = mdnsTxt({ version: '0.1.10', hostname: 'DESKTOP-ABC123', certPem: pems.cert });
    expect(MDNS_SERVICE_TYPE).toBe('weave-fed');
    expect(txt.ver).toBe('0.1.10');
    // F1 起 caps = 外露服务表摘要短码（不再是恒 'mcp'）
    expect(txt.caps).toBe(capsSummary());
    expect(txt.caps).toMatch(/^[0-9a-f]{16}$/);
    expect(txt.name).toBe('DESKTOP-ABC123');
    expect(txt.fp).toMatch(/^[0-9a-f]{16}$/);
    // fp 与证书真实指纹前 16 位一致
    const cert = new X509Certificate(pems.cert);
    expect(txt.fp).toBe(cert.fingerprint256.replace(/:/g, '').toLowerCase().slice(0, 16));
  });

  it('实例名：非法字符压成 -，截 63，去尾 -', () => {
    expect(mdnsInstanceName('DESKTOP-ABC123')).toBe('weave-DESKTOP-ABC123');
    expect(mdnsInstanceName('主机 名!')).toMatch(/^weave-[\w-]{1,63}$/);
    expect(mdnsInstanceName('x'.repeat(80))).toHaveLength(63);
  });

  it('advertisable：tlsPort 开着才广播（HTTPS + TOFU 唯一形态）', () => {
    expect(advertisable(6443)).toBe(true);
    expect(advertisable(0)).toBe(false);
    expect(advertisable(undefined)).toBe(false);
  });
});

describe('TOFU 指纹对齐（纯函数，F1 消费）', () => {
  const fpPromise = generate([{ name: 'commonName', value: 'weave-daemon' }], { keySize: 2048 });

  it('指纹 = SHA-256(cert.raw) hex；坏 PEM 返回 null', async () => {
    const pems = await fpPromise;
    const fp = certFingerprint(pems.cert)!;
    const cert = new X509Certificate(pems.cert);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(certFingerprint('not a pem')).toBeNull();
  });

  it('首见 = first-use；等值 = match；不等 = mismatch（大小写不敏感）', async () => {
    const fp = certFingerprint((await fpPromise).cert)!;
    expect(tofuVerdict(null, fp)).toBe('first-use');
    expect(tofuVerdict(undefined, fp)).toBe('first-use');
    expect(tofuVerdict(fp, fp)).toBe('match');
    expect(tofuVerdict(fp.toUpperCase(), fp)).toBe('match');
    expect(tofuVerdict('a'.repeat(64), fp)).toBe('mismatch');
  });
});

describe('pairing 状态机', () => {
  const now = 1_000_000_000_000;

  it('要约：6 位短码 + 有效期；过期/核销后不再放行', () => {
    let call = 0;
    const session = createOffer({
      fingerprint: 'f'.repeat(64),
      hostname: 'host-a',
      now,
      random: () => '123456',
    });
    expect(session.offer.code).toMatch(/^\d{6}$/);
    expect(session.offer.expiresAt).toBe(now + PAIRING_CODE_TTL_MS);
    expect(consumeOffer(session, '123456', now)).toBe(true);
    expect(consumeOffer(session, '123456', now)).toBe(false); // 已核销
  });

  it('短码错 / 过期都不放行', () => {
    const session = createOffer({ fingerprint: 'f'.repeat(64), hostname: 'h', now, random: () => '000000' });
    expect(consumeOffer(session, '111111', now)).toBe(false);
    const stale = createOffer({ fingerprint: 'f'.repeat(64), hostname: 'h', now, random: () => '000000' });
    expect(consumeOffer(stale, '000000', now + PAIRING_CODE_TTL_MS + 1)).toBe(false);
  });
});

describe('心跳判离线（30s 心跳 / 90s 判离线）', () => {
  const now = 1_000_000_000_000;

  it('从无心跳 = never-seen；90s 内 = online；超窗 = offline', () => {
    expect(peerLiveness(null, now)).toBe('never-seen');
    expect(peerLiveness('bad-date', now)).toBe('never-seen');
    expect(
      peerLiveness(new Date(now - OFFLINE_AFTER_MS).toISOString(), now),
    ).toBe('online');
    expect(
      peerLiveness(new Date(now - OFFLINE_AFTER_MS - 1).toISOString(), now),
    ).toBe('offline');
  });

  it('判离线窗口恰为 90s（裁决 15⑥）', () => {
    expect(OFFLINE_AFTER_MS).toBe(90_000);
  });
});
