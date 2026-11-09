import { apiFetch } from './client';

/**
 * 联邦数据面（F1 全量）：peer 注册表 + pairing 全链（含出站 initiate）+ caps 互报
 * 读取（管理侧凭证）+ 局域网发现。call 的服务门只对 per-peer token 开放——
 * 那是对端机器间的事，web 管理面不经它。
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
  /**
   * 出站 pairing（F1）：拿对端给的短码打对端 /federation/pair，收对端签发的
   * per-peer token 落本机 peer-tokens。对端 403（短码无效）→ 403；指纹 mismatch → 409。
   */
  initiatePairing: (input: { name: string; host: string; port: number; code: string; fingerprint?: string }) =>
    apiFetch<{ peer: PeerRow }>('/federation/pairing/initiate', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** LAN mDNS 浏览快照（发现 ≠ 可用，仍须 pairing）。 */
  discover: () => apiFetch<{ peers: DiscoveredPeer[] }>('/federation/discover'),
  /** 邀请发起（F2，本机协调者视角）：打对端 /federation/call 的 rpg.invite 行。 */
  sendInvitation: (input: {
    peerId: string;
    team: string;
    scene?: string;
    roles?: Array<{ role: string; module?: string }>;
    message?: string;
  }) => apiFetch<{ ok: boolean; peer: string }>('/federation/invitations/send', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  /** 受邀侧待办（HITL：接受/拒绝必须手动点）。 */
  listInvitations: () =>
    apiFetch<{ invitations: RpgInvitationView[] }>('/federation/invitations'),
  decideInvitation: (id: number, decision: 'accept' | 'decline') =>
    apiFetch<{ invitation: RpgInvitationView }>(`/federation/invitations/${id}/${decision}`, {
      method: 'POST',
    }),
  /** 对端只读 sessions 代理（F2 跨机角色卡/跨机看板的数据源）。 */
  peerSessions: (peerId: string) =>
    apiFetch<PeerSessionsView>(`/federation/peers/${encodeURIComponent(peerId)}/sessions`),
};

export interface RpgInvitationView {
  id: number;
  peerId: string;
  peerName: string | null;
  team: string;
  scene: string | null;
  roles: Array<{ role: string; module?: string }> | null;
  message: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  decidedBy: string | null;
  provenance: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface PeerSessionsView {
  peer: string;
  online: boolean;
  sessions: Array<{
    sessionId: string;
    title: string | null;
    harness: string | null;
    turnOpen: boolean | null;
    lastSeenAt: string | null;
  }>;
}

export interface FederationCaps {
  hostname: string;
  fingerprint: string | null;
  services: Array<{ service: string; effect: 'readonly' | 'delivering'; description: string }>;
}

/** 本机外露服务表（对端经 per-peer token 读同一形状；管理面直读作展示用）。 */
export const capsApi = {
  own: () => apiFetch<FederationCaps>('/federation/caps'),
};
