import { useBackPop } from '@/lib/back-pop';
import { useT } from '@/i18n/I18nProvider';
import type { PeerRow, PeerSessionsView } from '@/lib/api';
import { useEffect } from 'react';
import { livenessOf } from './peer-faces';

/**
 * G5 联机席位 · 世界场景客席区（对等上帝 + 来访 NPC，只读）：消费 F1/F2 面
 * ——peers 注册表判在线（90s 心跳窗）、F2 只读 sessions 代理看对端会话。
 * 「跨机原语重放」的落点 = 来访 NPC 的状态徽章：对端回合在跑（turnOpen）就在
 * 我方世界重放为「作战中」帧——写操作永远落本机（rpg.crossReadonly 口径）。
 */

/** 对等上帝席位行：enabled + 在线的 peer 一席，至多 peerGodSeatSpot 槽位数。 */
export function peerSeatRowsOf(peers: readonly PeerRow[]): Array<{ peer: PeerRow; spotIndex: number }> {
  const out: Array<{ peer: PeerRow; spotIndex: number }> = [];
  for (const p of peers) {
    if (!p.enabled || !livenessOf(p.lastSeenAt)) continue;
    if (out.length >= 8) break; // 槽位上限（13 + 8*3 = 37 ≤ 38）
    out.push({ peer: p, spotIndex: out.length });
  }
  return out;
}

/** 来访 NPC 行：在线 peer 的远端会话（该机器上真在跑的 agent），每 peer 上限
 *  3、总槽位由 visitorNpcSpot 预算截断。代理不可达的 peer 如实缺席。 */
export function visitorRowsOf(
  peers: readonly PeerRow[],
  views: ReadonlyMap<string, PeerSessionsView>,
  maxPerPeer = 3,
): Array<{
  peer: PeerRow;
  sessionId: string;
  title: string | null;
  turnOpen: boolean | null;
  spotIndex: number;
}> {
  const out: Array<{
    peer: PeerRow;
    sessionId: string;
    title: string | null;
    turnOpen: boolean | null;
    spotIndex: number;
  }> = [];
  for (const p of peers) {
    if (!p.enabled || !livenessOf(p.lastSeenAt)) continue;
    const view = views.get(p.id);
    if (!view) continue;
    for (const s of view.sessions.slice(0, maxPerPeer)) {
      if (out.length >= 12) break; // visitorNpcSpot 槽位预算（i ≤ 11）
      out.push({ peer: p, sessionId: s.sessionId, title: s.title, turnOpen: s.turnOpen, spotIndex: out.length });
    }
  }
  return out;
}

/** NPC 名牌短标：远端会话标题截 12 字，没标题用会话 id 前 8 位。 */
export function visitorLabelOf(row: { title: string | null; sessionId: string }): string {
  if (row.title && row.title.trim()) return row.title.trim().slice(0, 12);
  return row.sessionId.slice(0, 8);
}

/** 客席只读详情条（底部，与角色详情 HUD 同锚位）：选中的对等上帝席位或来访
 *  NPC 展开一行——机器名 / 地址 / 来源 / 远端会话账。Esc / 返回键 / ✕ 收起。 */
export function PeerSeatBar({
  peer,
  view,
  onClose,
}: {
  peer: PeerRow;
  view: PeerSessionsView | null;
  onClose: () => void;
}) {
  const t = useT();
  useBackPop(true, () => {
    onClose();
    return true;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const open = view?.sessions.filter((s) => s.turnOpen).length ?? null;
  return (
    <div className="rpg-overlay-surface absolute inset-x-2 bottom-2 z-20 flex min-h-0 items-center gap-3 overflow-x-auto rounded-lg border border-[var(--w-border)] px-3 py-2 text-xs shadow-xl">
      <button
        type="button"
        onClick={onClose}
        aria-label="close"
        className="shrink-0 rounded px-1 text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
      >
        ✕
      </button>
      <span className="shrink-0 font-semibold text-[var(--w-text)]">{peer.name}</span>
      <span className="shrink-0 text-[var(--w-text-dim)]">{`${peer.host}:${peer.port}`}</span>
      <span className="shrink-0 rounded bg-[var(--w-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--w-text-dim)]">
        {t('rpg.peerSource', { source: peer.source })}
      </span>
      {view && (
        <span className="shrink-0 text-[var(--w-text-dim)]">
          {t('rpg.peerRemoteSessions', { n: view.sessions.length })}
          {open != null && open > 0 ? ` · ${t('rpg.crossOpen', { n: open })}` : ''}
        </span>
      )}
      {view && view.sessions.length > 0 && (
        <span className="min-w-0 truncate text-[var(--w-text-dim)]">
          {visitorLabelOf({ title: view.sessions[0]!.title, sessionId: view.sessions[0]!.sessionId })}
        </span>
      )}
      <span className="ml-auto shrink-0 text-[10px] text-[var(--w-text-dim)]">{t('rpg.crossReadonly')}</span>
    </div>
  );
}
