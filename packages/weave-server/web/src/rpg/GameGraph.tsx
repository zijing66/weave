import { useMemo } from 'react';
import { mergeOrchestrations } from '@/components/tasks/orchestration-graph';
import { layoutOrchestrationLR } from '@/components/tasks/orchestration-lr-layout';
import { PALETTE32 } from './skin';
import type { OrchestrationRow, SessionRow } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';

/**
 * 游戏视角 LR 有向图（D1 验收判据 ③）：复用 B3 布局纯函数
 * `layoutOrchestrationLR` + 像素皮肤层——同一份拓扑分层，节点画成 32 色板
 * 色块的「营地」标记（session=营地、webhook=烽火台、trigger=令旗），边 =
 * 像素虚线。只读总览（编辑面在编排卡片），会话节点带点击进会话详情。
 */

const TILE = 8;
const NODE_W = 26 * TILE;
const NODE_H = 10 * TILE;

export function GameGraph({
  orchestrations,
  sessionById,
  onOpenSession,
}: {
  orchestrations: readonly OrchestrationRow[] | null;
  sessionById: ReadonlyMap<string, SessionRow>;
  onOpenSession: (sessionId: string) => void;
}) {
  const t = useT();
  const graph = useMemo(() => {
    if (!orchestrations || orchestrations.length === 0) return null;
    const merged = mergeOrchestrations(
      orchestrations.map((o) => ({ orchId: o.id, nodes: o.nodes, edges: o.edges })),
    );
    const sessionNodes = merged.nodes.filter((n) => n.kind === 'session');
    const lr = layoutOrchestrationLR(sessionNodes, merged.edges);
    return { merged, lr };
  }, [orchestrations]);

  if (!graph) return null;
  const { merged, lr } = graph;
  const width = (lr.maxRank + 1) * 392 + 64;
  const height = Math.max(1, ...[...lr.positions.values()].map((p) => p.y)) + NODE_H + 64;
  const posOf = (id: string) => lr.positions.get(id);
  const labelOf = (id: string) => sessionById.get(id)?.title ?? id;

  return (
    <div className="overflow-auto rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-4">
      <svg width={width} height={height} className="rpg-sprite">
        {/* 边 = 像素虚线 */}
        {merged.edges.map((e) => {
          const a = posOf(e.from);
          const b = posOf(e.to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mx = (x1 + x2) / 2;
          return (
            <path
              key={`${e.from}->${e.to}`}
              d={`M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`}
              fill="none"
              stroke={PALETTE32.shadow}
              strokeWidth={3}
              strokeDasharray="6 6"
            />
          );
        })}
        {/* 节点 = 营地色块 */}
        {merged.nodes.map((n) => {
          const p = posOf(n.id);
          if (!p) return null;
          const isSession = n.kind === 'session';
          const fill = n.kind === 'trigger' ? PALETTE32.spark : n.kind === 'webhook' ? PALETTE32.lake : PALETTE32.jade;
          return (
            <g
              key={n.id}
              className={isSession ? 'cursor-pointer' : undefined}
              onClick={isSession ? () => onOpenSession(n.id) : undefined}
            >
              <rect
                x={p.x}
                y={p.y}
                width={NODE_W}
                height={NODE_H}
                fill={fill}
                stroke={PALETTE32.ink}
                strokeWidth={3}
              />
              <text
                x={p.x + 8}
                y={p.y + NODE_H / 2 + 5}
                fontSize={13}
                fontFamily="monospace"
                fill={PALETTE32.ink}
              >
                {isSession ? labelOf(n.id) : n.kind === 'webhook' ? t('rpg.boardTitle') + '·webhook' : 'trigger'}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
