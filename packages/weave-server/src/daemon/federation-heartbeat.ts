import type { PeerRepository } from '../repositories/peers.js';
import { readPeerToken } from './peer-tokens.js';
import { tokenFileOf } from '../repositories/peers.js';
import { HEARTBEAT_INTERVAL_MS } from './federation.js';
import { peerRequest, peerEndpointOf } from './federation-client.js';

/**
 * 心跳出站（F1）：30s 定时器对 enabled 且有 token 的 peers 发对端
 * `POST /federation/heartbeat`（带 per-peer token）。失败不重试不报警——
 * 对端离不在线由**入站侧**判（peerLiveness 90s 窗：本机发不出心跳，对端
 * lastSeenAt 停走，90s 后自己落 offline）。federation.enabled 关 = 定时器
 * 不起（关联邦 = 零网络活动，裁决红线）。
 */
export interface FederationHeartbeat {
  stop: () => void;
}

export function startFederationHeartbeat(opts: {
  peers: PeerRepository;
  tokenDir: string | undefined;
  /** 出站实现（测试注入）；缺省 federation-client 的 https+TOFU 通道。 */
  requestImpl?: typeof peerRequest;
  intervalMs?: number;
}): FederationHeartbeat {
  const request = opts.requestImpl ?? peerRequest;
  const interval = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;

  const beat = async (): Promise<void> => {
    const peers = opts.peers.list().filter((p) => p.enabled);
    for (const peer of peers) {
      const token = opts.tokenDir
        ? readPeerToken(opts.tokenDir, peer.id, tokenFileOf)?.token
        : undefined;
      if (!token) continue; // 没 token = 没配对完成，出不了站
      const endpoint = peerEndpointOf(peer);
      if (!endpoint) continue; // port 0 = 手动建行还没填端口
      try {
        await request(endpoint, {
          method: 'POST',
          path: '/federation/heartbeat',
          body: { token },
        });
      } catch {
        // 出站失败静默：入站侧 90s 窗自会判 offline（不双记状态）
      }
    }
  };

  const timer = setInterval(() => void beat(), interval);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}
