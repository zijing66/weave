import { Bonjour } from 'bonjour-service';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WEAVE_VERSION as DAEMON_VERSION } from '../version.js';
import {
  MDNS_SERVICE_DOMAIN,
  MDNS_SERVICE_TYPE,
  advertisable,
  mdnsInstanceName,
  mdnsTxt,
} from './federation.js';

/**
 * mDNS 广播（E3）：`_weave-mcp._tcp` 服务类型，实例名带机器标识，TXT 带版本与
 * capabilities 摘要。**只广播、不接收执行**——安全面不变（对端仍要令牌），发现
 * 列表落 peer 注册表仍须 pairing。选型 `bonjour-service`：纯 JS（multicast-dns
 * 之上），零原生依赖，对齐伞包 tgz 自包含分发硬约束。
 */
export interface MdnsAdvertiser {
  stop: () => void;
}

export function startMdnsAdvertiser(opts: {
  tlsPort: number;
  httpPort: number;
  certPem: string;
  hostname: string;
}): MdnsAdvertiser | null {
  // tlsPort 未开不广播：联邦唯一形态是 HTTPS + TOFU（裁决 15⑤）。
  if (!advertisable(opts.tlsPort)) return null;
  const bonjour = new Bonjour();
  bonjour.publish({
    name: mdnsInstanceName(opts.hostname),
    type: MDNS_SERVICE_TYPE,
    protocol: MDNS_SERVICE_DOMAIN,
    port: opts.tlsPort,
    txt: mdnsTxt({
      version: DAEMON_VERSION,
      hostname: opts.hostname,
      certPem: opts.certPem,
    }),
  });
  return {
    stop: () => {
      try {
        bonjour.unpublishAll(() => {
          bonjour.destroy();
        });
      } catch {
        bonjour.destroy();
      }
    },
  };
}

// ---- 发现侧（给 F1 消费的形状垫）：本批只暴露浏览器浏览的发现列表路由 ----

/**
 * GET /federation/discover —— 本机对 LAN 的一次 mDNS 浏览快照（发现 ≠ 可用，
 * 仍须 pairing）。浏览器手动触发（发现监听是显式动作，不做常驻扫描）。
 */
export async function browseMdnsPeers(
  timeoutMs: number,
): Promise<Array<{ name: string; host: string; port: number; txt: Record<string, string> }>> {
  const bonjour = new Bonjour();
  try {
    return await new Promise((resolve) => {
      const found = new Map<string, { name: string; host: string; port: number; txt: Record<string, string> }>();
      const browser = bonjour.find({ type: MDNS_SERVICE_TYPE }, (svc: {
        name: string;
        addresses?: string[];
        host?: string;
        port: number;
        txt?: Record<string, string>;
      }) => {
        const host = svc.addresses?.[0] ?? svc.host ?? '';
        if (!host) return;
        found.set(`${host}:${svc.port}`, {
          name: svc.name,
          host,
          port: svc.port,
          txt: svc.txt ?? {},
        });
      });
      setTimeout(() => {
        browser.stop();
        bonjour.destroy();
        resolve([...found.values()]);
      }, timeoutMs);
    });
  } catch {
    bonjour.destroy();
    return [];
  }
}

/** 路由侧薄壳：GET /federation/discover（认证门内，web 手动「扫描局域网」）。 */
export async function handleDiscoverRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const peers = await browseMdnsPeers(2_000);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ peers }));
  return true;
}
