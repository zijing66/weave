import type { TileMap } from './worldmap';

/**
 * G2.6 图集映射表（纯函数，可单测）：tile 码 → Kenney Tiny Farm 图集序号。
 *
 * 已落库图集 = packed 变体（192×176，16px tile、**步长 16 无间距**，与原始
 * tilemap_packed.png 字节一致——工单里的「1px 间距步长 17」属于未落库的
 * spaced 变体，坐标换算一律走本文件的 atlasTileOrigin，不散写步数）。
 * 序号 n（0-based）→ col = n % 12、row = floor(n / 12)，像素原点 ×16。
 *
 * 渲染契约（PixelScene / tile-decor 消费）：
 * - repeat 单元必须是**单 tile**（CSS repeat 平铺整张背景图，整图集铺上会
 *   串块）——运行时切片见 tile-atlas.ts（data URL，加载失败退 tileColor 色块）。
 * - sprite 层：树/灌木/花/作物/岸石等透明底贴图，叠在底图 run 之上。
 * - 水无 tile（湖保持 CSS 三档蓝棋盘）；石碑无 tile（tile-decor 的 CSS 部件）。
 */

/** tile 序号 → 图集像素原点。0 与表外序号 = 无贴图（null，调用方退纯色）。 */
export function atlasTileOrigin(n: number): { x: number; y: number } | null {
  if (!Number.isInteger(n) || n < 1 || n >= ATLAS_COLS * ATLAS_ROWS) return null;
  return { x: (n % ATLAS_COLS) * ATLAS_TILE_PX, y: Math.floor(n / ATLAS_COLS) * ATLAS_TILE_PX };
}

export const ATLAS_TILE_PX = 16;
export const ATLAS_COLS = 12;
export const ATLAS_ROWS = 11;

/** 确定性散列（与 worldmap.tileColor 同款抖动家族，同一格恒同贴图）。 */
function jitter(x: number, y: number, m: number): number {
  return (x * 7 + y * 13 + ((x * y) % 5)) % m;
}

/* ---- 图集词表（全部经整图编号标注图逐格目验） ---- */

/** 草地底图池（空 = 底图退 worldmap.tileColor 纯色棋盘）：图集绿底族
 *  {94,105,106,117,119} 全部带内置竖条/描边（106 亦有半格亮带），repeat-x
 *  平铺成规则栅栏纹——逐像素扫描无纯绿无缝底，方案 B 落定：草地底色走
 *  既有 tileColor（棋盘+斑驳噪点），图集只出树/灌木/花/作物/岸石装饰件。 */
export const GRASS_TILES = [] as const;
/** 松树两档（中/大），按横向 8 格块交替防「树篱」感。 */
export const PINE_TILES = [15, 27] as const;
/** 灌木 / 花（向日葵）/ 岸石堆。 */
export const BUSH_TILE = 39;
export const BLOOM_TILE = 83;
export const STONE_TILE = 89;
/** 作物幼苗三档（灵田 4×4 混排：芽/苗/胡萝卜）。 */
export const CROP_TILES = [4, 5, 8] as const;
/** 耕地：独立土堆（深/浅）与土条上/下缘（左/中/右）。 */
export const SOIL_MOUND_TILES = [51, 63] as const;
export const SOIL_TOP_TILES = [48, 49, 50] as const;
export const SOIL_BOTTOM_TILES = [60, 61, 62] as const;
/** 房体九宫：平木墙三段（114-116 横向接缝实测错色条不连续，纯墙带用
 *  115 一档保墙纹均匀）+ 带梁上墙（102/104，左/右缘梁柱）+ 窗（112，
 *  110-113 窗族点缀）+ 谷仓门（126/127，仅底行中央一格）。 */
export const WALL_BEAM_TILES = [102, 104] as const;
export const WALL_TILES = [114, 115, 116] as const;
export const HOUSE_WINDOW_TILES = [112, 113] as const;
/** 谷仓门两枚（双开门对）。 */
export const DOOR_TILES = [126, 127] as const;

/* ---- 格位面 ---- */

export interface CellFace {
  /** 底图合并键：同行相邻同键格合成一个 div（null = 不与邻格合并）。 */
  kind: string | null;
  /** 覆盖 sprite tile 序号（0 = 无）。 */
  spriteTile: number;
}

/**
 * 单格面（纯函数）：kind 决定底图 tile 与合并（`tile-<n>` kind 自带底图
 * tile，同名即同贴图可合并）；草家族（点/逗/T/b/星/g）共享草地基底——
 * 树/灌木/花/作物的实体感全靠 sprite 层，底图并入草 run 省 div。
 * 未知码 = kind null + 无贴图 → 纯色兜底直出。
 */
export function cellFaceOf(map: TileMap, col: number, row: number): CellFace {
  const code = map[row]?.[col];
  if (!code) return { kind: null, spriteTile: 0 };
  switch (code) {
    case '.':
    case ',':
      return { kind: 'grass', spriteTile: 0 };
    case 'T':
      return { kind: 'grass', spriteTile: PINE_TILES[(col >> 3) % 2]! };
    case 'b':
      return { kind: 'grass', spriteTile: BUSH_TILE };
    case '*':
      return { kind: 'grass', spriteTile: BLOOM_TILE };
    case 'g':
      return { kind: 'grass', spriteTile: CROP_TILES[jitter(col, row, CROP_TILES.length)]! };
    case 'W': {
      // 湖缘过渡：四邻有非水格 = 岸线，叠岸石堆 sprite（像素级过渡，
      // 消几何硬边阶梯；界外按水算，湖心保持纯水色）。
      const land = (c: number, r: number): boolean => map[r] != null && (map[r]![c] ?? 'W') !== 'W';
      const edge = land(col - 1, row) || land(col + 1, row) || land(col, row - 1) || land(col, row + 1);
      return { kind: 'water', spriteTile: edge ? STONE_TILE : 0 };
    }
    case 'S':
      return { kind: 'grass', spriteTile: STONE_TILE };
    case 'P': {
      // 土路横条：上/下缘按「邻格是否路」定形——帽格独立成 run（左右圆角）
      const road = (c: number, r: number): boolean => map[r]?.[c] === 'P';
      const topEdge = !road(col, row - 1);
      const botEdge = !road(col, row + 1);
      const leftCap = !road(col - 1, row);
      const rightCap = !road(col + 1, row);
      if (topEdge) {
        if (leftCap) return { kind: `tile-${SOIL_TOP_TILES[0]!}`, spriteTile: 0 };
        if (rightCap) return { kind: `tile-${SOIL_TOP_TILES[2]!}`, spriteTile: 0 };
        return { kind: `tile-${SOIL_TOP_TILES[1]!}`, spriteTile: 0 };
      }
      if (botEdge) {
        if (leftCap) return { kind: `tile-${SOIL_BOTTOM_TILES[0]!}`, spriteTile: 0 };
        if (rightCap) return { kind: `tile-${SOIL_BOTTOM_TILES[2]!}`, spriteTile: 0 };
        return { kind: `tile-${SOIL_BOTTOM_TILES[1]!}`, spriteTile: 0 };
      }
      return { kind: `tile-${SOIL_TOP_TILES[1]!}`, spriteTile: 0 };
    }
    case 's':
      return { kind: 'slab', spriteTile: 0 };
    case 'y':
      return { kind: 'rune', spriteTile: 0 };
    case 'f':
      return { kind: `tile-${SOIL_MOUND_TILES[jitter(col, row, SOIL_MOUND_TILES.length)]!}`, spriteTile: 0 };
    case 'F':
      return { kind: 'floor', spriteTile: 0 };
    case 'R':
      return { kind: 'carpet', spriteTile: 0 };
    case '#': {
      // 木墙：114/115 按 2 格块交替（接缝实测无缝），帽位 116 留给房体九宫
      return { kind: `tile-${WALL_TILES[(col >> 1) % 2]!}`, spriteTile: 0 };
    }
    case 'D': {
      // 双开谷仓门：DD 两格各取一枚门（col 奇偶定左右扇）
      return { kind: `tile-${DOOR_TILES[col % 2]!}`, spriteTile: 0 };
    }
    default:
      return { kind: null, spriteTile: 0 };
  }
}

/** kind → 底图 tile 序号（0 = 纯色）。`tile-<n>` kind 自带 tile；草 tile 由
 *  run 起点从 GRASS_TILES 选取（见 collectBaseRuns）。 */
function kindBaseTile(kind: string | null): number {
  if (kind == null) return 0;
  if (kind === 'grass' || kind === 'water' || kind === 'slab' || kind === 'rune' || kind === 'floor' || kind === 'carpet') {
    return 0;
  }
  if (kind.startsWith('tile-')) return Number(kind.slice(5));
  return 0;
}

/* ---- run 收集 ---- */

export interface TileRun {
  col: number;
  row: number;
  /** 横向跨格数（≥1）。 */
  span: number;
  /** 底图 tile（0 = 纯色退 worldmap.tileColor）。 */
  baseTile: number;
  /** 覆盖 sprite tile（0 = 无）。 */
  spriteTile: number;
  /** 室内北墙行（indoor 且首行 #）：2 tile 高，上半墙暗面下半贴墙板。 */
  northWall: boolean;
}

function collectRuns(
  map: TileMap,
  want: 'base' | 'sprite',
  indoor: boolean,
): TileRun[] {
  const rows = map.length;
  const cols = map[0]?.length ?? 0;
  const out: TileRun[] = [];
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      const face = cellFaceOf(map, c, r);
      const key = want === 'base' ? face.kind : face.spriteTile > 0 ? `s${face.spriteTile}` : null;
      if (key == null) {
        c++;
        continue;
      }
      let span = 1;
      while (c + span < cols) {
        const next = cellFaceOf(map, c + span, r);
        const nextKey = want === 'base' ? next.kind : next.spriteTile > 0 ? `s${next.spriteTile}` : null;
        if (nextKey !== key) break;
        span++;
      }
      const northWall = indoor && r === 0 && map[r]?.[c] === '#';
      out.push({
        col: c,
        row: r,
        span,
        baseTile:
          want === 'base'
            ? (key === 'grass' && GRASS_TILES.length > 0
                ? GRASS_TILES[jitter(c, r, GRASS_TILES.length)]!
                : kindBaseTile(face.kind))
            : 0,
        spriteTile: want === 'sprite' ? face.spriteTile : 0,
        northWall,
      });
      c += span;
    }
  }
  return out;
}

/**
 * 底图 run 收集（纯函数）：同行相邻同 kind 格合并；草 run 的 tile 取 run
 * 起点的抖动档（run 内均匀、run 间有别）。室内北墙行整行仍按墙 tile 分段
 * （northWall 标记 2 tile 高渲染）。
 */
export function collectBaseRuns(map: TileMap, indoor = false): TileRun[] {
  return collectRuns(map, 'base', indoor);
}

/**
 * sprite run 收集（纯函数）：同行相邻同 tile 的树/灌木/花/作物/岸石合并
 * （repeat-x 取块）。
 */
export function collectSpriteRuns(map: TileMap): TileRun[] {
  return collectRuns(map, 'sprite', false);
}

/* ---- 房体九宫（HouseTile 消费） ---- */

/**
 * 房体 3×3 贴图九宫（纯函数）：三行全以平木墙为面（114-116），顶行嵌一枚
 * 窗（112/113 按 seed 取）、中行左右缘用带梁墙（102/104）立柱感、底行中央
 * 一格谷仓门（126/127 按 seed 换扇）——X 门件只出现在门位，墙不再带 X 纹。
 * 返回 9 枚 tile 序号（行优先）。
 */
export function houseGridTiles(seed: number): readonly number[] {
  const door = DOOR_TILES[((seed % 2) + 2) % 2]!;
  const win = HOUSE_WINDOW_TILES[((seed % 2) + 2) % 2]!;
  return [
    WALL_TILES[0]!,
    win,
    WALL_TILES[2]!,
    WALL_BEAM_TILES[0]!,
    WALL_TILES[1]!,
    WALL_BEAM_TILES[1]!,
    WALL_TILES[0]!,
    door,
    WALL_TILES[2]!,
  ];
}
