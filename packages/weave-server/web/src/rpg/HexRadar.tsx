import { useMemo } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { PALETTE32 } from './skin';

/**
 * 六维雷达图（weaveRPG.md 第五章 UI 规格）：96×96 px 基准、六边形网格 3 层、
 * 网格线 1 px、数据面 1 px 阶梯边；六轴顺序固定：力量、智慧、敏捷、速度、
 * 内力、运气。整数倍缩放（`size` 为基准倍数）+ pixelated。
 */

export const HEX_RADAR_DIMS = ['力量', '智慧', '敏捷', '速度', '内力', '运气'] as const;
export type HexRadarDim = (typeof HEX_RADAR_DIMS)[number];

const BASE = 96;
const CX = BASE / 2;
const CY = BASE / 2;
const R = 38;

function vertex(dimIndex: number, value01: number): [number, number] {
  const angle = (Math.PI / 3) * dimIndex - Math.PI / 2;
  const r = R * value01;
  return [CX + r * Math.cos(angle), CY + r * Math.sin(angle)];
}

function polygonOf(values: readonly number[]): string {
  return values.map((v, i) => vertex(i, v).map((n) => n.toFixed(1)).join(',')).join(' ');
}

export function HexRadar({
  dims,
  bonus,
  scale = 1,
}: {
  /** 六维终值（基线 + 修正）。 */
  dims: Record<string, number> | import('@/lib/api').RpgHexagon;
  /** 实战修正量（有则把修正段画成亮点弧——用户看得出哪维是修出来的）。 */
  bonus?: Record<string, number> | null;
  /** 整数倍缩放（1 = 96px 基准）。 */
  scale?: number;
}) {
  const t = useT();
  const maxDim = useMemo(
    () => Math.max(1, ...Object.values(dims), ...Object.values(bonus ?? {})),
    [dims, bonus],
  );
  const cap = Math.max(10, Math.ceil(maxDim));

  return (
    <svg
      width={BASE * scale}
      height={BASE * scale}
      viewBox={`0 0 ${BASE} ${BASE}`}
      style={{ imageRendering: 'pixelated' }}
      role="img"
      aria-label={t('rpg.hexagon')}
    >
      {/* 网格 3 层 */}
      {[1 / 3, 2 / 3, 1].map((f) => (
        <polygon
          key={f}
          points={polygonOf(HEX_RADAR_DIMS.map(() => f))}
          fill="none"
          stroke={PALETTE32.mist}
          strokeWidth={1}
        />
      ))}
      {/* 轴线 */}
      {HEX_RADAR_DIMS.map((_, i) => {
        const [x, y] = vertex(i, 1);
        return <line key={i} x1={CX} y1={CY} x2={x} y2={y} stroke={PALETTE32.mist} strokeWidth={1} />;
      })}
      {/* 数据面 */}
      <polygon
        points={polygonOf(HEX_RADAR_DIMS.map((d) => Math.min(1, (dims[d] ?? 0) / cap)))}
        fill={PALETTE32.indigo}
        fillOpacity={0.45}
        stroke={PALETTE32.gold}
        strokeWidth={1}
      />
      {/* 轴标签（8px 字高基准） */}
      {HEX_RADAR_DIMS.map((d, i) => {
        const [x, y] = vertex(i, 1.22);
        return (
          <text
            key={d}
            x={x}
            y={y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={8}
            fill={PALETTE32.paper}
          >
            {t(`rpg.dim.${d}` as `rpg.dim.${HexRadarDim}`)}
          </text>
        );
      })}
    </svg>
  );
}
