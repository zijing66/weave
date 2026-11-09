import { TILE_TYPES, type Hotspot, type TileMap, hitTest } from './worldmap';

/**
 * G4 行走核心（纯函数，零 React）：格子步进（红白机手感 = 离散格，不插值）。
 * 输入 = 当前格 + 方向 + tilemap，输出 = 下一格或拒绝（null）；热点触发是纯
 * 查询（走到即触发），渲染层把两个入口（键盘/虚拟方向键、点击热点）都收敛到
 * `resolveStep` + `triggerHotspotAt` 一处——引擎裁决（设计 G4）：CSS 离散步进
 * 满足手感，不引 canvas（证据：transform 直改一步一格，无逐帧重绘路径）。
 */

export type { TileMap };

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface Cell {
  x: number;
  y: number;
}

/** 方向步进向量（上下左右各一格）。 */
export const DIR_DELTA: Record<Dir, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** 目标格越界或 solid（TILE_TYPES 词表判据）= 不可走，返回 null。 */
export function canWalk(map: TileMap, x: number, y: number): boolean {
  if (y < 0 || y >= map.length) return false;
  const row = map[y]!;
  if (x < 0 || x >= row.length) return false;
  return TILE_TYPES[row[x]!]?.solid !== true;
}

/** 行走裁决：从 from 向 dir 走一步 → 下一格；撞墙/越界拒绝返回 null。 */
export function resolveStep(map: TileMap, from: Cell, dir: Dir): Cell | null {
  const d = DIR_DELTA[dir];
  const nx = from.x + d.x;
  const ny = from.y + d.y;
  return canWalk(map, nx, ny) ? { x: nx, y: ny } : null;
}

/**
 * 热点触发（纯查询）：化身脚下的格是否落在某热点矩形内——走到热点格触发与
 * 点击热点同归 hitTest 一处（双通道，G4 不砍点按）。化身占 1×2（脚格 =
 * (x, y+1)，与 CharacterSprite 摆位一致），两格都参与判定。
 */
export function triggerHotspotAt(
  hotspots: readonly Hotspot[],
  pos: Cell,
): Hotspot | null {
  return hitTest(hotspots, pos.x, pos.y) ?? hitTest(hotspots, pos.x, pos.y + 1);
}

/**
 * 镜头裁决（纯函数）：地图比视口大时镜头跟随化身（居中偏置，贴边钳制）；
 * 装得下锁定全图（offset 0）。视口尺寸未知（SSR/未布局）回落 0。
 */
export function cameraOffset(
  map: TileMap,
  pos: Cell,
  viewW: number,
  viewH: number,
  tilePx: number,
): Cell {
  const worldW = (map[0]?.length ?? 0) * tilePx;
  const worldH = map.length * tilePx;
  const cx = pos.x * tilePx + tilePx / 2;
  const cy = (pos.y + 1) * tilePx; // 1×2 化身脚底
  const x = viewW <= 0 || viewW >= worldW ? 0 : Math.max(0, Math.min(worldW - viewW, cx - viewW / 2));
  const y = viewH <= 0 || viewH >= worldH ? 0 : Math.max(0, Math.min(worldH - viewH, cy - viewH / 2));
  return { x: Math.round(x), y: Math.round(y) };
}
