import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { FederatedPeerBucket } from './federation-buckets';

/**
 * `#` 选择器的联邦对端账：peers 清单 + 逐 peer 只读会话代理（缓存窗在服务端
 * `PEER_SESSIONS_CACHE_MS`）。对端不可达 = online:false + 空账（灰置不炸）。
 * `enabled` 由调用方控（选择器开着才拉）。
 */
export function useFederatedPeerBuckets(enabled: boolean): FederatedPeerBucket[] {
  const peersQuery = useQuery({
    queryKey: ['federation', 'peers', 'picker'],
    queryFn: () => api.listPeers(),
    enabled,
    staleTime: 30_000,
  });
  const peers = peersQuery.data?.peers ?? [];
  const sessionsQueries = useQuery({
    queryKey: ['federation', 'peer-sessions', 'picker', peers.map((p) => p.id).join(',')],
    queryFn: async (): Promise<FederatedPeerBucket[]> => {
      const buckets = await Promise.all(
        peers
          .filter((p) => p.enabled)
          .map(async (p) => {
            try {
              const view = await api.peerSessions(p.id);
              return { peerId: p.id, peerName: p.name, online: view.online, sessions: view.sessions };
            } catch {
              return { peerId: p.id, peerName: p.name, online: false, sessions: [] };
            }
          }),
      );
      return buckets;
    },
    enabled: enabled && peers.length > 0,
    staleTime: 30_000,
  });
  return sessionsQueries.data ?? [];
}
