import { PALETTE32, type PaletteColor } from './skin';

/**
 * 16×16 tile 槽位表（G1 骨架，设计 §九）：场景 = tile 网格（tilemap 二维数组，
 * 每格一枚字符码）+ tile 类型表（码 → 32 色板色块）+ 热点表。这是**数据结构不是
 * 美术**——渲染层只按表上色，G4 行走读 `solid`，未来换 itch 16×16 真资产 =
 * 换类型表的渲染映射（贴图位），场景定义与命中判定零改动。
 *
 * 角色占 1×2 tile（weaveRPG.md 立项口径），G1 只静态摆位不做行走。
 */

/** 单格渲染边长（px，整数倍缩放无小数）。 */
export const TILE_PX = 24;

export interface TileType {
  /** tilemap 里的单字符码。 */
  code: string;
  /** 主色（32 色板键名）。 */
  color: PaletteColor;
  /** 次色：偶数行/列的棋盘变体，避免大片纯色的塑料感。 */
  alt?: PaletteColor;
  /** G4 预留：不可通行（本批只存判据，不消费）。 */
  solid?: boolean;
}

/** tile 类型表（唯一词表：新地形 = 加一行，渲染/命中自动跟随）。 */
export const TILE_TYPES: Record<string, TileType> = {
  '.': { code: '.', color: 'moss' },
  ',': { code: ',', color: 'jade', alt: 'jadeDeep' },
  T: { code: 'T', color: 'bamboo', alt: 'jadeDeep', solid: true },
  W: { code: 'W', color: 'lake', alt: 'lakeDeep', solid: true },
  P: { code: 'P', color: 'sand', alt: 'linen' },
  S: { code: 'S', color: 'steel', alt: 'steelDeep', solid: true },
  F: { code: 'F', color: 'hemp', alt: 'sand' },
  '#': { code: '#', color: 'steelDeep', alt: 'slate', solid: true },
  D: { code: 'D', color: 'flameDeep', alt: 'ember' },
  c: { code: 'c', color: 'rose', alt: 'roseDeep' },
  // 房间内地毯（协同棋盘席位区视觉锚，G2 RoomScene）
  R: { code: 'R', color: 'rose', alt: 'roseDeep' },
};

export type TileMap = readonly string[];

export type HotspotAction =
  | { type: 'scene'; scene: string }
  | { type: 'project'; projectId: number }
  | { type: 'training' }
  | { type: 'console' }
  | { type: 'toast' };

export interface Hotspot {
  id: string;
  /** 左上角 tile 坐标（含 w×h 的矩形命中区）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  labelKey: string;
  action: HotspotAction;
}

/** 命中判定（纯函数）：点落在哪个热点矩形内；无 = null。 */
export function hitTest(hotspots: readonly Hotspot[], tx: number, ty: number): Hotspot | null {
  return hotspots.find((h) => tx >= h.x && tx < h.x + h.w && ty >= h.y && ty < h.y + h.h) ?? null;
}

/** tile 类型取色（棋盘变体）；未知码回落 ink（表外码是定义错误，宁可显眼）。 */
export function tileColor(code: string, col: number, row: number): string {
  const t = TILE_TYPES[code];
  if (!t) return PALETTE32.ink;
  const useAlt = t.alt != null && (col + row) % 2 === 0;
  return PALETTE32[(useAlt ? t.alt : t.color)!];
}

/* ---- 场景定义 ---- */

/** Home 室内（20×12）：木地板 + 四面墙，南墙正中一门（出室外），中央地毯 =
 * 上帝自由区（化身摆位），北墙下一条长案（管理区视觉锚）。 */
export const HOME_MAP: TileMap = [
  '####################',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#########DD#########',
];

export const HOME_HOTSPOTS: readonly Hotspot[] = [
  { id: 'door', x: 9, y: 11, w: 2, h: 1, labelKey: 'rpg.doorExit', action: { type: 'scene', scene: 'world' } },
  // 长案 = 统一控制台热点（G2.5：管理面 overlay 化后画布上的唯一管理门——
  // HUD 右上角按钮与这里同开一面）
  { id: 'console', x: 1, y: 1, w: 18, h: 1, labelKey: 'rpg.consoleTitle', action: { type: 'console' } },
];

/** 上帝化身静态摆位（G1 不做行走）：Home 中央地毯上。占 1×2。 */
export const GOD_SPOT = { x: 9, y: 5 } as const;

/** 室外世界地图（26×14）：草地基底 + 北面林带 + 东侧一汪水 + 十字土路。
 *  宅基地/修炼点/项目房都是热点覆盖层（PixelScene 画像素小房），不进底图。 */
export const WORLD_MAP: TileMap = [
  'TTTT,,TTTTTT,,TTTTTTTTTT,,TT',
  'TTTT,,TTTTTT,,TTTTTTTTTT,,TT',
  '............................',
  '............................',
  '.................P..........',
  'PPPPPPPPPPPPPPPPPP..........',
  '................PP..........',
  '................P.....WWWWWW',
  '................P.....WWWWWW',
  'PPPPPPPPPPPPPPPPP.....WWWWWW',
  '.......................WWWWW',
  '...,,,,......,,,,,......WWWW',
  '..,,,,,,....,,,,,,,.........',
  '...,,,,......,,,,...........',
];

/** 宅基地（Home 的门通向的位置）——点它回室内。 */
export const HOMESTEAD_HOTSPOT: Hotspot = {
  id: 'homestead',
  x: 4,
  y: 4,
  w: 3,
  h: 2,
  labelKey: 'rpg.worldHomestead',
  action: { type: 'scene', scene: 'home' },
};

/** 修炼点（G3 点亮）：点击开修炼动作面板（种田/钓鱼/锻造三入口）。 */
export const TRAINING_HOTSPOT: Hotspot = {
  id: 'training',
  x: 18,
  y: 6,
  w: 2,
  h: 2,
  labelKey: 'rpg.worldTraining',
  action: { type: 'training' },
};

export const WORLD_HOTSPOTS: readonly Hotspot[] = [HOMESTEAD_HOTSPOT, TRAINING_HOTSPOT];

/** 进房协同棋盘（G2 RoomScene，20×14）：木地板 + 四面墙 + 南墙一门（出室外回
 *  世界地图）+ 中部一条地毯长席（席位纵排，TFT 可读性口径：最重要信息最高）。 */
export const ROOM_MAP: TileMap = [
  '####################',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#FFFFFFFFFFFFFFFFFF#',
  '#########DD#########',
];

/** 房间席位槽位（纯函数，可单测）：第 i 个席位的 1×2 sprite 左上角——席位纵排
 *  （TFT 口径），从地毯顶行向下；超出行界返回 null（调用方截断展示）。 */
export function roomSeatSpot(i: number): { x: number; y: number } | null {
  if (!Number.isInteger(i) || i < 0) return null;
  const x = 9;
  const y = 4 + i * 2;
  if (y + 2 > 12) return null;
  return { x, y };
}

/** 上帝化身在房间的自由走动语义（G2 先静态摆位）：席位列左侧一格。 */
export const ROOM_GOD_SPOT = { x: 6, y: 5 } as const;

/** 房间门热点：点击回世界地图。 */
export const ROOM_HOTSPOTS: readonly Hotspot[] = [
  { id: 'room-door', x: 9, y: 13, w: 2, h: 1, labelKey: 'rpg.doorExit', action: { type: 'scene', scene: 'world' } },
];

/** 项目房沿南路边一字排开的槽位（纯函数，可单测）：第 i 座房的左上角。
 *  从 (2,7) 起每座占 2×2、间隔 1 格，放不下（超出地图）返回 null——调用方
 *  截断展示即可（项目房上限 = 槽位数，G2 换 houses 表后重排）。 */
export function projectHouseSpot(i: number): { x: number; y: number } | null {
  if (!Number.isInteger(i) || i < 0) return null;
  const x = 2 + i * 3;
  const y = 7;
  // 房子 2×2，超出地图右界 = 槽位用尽（调用方截断展示）
  if (x + 2 > 26) return null;
  return { x, y };
}

/** 项目房热点（动态：既有项目列表 → 每项目一座房，点击进项目视图）。 */
export function projectHouseHotspots(
  projects: readonly { id: number; name: string }[],
): Hotspot[] {
  const out: Hotspot[] = [];
  for (let i = 0; i < projects.length; i++) {
    const spot = projectHouseSpot(i);
    if (!spot) break;
    out.push({
      id: `project-${projects[i]!.id}`,
      x: spot.x,
      y: spot.y,
      w: 2,
      h: 2,
      labelKey: 'rpg.worldProjectRoom',
      action: { type: 'project', projectId: projects[i]!.id },
    });
  }
  return out;
}
