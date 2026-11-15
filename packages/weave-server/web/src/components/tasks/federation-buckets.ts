import type { PeerSessionsView } from '@/lib/api';

/**
 * 联邦对端账在选择器里的形状：peer 名 + 在线态 + 对端会话账（`#` 选择器联邦
 * 分组与未来其他输入面共用；数据源 = GET /federation/peers/:id/sessions 代理）。
 */
export interface FederatedPeerBucket {
  peerId: string;
  peerName: string;
  online: boolean;
  sessions: PeerSessionsView['sessions'];
}
