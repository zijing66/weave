import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 双入口装配同步断言（波内教训：RPG/联邦前两波各漏过 dev 入口一次）：start.ts
 * 与 dev-entry.ts 的联邦装配必须成对出现——心跳出站的起停与 peerRoute 闭包都
 * 是「漏一边只在生产或只在 dev 生效」的哑弹，这里按源码文本锁。
 */
describe('联邦双入口装配同步（start.ts ‖ dev-entry.ts）', () => {
  const read = (f: string): string => readFileSync(path.join(import.meta.dirname, '..', f), 'utf8');

  it('心跳出站（startFederationHeartbeat + stop）两入口都在场', () => {
    for (const f of ['start.ts', 'dev-entry.ts']) {
      const src = read(f);
      expect(src, `${f} missing startFederationHeartbeat`).toContain('startFederationHeartbeat({');
      expect(src, `${f} missing heartbeat stop`).toContain('federationHeartbeat?.stop()');
      expect(src, `${f} missing FederationHeartbeat type slot`).toContain('let federationHeartbeat');
    }
  });

  it('跨机分流 peerRoute（peer: 目标路由表）两入口都在场', () => {
    for (const f of ['start.ts', 'dev-entry.ts']) {
      expect(read(f), `${f} missing peerRoute`).toContain('peerRoute: (peerName)');
    }
  });

  it('federation 数据域帧（dataBus key）在路由侧在场', () => {
    const routes = read('federation-routes.ts');
    expect(routes).toContain("dataBus?.emit({ key: 'federation' })");
  });
});
