import { describe, it, expect } from 'vitest';
import {
  ATLAS_TILE_PX,
  ATLAS_COLS,
  ATLAS_ROWS,
  atlasTileOrigin,
  cellFaceOf,
  collectBaseRuns,
  collectSpriteRuns,
  PINE_TILES,
  CROP_TILES,
  SOIL_MOUND_TILES,
  SOIL_TOP_TILES,
  SOIL_BOTTOM_TILES,
  DOOR_TILES,
  STONE_TILE,
  BUSH_TILE,
  BLOOM_TILE,
} from '../tileset-map';
import { HOME_MAP, ROOM_MAP, WORLD_MAP, type TileMap } from '../worldmap';

/**
 * tileset-map spec（G2.6 第三轮资产化）：图集坐标换算（packed 步长 16）、
 * tile 码 → 贴图映射、未知码回退、run 合并与世界层 div 预算。
 */

describe('atlasTileOrigin 步长换算（packed 16px 无间距）', () => {
  it('n → col=n%12, row=floor(n/12), 像素原点 ×16', () => {
    expect(atlasTileOrigin(1)).toEqual({ x: 16, y: 0 });
    expect(atlasTileOrigin(11)).toEqual({ x: 176, y: 0 });
    expect(atlasTileOrigin(12)).toEqual({ x: 0, y: 16 });
    expect(atlasTileOrigin(105)).toEqual({ x: 9 * 16, y: 8 * 16 });
    expect(atlasTileOrigin(131)).toEqual({ x: 11 * 16, y: 10 * 16 });
  });

  it('0 与表外序号 = 无贴图（null）', () => {
    expect(atlasTileOrigin(0)).toBeNull();
    expect(atlasTileOrigin(-1)).toBeNull();
    expect(atlasTileOrigin(ATLAS_COLS * ATLAS_ROWS)).toBeNull();
    expect(atlasTileOrigin(1.5)).toBeNull();
  });

  it('原点全在图集界内（packed 192×176）', () => {
    expect(ATLAS_TILE_PX).toBe(16);
    expect(ATLAS_COLS).toBe(12);
    expect(ATLAS_ROWS).toBe(11);
    for (let n = 1; n < 132; n++) {
      const o = atlasTileOrigin(n)!;
      expect(o.x).toBeLessThanOrEqual(176);
      expect(o.y).toBeLessThanOrEqual(160);
    }
  });
});

describe('cellFaceOf 映射表', () => {
  it('草地家族（. , T b *）共享 grass 基底（底图池空 = 纯色兜底）；sprite 各归各', () => {
    const map: TileMap = ['.,Tb*', '.....'];
    expect(cellFaceOf(map, 0, 0).kind).toBe('grass');
    expect(cellFaceOf(map, 1, 0).kind).toBe('grass');
    expect(PINE_TILES).toContain(cellFaceOf(map, 2, 0).spriteTile);
    expect(cellFaceOf(map, 3, 0).spriteTile).toBe(BUSH_TILE);
    expect(cellFaceOf(map, 4, 0).spriteTile).toBe(BLOOM_TILE);
  });

  it('作物幼苗 g ∈ {4,5,8} 混排且确定性', () => {
    const picks = new Set<number>();
    for (let c = 0; c < 24; c++) {
      const f = cellFaceOf(['gggggggggggggggggggggggg'], c, 0);
      expect(CROP_TILES).toContain(f.spriteTile);
      picks.add(f.spriteTile);
      expect(f.spriteTile).toBe(cellFaceOf(['gggggggggggggggggggggggg'], c, 0).spriteTile);
    }
    expect(picks.size).toBeGreaterThan(1);
  });

  it('土路按邻格定形：上缘中段 49、下缘中段 61（tile-<n> kind）', () => {
    const map: TileMap = ['.....', 'PPPPP', 'PPPPP', '.....'];
    expect(Number(cellFaceOf(map, 2, 1).kind!.slice(5))).toBe(49);
    expect(Number(cellFaceOf(map, 2, 2).kind!.slice(5))).toBe(61);
    expect(Number(cellFaceOf(map, 0, 1).kind!.slice(5))).toBe(48);
    expect(Number(cellFaceOf(map, 4, 1).kind!.slice(5))).toBe(50);
    expect(Number(cellFaceOf(map, 0, 2).kind!.slice(5))).toBe(60);
    expect(Number(cellFaceOf(map, 4, 2).kind!.slice(5))).toBe(62);
  });

  it('耕地 f ∈ 土堆两档；岸石 S 带 89 sprite；湖缘叠岸石过渡、湖心纯水', () => {
    const map: TileMap = ['ffS', 'ffW'];
    expect(cellFaceOf(map, 0, 0).kind).toMatch(/^tile-\d+$/);
    const soilTile = Number(cellFaceOf(map, 0, 0).kind!.slice(5));
    expect(SOIL_MOUND_TILES).toContain(soilTile);
    expect(cellFaceOf(map, 2, 0).spriteTile).toBe(STONE_TILE);
    // W 在 S 下方：上邻非水 = 岸线 → 岸石 sprite
    expect(cellFaceOf(map, 2, 1).kind).toBe('water');
    expect(cellFaceOf(map, 2, 1).spriteTile).toBe(STONE_TILE);
    // 湖心（四邻全水，界外也算水邻）无 sprite
    const lake: TileMap = ['WW', 'WW'];
    expect(cellFaceOf(lake, 0, 0).spriteTile).toBe(0);
  });

  it('未知码回退：kind null + 无 sprite（纯色兜底直出）', () => {
    const f = cellFaceOf(['?'] as TileMap, 0, 0);
    expect(f.kind).toBeNull();
    expect(f.spriteTile).toBe(0);
  });

  it('门 DD 各取一枚谷仓门', () => {
    const map: TileMap = ['#####DD#####'];
    // DD 在 col 5/6：col 奇偶各取一枚门（126/127）
    expect(Number(cellFaceOf(map, 5, 0).kind!.slice(5))).toBe(DOOR_TILES[1]);
    expect(Number(cellFaceOf(map, 6, 0).kind!.slice(5))).toBe(DOOR_TILES[0]);
  });
});

describe('run 合并', () => {
  it('同行相邻同 kind 底图合并成单 run；草 tile 取 run 起点抖动档', () => {
    const map: TileMap = ['.....', '.TT..'];
    const runs = collectBaseRuns(map);
    // 首行整行一个草 run
    expect(runs).toContainEqual(expect.objectContaining({ row: 0, col: 0, span: 5 }));
    // 次行：草(1) + T(3) + 草(1) 全是 grass kind → 一个 run
    expect(runs.filter((r) => r.row === 1)).toHaveLength(1);
    const grassRun = runs.find((r) => r.row === 0)!;
    // 底图池空（方案 B）：草 run 无贴图、退 tileColor 纯色
    expect(grassRun.baseTile).toBe(0);
  });

  it('土路横条按帽/中分段（49 连排、帽格独立）', () => {
    const runs = collectBaseRuns(WORLD_MAP);
    const topRow = runs.filter((r) => r.row === 9);
    expect(topRow.map((r) => r.span).reduce((a, b) => a + b, 0)).toBe(54);
    expect(topRow.some((r) => r.span >= 52)).toBe(true);
  });

  it('sprite run：T 密林按 8 格块分段合并、灌木/花各自成 run', () => {
    const map: TileMap = ['TTTTTTTTTTTTb*TTTTTTTTTTTT'];
    const runs = collectSpriteRuns(map);
    const spans = runs.map((r) => r.span);
    expect(spans.reduce((a, b) => a + b, 0)).toBe(26);
    expect(runs.some((r) => r.span >= 8)).toBe(true);
    expect(runs.find((r) => r.col === 12)!.spriteTile).toBe(BUSH_TILE);
    expect(runs.find((r) => r.col === 13)!.spriteTile).toBe(BLOOM_TILE);
  });

  it('室内北墙行标记 northWall（Home/Room 首行）', () => {
    const runs = collectBaseRuns(HOME_MAP, true);
    expect(runs.filter((r) => r.row === 0).every((r) => r.northWall)).toBe(true);
    expect(collectBaseRuns(HOME_MAP).every((r) => !r.northWall)).toBe(true);
  });

  it('世界层 div 预算：底图 + sprite ≤ 380（性能纪律①）', () => {
    // 收尾批加草地草叶点缀（~109 枚，测得 sprite 253 + base 88 = 341）：
    // 仍 ≈ 1/5 逐格渲染（1728 div），预算随之实测上调——每次加面必须重新度量。
    const total = collectBaseRuns(WORLD_MAP).length + collectSpriteRuns(WORLD_MAP).length;
    expect(total).toBeLessThanOrEqual(380);
  });

  it('Home/Room 室内 run 数量同样收敛（逐格 240 → 双层合计 < 90）', () => {
    for (const map of [HOME_MAP, ROOM_MAP]) {
      const total = collectBaseRuns(map, true).length + collectSpriteRuns(map).length;
      expect(total).toBeLessThanOrEqual(90);
    }
  });
});

describe('房体词表', () => {
  it('门词表 = 双开门对两枚（房体南墙门位与室内 DD 门格共用）；墙面词表随九宫退役', () => {
    expect(DOOR_TILES).toEqual([126, 127]);
  });

  it('耕地土条词表：上缘 48-50、下缘 60-62（世界地图灵田可用）', () => {
    expect(SOIL_TOP_TILES).toEqual([48, 49, 50]);
    expect(SOIL_BOTTOM_TILES).toEqual([60, 61, 62]);
  });
});
