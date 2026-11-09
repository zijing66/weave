import { apiFetch } from './client';

/**
 * 联邦数据面（E3 最小面）：peer 注册表 + pairing + 局域网发现。
 * `/federation/call`、`/federation/caps`、`/federation/invite` 是 F1 的门——本批没有。
 */
export interface PeerRow {
  id: string;
  name: string;
  host: string;
  port: number;
  /** 对端证书指纹（TOFU）；null = 未对齐过。 */
  fingerprint: string | null;
  source: 'manual' | 'mdns' | 'pairing';
  lastSeenAt: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface DiscoveredPeer {
  name: string;
  host: string;
  port: number;
  txt: Record<string, string>;
}

export interface PairingOfferResult {
  code: string;
  expiresAt: number;
}

export const federationApi = {
  listPeers: () => apiFetch<{ peers: PeerRow[] }>('/federation/peers'),
  createPeer: (input: { name: string; host: string; port: number; fingerprint?: string }) =>
    apiFetch<{ peer: PeerRow }>('/federation/peers', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updatePeer: (id: string, patch: Partial<{ name: string; host: string; port: number; enabled: boolean }>) =>
    apiFetch<{ peer: PeerRow }>(`/federation/peers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deletePeer: (id: string) =>
    apiFetch<{ ok: boolean }>(`/federation/peers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /** 生成本批短码要约（人工把短码交给对端 / 在对端 dashboard 输入）。 */
  createPairingOffer: () =>
    apiFetch<PairingOfferResult>('/federation/pairing/offer', { method: 'POST' }),
  /** LAN mDNS 浏览快照（发现 ≠ 可用，仍须 pairing）。 */
  discover: () => apiFetch<{ peers: DiscoveredPeer[] }>('/federation/discover'),
};
