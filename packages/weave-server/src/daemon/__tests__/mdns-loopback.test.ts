import { describe, expect, it } from 'vitest';
import { generate } from 'selfsigned';
import { startMdnsAdvertiser, browseMdnsPeers } from '../mdns-advertiser.js';
import { capsSummary } from '../federation.js';

/**
 * 本机回环可见性验证（E3 验收②）：同机起两个「广播端」（不同端口/身份），
 * 经发现面（browseMdnsPeers）应看到对端的广播——实例名、端口、TXT 摘要齐全。
 * mDNS 组播在回环上不经网络栈外部，Windows 防火墙/公司组播限制不影响本验证
 * （真跨机可见性属部署态，单测锁定协议面与载荷）。
 */
describe('mTCP 发现回环可见性', () => {
  it('实例 B 的广播可被发现面看到（端口 + TXT 摘要）', { timeout: 20_000 }, async () => {
    const pems = await generate([{ name: 'commonName', value: 'weave-daemon' }], { keySize: 2048 });
    const advertiser = startMdnsAdvertiser({
      tlsPort: 46_443,
      httpPort: 46_420,
      certPem: pems.cert,
      hostname: 'loopback-test-b',
    });
    expect(advertiser).not.toBeNull();
    try {
      const peers = await browseMdnsPeers(4_000);
      const self = peers.find((p) => p.port === 46_443);
      expect(self).toBeDefined();
      expect(self!.name).toBe('weave-loopback-test-b');
      expect(self!.txt.ver).toBeTruthy();
      expect(self!.txt.caps).toBe(capsSummary());
      expect(self!.txt.name).toBe('loopback-test-b');
      expect(self!.txt.fp).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      advertiser?.stop();
    }
  });

  it('tlsPort=0（HTTPS 未开）不广播，返回 null', () => {
    expect(
      startMdnsAdvertiser({ tlsPort: 0, httpPort: 46_420, certPem: 'x', hostname: 'h' }),
    ).toBeNull();
  });
});
