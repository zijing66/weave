/**
 * 16×16 tile 槽位表（G1 骨架 + G2.6 视觉还原校色）：场景 = tile 网格（tilemap
 * 二维数组，每格一枚字符码）+ tile 类型表（码 → 色值）+ 热点表。这是**数据结构
 * 不是美术**——渲染层只按表上色，G4 行走读 `solid`，未来换 itch 16×16 真资产 =
 * 换类型表的渲染映射（贴图位），场景定义与命中判定零改动。
 *
 * 角色占 1×2 tile（weaveRPG.md 立项口径）。
 */

/** 单格渲染边长（px，整数倍缩放无小数）。 */
export const TILE_PX = 24;

/**
 * G2.6 视觉规格色板（参考图 A/B 校色，单点定义）：场景 tile 与 HUD 共用这一份
 * 常量——tile 上色、HUD 面样式、选中/警报色都从这里取，不再散写十六进制。
 */
export const RPG_SCENE_PALETTE = {
  /** 背景/面板深底。 */
  bgDeep: '#17141f',
  /** 草地主色。 */
  grass: '#243d2b',
  /** 草地交替（墨绿棋盘）。 */
  grassAlt: '#315238',
  /** 草地亮绿点缀（草丛）。 */
  grassBright: '#496747',
  /** 草地微扰档（斑驳肌理，坐标派生）。 */
  grassDapple: '#2b4633',
  grassDappleDark: '#203728',
  /** 土路。 */
  path: '#a58a5b',
  pathAlt: '#97805a',
  /** 路缘过渡（与草交界）+ 路内深斑。 */
  pathEdge: '#8a744c',
  pathDapple: '#b09566',
  /** 屋顶橙（瓦楞横纹渐变三档）。 */
  roof: '#b86b36',
  roofDeep: '#8a4e24',
  roofRidge: '#c97a42',
  /** 屋身木墙 + 暖黄窗光 + 门前小牌。 */
  wallWood: '#745137',
  /** 室内透视北墙：墙体暗面（立起段）+ 墙裙亮线。 */
  wallDark: '#3a2e22',
  wallTrim: '#8a6f4e',
  windowGlow: '#e8c46a',
  doorPlaque: '#3a2c1e',
  /** 木墙。 */
  wood: '#745137',
  woodDeep: '#5f422d',
  /** 湖水。 */
  lake: '#294b70',
  lakeAlt: '#24425f',
  lakeShimmer: '#33587f',
  /** 岸石深灰。 */
  shore: '#43484f',
  shoreAlt: '#4c525a',
  /** 松树冠（比草地深一档）。 */
  pine: '#1f3626',
  pineAlt: '#1a2e20',
  /** 松树三层结构（冠亮/影深/干）。 */
  pineCrown: '#2c4a30',
  pineShadow: '#16281a',
  pineTrunk: '#4a3524',
  /** 灌木。 */
  bush: '#2f4a33',
  /** 花草点缀。 */
  bloom: '#5d7f4e',
  /** 宅基地石板。 */
  slab: '#6f6a63',
  slabAlt: '#625d57',
  /** 东方符文 tile（青调刻石）。 */
  rune: '#3f7a6e',
  /** 耕地。 */
  soil: '#6b4a2e',
  soilAlt: '#5d4028',
  /** 嫩绿幼苗。 */
  sprout: '#7fae5a',
  /** 石碑 + 青水晶（修炼点石碑阵）。 */
  stele: '#5a5f66',
  steleTop: '#6b7178',
  crystal: '#4ec9b0',
  crystalDeep: '#2e8574',
  /** 室内木地板（Home/Room 校色）。 */
  floor: '#7d6242',
  floorAlt: '#6d5539',
  /** 门（深色）。 */
  door: '#3a2c1e',
  /** 强调青（选中/进度/hover）。 */
  accent: '#4ec9b0',
  /** 警报红。 */
  alert: '#c9566e',
  /** 警告黄。 */
  warn: '#d9a441',
  /** 文字浅灰。 */
  text: '#d7d1c6',
  /** HUD 统一表面。 */
  hudBg: 'rgba(18,17,26,0.88)',
  hudBorder: 'rgba(190,190,190,0.28)',
} as const;

export type ScenePaletteColor = keyof typeof RPG_SCENE_PALETTE;

export interface TileType {
  /** tilemap 里的单字符码。 */
  code: string;
  /** 主色（G2.6 色板 16 进制）。 */
  color: string;
  /** 次色：偶数行/列的棋盘变体，避免大片纯色的塑料感。 */
  alt?: string;
  /** 不可通行（G4 行走判据）。 */
  solid?: boolean;
}

/** tile 类型表（唯一词表：新地形 = 加一行，渲染/命中自动跟随）。 */
export const TILE_TYPES: Record<string, TileType> = {
  '.': { code: '.', color: RPG_SCENE_PALETTE.grass, alt: RPG_SCENE_PALETTE.grassAlt },
  ',': { code: ',', color: RPG_SCENE_PALETTE.grassBright },
  T: { code: 'T', color: RPG_SCENE_PALETTE.pine, alt: RPG_SCENE_PALETTE.pineAlt, solid: true },
  b: { code: 'b', color: RPG_SCENE_PALETTE.bush },
  '*': { code: '*', color: RPG_SCENE_PALETTE.bloom },
  W: { code: 'W', color: RPG_SCENE_PALETTE.lake, alt: RPG_SCENE_PALETTE.lakeAlt, solid: true },
  P: { code: 'P', color: RPG_SCENE_PALETTE.path, alt: RPG_SCENE_PALETTE.pathAlt },
  S: { code: 'S', color: RPG_SCENE_PALETTE.shore, solid: true },
  F: { code: 'F', color: RPG_SCENE_PALETTE.floor, alt: RPG_SCENE_PALETTE.floorAlt },
  '#': { code: '#', color: RPG_SCENE_PALETTE.wood, alt: RPG_SCENE_PALETTE.woodDeep, solid: true },
  D: { code: 'D', color: RPG_SCENE_PALETTE.door },
  s: { code: 's', color: RPG_SCENE_PALETTE.slab, alt: RPG_SCENE_PALETTE.slabAlt },
  y: { code: 'y', color: RPG_SCENE_PALETTE.rune },
  f: { code: 'f', color: RPG_SCENE_PALETTE.soil, alt: RPG_SCENE_PALETTE.soilAlt },
  g: { code: 'g', color: RPG_SCENE_PALETTE.sprout },
  // 房间内地毯（协同棋盘席位区视觉锚，G2 RoomScene）
  R: { code: 'R', color: RPG_SCENE_PALETTE.alert, alt: '#8a3548' },
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

/**
 * tile 类型取色（棋盘变体 + G2.6 参考图肌理：坐标派生微扰——草地斑驳两档、
 * 路面深浅斑、湖面三档波光；确定性纯函数，同一格恒同色）。未知码回落深底
 * （表外码是定义错误，宁可显眼）。
 */
export function tileColor(code: string, col: number, row: number): string {
  const t = TILE_TYPES[code];
  if (!t) return RPG_SCENE_PALETTE.bgDeep;
  const P = RPG_SCENE_PALETTE;
  // 确定性散列（XOR 抖动，两格不谐频即可）
  const jitter = (x: number, y: number, m: number): number => (x * 7 + y * 13 + ((x * y) % 5)) % m;
  switch (code) {
    case '.': {
      // 草地：棋盘底 + 少量斑驳（约 1/5 格出深/浅一档）
      const base = (col + row) % 2 === 0 ? P.grassAlt : P.grass;
      const j = jitter(col, row, 5);
      if (j === 0) return P.grassDapple;
      if (j === 1) return P.grassDappleDark;
      return base;
    }
    case 'W': {
      // 湖水：奇偶棋盘 + 少量波光第三档
      const base = (col + row) % 2 === 0 ? P.lakeAlt : P.lake;
      return jitter(col, row, 6) === 0 ? P.lakeShimmer : base;
    }
    case 'S':
      // 岸石：两档深灰棋盘
      return (col + row) % 2 === 0 ? P.shoreAlt : P.shore;
    case 'P': {
      // 土路：路内深浅斑（约 1/3），边缘格（四邻有草）走路缘过渡色
      const j = jitter(col, row, 3);
      if (j === 0) return P.pathDapple;
      if (j === 1) return P.pathAlt;
      return P.path;
    }
    default: {
      const useAlt = t.alt != null && (col + row) % 2 === 0;
      return useAlt ? t.alt! : t.color;
    }
  }
}

/** 路缘判定：P 格四邻存在草基底（'.' 或 ','）= 边缘格（过渡色，渲染层用）。 */
export function isPathEdge(map: readonly string[], col: number, row: number): boolean {
  if (map[row]?.[col] !== 'P') return false;
  const grassy = (c: string | undefined): boolean => c === '.' || c === ',';
  return (
    grassy(map[row - 1]?.[col]) ||
    grassy(map[row + 1]?.[col]) ||
    grassy(map[row]?.[col - 1]) ||
    grassy(map[row]?.[col + 1])
  );
}

/* ---- 场景定义 ---- */

/** Home 室内（20×12）：木地板 + 四面墙（G2.6 校色：木墙/门走新色板），
 *  南墙正中一门（出室外），中央 = 上帝自由区（化身摆位），北墙下一条长案
 *  （管理区视觉锚）。 */
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

/** 世界场景化身落点：宅基地正南土路上（54×32 新图，路 rows 9-10）——出门即
 *  路口；必须落在热点矩形之外（脚格判据，站进宅基地矩形一步就会触发回 Home）。 */
export const WORLD_GOD_SPOT = { x: 9, y: 9 } as const;

/** 室外世界地图（54×32，G2.6 比例裁决：TILE_PX=24 不动、靠地图密度把表观
 *  tile 细到 ≈30px@1280——参考图整体比例）：北面松林密片（1 tile 成片）+
 *  2 tile 宽土路横贯 + 东侧湖 10×8（岸石圈）+ 西北宅基地（石板 + 符文 +
 *  石灯）+ 南灵田 4×4（耕地 + 幼苗）。树/石/水 solid。
 *  宅基地/修炼点/项目房的热点语义不变（热点矩形随新布点重摆）。 */
export const WORLD_MAP: TileMap = [
  'TTTTTTbTTTTTTTTTTbTTTTTTTTTTTTTTbTTTTTTTTTTTTTTTTTTTTT',
  'TTbTTTTTTTT*TTTTTTTTTTbTTTTTTTTTTTTTTTTTbTTTT*TTTTTTTT',
  'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
  'T.,TT*TTT.,.TTTTbTTT.,TTTTT*TTTT.,TTTbTTTTT.,TT*TTTb.,',
  '.,....*......,,,.....,......*.......,,.......*......,.',
  '....ssyyyys.....,....*......b..........,.........*....',
  '..b.sS....Ss...........,,........*..........b......,..',
  '....sS....Ss...................,,,..................,.',
  '....ssyssss....*....b........,......*.....,,..........',
  'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP',
  'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP',
  '..b.....,......*.....,......b......,.....*......,....b',
  '.,..*......,,.......*.......,,,......b.........*.....,',
  '....,.......b.....,.......*.......,,.......*........,,',
  '.*....,,.......*.........,.....WWWWWWWWW,,......*.....',
  '..,......b..........,,.......WWWWWWWWWWWWW....,.......',
  '.....*..........,..........SWWWWWWWWWWWWWW*..........,',
  '..*.......,,.........b.....SWWWWWWWWWWWWWWW.......*...',
  '..*.,......fggf.........,SWWWWWWWWWWWWWWWWW,,.........',
  '.......b...gffg..,,.......,SWWWWWWWWWWWWWWWWW....b....',
  '..,........fggf...........,SWWWWWWWWWWWWWWWWWW......,,',
  '.*.....,,..gffg......b.....SWWWWWWWWWWWWWWWW....*.....',
  '....,..........,,..........SWWWWWWWWWWWWWWW,...,......',
  '..b......*..........,.......,WWWWWWWWWWWWWW.......,,..',
  '.*...........,.....b..,......WWWWWWWWWWWWW....,.......',
  '....,,...........*...........,.WWWWWWWWWW*..........b.',
  '..*......b....,,........*.......,..,.......,...*......',
  '.,......*..........,..........b.....*.......,,.......,',
  '....b.......*........,,..........,........*........,,.',
  '.*....,.....,,.....*......b..........,........*....,..',
  '..,.......b.........,....,.....,,..........b.....*....',
  '....*....,......,,.......*.....,....b....,........,.*.',
];

/** 宅基地（Home 的门通向的位置，G2.6 挪到石板场）：点它回室内。 */
export const HOMESTEAD_HOTSPOT: Hotspot = {
  id: 'homestead',
  x: 4,
  y: 5,
  w: 8,
  h: 4,
  labelKey: 'rpg.worldHomestead',
  action: { type: 'scene', scene: 'home' },
};

/** 修炼点（G3 点亮）：灵田（耕地 + 幼苗，地图 (11,18) 起 4×4），点击开修炼
 *  动作面板（种田/钓鱼/锻造）。 */
export const TRAINING_HOTSPOT: Hotspot = {
  id: 'training',
  x: 11,
  y: 18,
  w: 4,
  h: 4,
  labelKey: 'rpg.worldTraining',
  action: { type: 'training' },
};

export const WORLD_HOTSPOTS: readonly Hotspot[] = [HOMESTEAD_HOTSPOT, TRAINING_HOTSPOT];

/** 进房协同棋盘（G2 RoomScene，20×14，G2.6 仅校色）：木地板 + 四面墙 + 南墙
 *  一门（出室外回世界地图）+ 中部一条地毯长席（席位纵排，TFT 可读性口径）。 */
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

/** 项目房沿土路（G2.6 参考图比例裁决：房 3 tile 宽、在路南沿路排开）的槽位
 *  （纯函数，可单测）：第 i 座房的左上角，占 3×3、间隔 1 格，放不下（超出
 *  地图）返回 null——调用方截断展示即可（项目房上限 = 槽位数）。 */
export const HOUSE_TILES = 3;

export function projectHouseSpot(i: number): { x: number; y: number } | null {
  if (!Number.isInteger(i) || i < 0) return null;
  const x = 2 + i * 4;
  const y = 11;
  // 房子 3×3，超出地图右界（54 列）= 槽位用尽（调用方截断展示）
  if (x + HOUSE_TILES > 54) return null;
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
      w: HOUSE_TILES,
      h: HOUSE_TILES,
      labelKey: 'rpg.worldProjectRoom',
      action: { type: 'project', projectId: projects[i]!.id },
    });
  }
  return out;
}
