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
 * 热点触发（纯查询）：化身**脚格**（(x, y+1)——G2.6 复测裁决：交互判定一律
 * 以脚格为准，不是 1×2 全身覆盖）是否落在某热点矩形内——走到热点格触发与
 * 点击热点同归 hitTest 一处（双通道，G4 不砍点按）。
 */
export function triggerHotspotAt(
  hotspots: readonly Hotspot[],
  pos: Cell,
): Hotspot | null {
  return hitTest(hotspots, pos.x, pos.y + 1);
}

/**
 * 视口自适应放大倍率（G2.6 复测欠账：满屏世界 = 地图铺满视口）。取「盖住
 * 视口两轴」的倍率（max 比值向上 0.25 步进——0.5 步进会把 1.04 一类微超比
 * 率整档顶到 1.5，54×32 新地图下 1280 宽只能见 35 列、破「≥40 列」验收；
 * 0.25 档落 1.25，24px 格表观 30px 正对参考图，TILE_PX×scale 恒整数格边），
 * 下限 1（不缩小）；放大的溢出由镜头跟随（cameraOffset 钳制）。视口未知
 * 回落 1。
 */
export function viewportScale(
  map: TileMap,
  viewW: number,
  viewH: number,
  tilePx: number,
): number {
  const worldW = (map[0]?.length ?? 0) * tilePx;
  const worldH = map.length * tilePx;
  if (viewW <= 0 || viewH <= 0) return 1;
  const raw = Math.max(viewW / worldW, viewH / worldH);
  return Math.max(1, Math.ceil(raw * 4) / 4);
}

/**
 * 镜头裁决（纯函数）：按缩放后的有效视野（视口 / scale）跟随化身（居中偏
 * 置，贴边钳制）；有效视野装得下全图时世界层居中（负 offset）。视口未知
 * 回落 0。调用方传的 viewW/viewH 必须是**缩放后口径**（视口 ÷ scale）。
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
  const x =
    viewW <= 0 ? 0 : viewW >= worldW ? Math.round((worldW - viewW) / 2) : Math.max(0, Math.min(worldW - viewW, cx - viewW / 2));
  const y =
    viewH <= 0 ? 0 : viewH >= worldH ? Math.round((worldH - viewH) / 2) : Math.max(0, Math.min(worldH - viewH, cy - viewH / 2));
  return { x, y };
}
