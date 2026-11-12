import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { api, type PeerRow, type PeerSessionsView } from '@/lib/api';
import { registerInvalidator } from '@/lib/sse';
import { useEffect } from 'react';
import { CharacterSprite, spriteSeedOf } from './CharacterSprite';

/**
 * F2 跨机面（CollabScene 的两块新增卡）：peer 角色行（来源徽章 + 远端状态，只读）
 * 与跨机看板（本机 + 已配对在线 peers 的 run 概况合并——每台机只展示、不互写）。
 * 数据全走对端 sessions.list 只读代理（30s 服务端缓存 + federation 帧失效），
 * 点击不跳本地会话（没有本地会话可跳——如实不摆详情链接）。
 */

/** 对端机器清单（在线态随行；federation 帧失效重拉）。世界场景客席区（G5）
 *  与协同视图跨机面共用同一查询域。 */
export function usePeers() {
  const peers = useQuery({
    queryKey: ['fed-peers-rpg'],
    queryFn: () => api.listPeers(),
    staleTime: 30_000,
  });
  useEffect(() => registerInvalidator('federation', () => void peers.refetch()), [peers]);
  return (peers.data?.peers ?? []) as PeerRow[];
}

function usePeerSessions(peerId: string | null, online: boolean) {
  const q = useQuery({
    queryKey: ['fed-peer-sessions', peerId],
    queryFn: () => api.peerSessions(peerId!),
    enabled: peerId != null && online,
    staleTime: 20_000,
  });
  useEffect(() => registerInvalidator('federation', () => void q.refetch()), [q]);
  return q.data ?? null;
}

/** 在线判据（与 server peerLiveness 同口径：90s 心跳窗）。 */
export function livenessOf(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  const at = Date.parse(lastSeenAt);
  return Number.isFinite(at) && Date.now() - at <= 90_000;
}

/** 导出测试缝（纯函数）：peer 行 → 角色卡的展示过滤与摘要。 */
export const peerFacesTest = {
  livenessOf,
  /** 角色卡可见性：enabled + 在线 + 有会话（无会话 = 不摆空壳）。 */
  cardVisible(peer: { enabled: boolean; lastSeenAt: string | null }, view: PeerSessionsView | null): boolean {
    return peer.enabled && livenessOf(peer.lastSeenAt) && view != null && view.sessions.length > 0;
  },
  /** 跨机看板行摘要：open 会话计数（turnOpen）。 */
  openCount(view: PeerSessionsView): number {
    return view.sessions.filter((s) => s.turnOpen).length;
  },
};

/** peer 角色卡阵（混入本地角色阵之后的那一段）：只摆已配对在线、有会话的机器。 */
export function PeerRoleCards() {
  const peers = usePeers().filter((p) => p.enabled && livenessOf(p.lastSeenAt));
  if (peers.length === 0) return null;
  return (
    <>
      {peers.map((p) => (
        <PeerRoleCard key={p.id} peerId={p.id} peerName={p.name} />
      ))}
    </>
  );
}

function PeerRoleCard({ peerId, peerName }: { peerId: string; peerName: string }) {
  const t = useT();
  const view = usePeerSessions(peerId, true) as PeerSessionsView | null;
  if (!view || view.sessions.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-1" title={`${t('rpg.peerRoleBadge')}: ${peerName}`}>
      <div className="opacity-90">
        <CharacterSprite
          archetype="适配"
          status="idle"
          size={3}
          gender={spriteSeedOf(peerId) % 2 ? 'female' : 'male'}
          appearanceSeed={spriteSeedOf(peerId)}
        />
      </div>
      <span className="max-w-36 truncate text-sm font-medium">{peerName}</span>
      <span className="rounded bg-[var(--w-surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--w-text-dim)]">
        {t('rpg.peerRoleBadge')} · {view.sessions.length}
      </span>
      <span className="max-w-36 truncate text-[10px] text-[var(--w-text-dim)]">
        {view.sessions[0]!.title ?? view.sessions[0]!.sessionId.slice(0, 8)}
      </span>
    </div>
  );
}

/** 跨机看板卡（只摆有数据）：本机 run 概况 + 各在线 peer 的会话账（只读聚合）。 */
export function CrossMachineBoard({ localRuns }: { localRuns: number | null }) {
  const t = useT();
  const peers = usePeers().filter((p) => p.enabled);
  const online = peers.filter((p) => livenessOf(p.lastSeenAt));
  const views = usePeerSessionsMulti(online.map((p) => ({ id: p.id, name: p.name })));
  // 只摆有数据：没有任何 peer 视图且本机也无 run → 不渲染。
  if (online.length === 0 && (localRuns == null || localRuns === 0)) return null;
  return (
    <section className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-[var(--w-text-dim)]">
        {t('rpg.crossBoard')}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {localRuns != null && localRuns > 0 && (
          <span className="rounded bg-[var(--w-surface-2)] px-2 py-1">
            {t('rpg.crossLocal')} · {localRuns}
          </span>
        )}
        {online.map((p) => {
          const v = views.get(p.id);
          if (!v || v.sessions.length === 0) return null;
          const open = v.sessions.filter((s) => s.turnOpen).length;
          return (
            <span key={p.id} className="rounded bg-[var(--w-surface-2)] px-2 py-1" title={t('rpg.crossReadonly')}>
              {p.name} · {v.sessions.length}
              {open > 0 ? ` · ${t('rpg.crossOpen', { n: open })}` : ''}
            </span>
          );
        })}
      </div>
      <p className="mt-1.5 text-[10px] text-[var(--w-text-dim)]">{t('rpg.crossReadonly')}</p>
    </section>
  );
}

export function usePeerSessionsMulti(peers: Array<{ id: string; name: string }>) {
  const q = useQuery({
    queryKey: ['fed-peer-sessions-multi', peers.map((p) => p.id).join(',')],
    queryFn: async () => {
      const out = new Map<string, PeerSessionsView>();
      await Promise.all(
        peers.map(async (p) => {
          try {
            out.set(p.id, await api.peerSessions(p.id));
          } catch {
            /* 对端不可达：如实缺席（不摆空壳） */
          }
        }),
      );
      return out;
    },
    enabled: peers.length > 0,
    staleTime: 20_000,
  });
  useEffect(() => registerInvalidator('federation', () => void q.refetch()), [q]);
  return q.data ?? new Map<string, PeerSessionsView>();
}
