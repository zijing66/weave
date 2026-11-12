import { describe, it, expect } from 'vitest';
import {
  TILE_TYPES,
  tileColor,
  hitTest,
  HOME_MAP,
  HOME_HOTSPOTS,
  WORLD_MAP,
  WORLD_HOTSPOTS,
  projectHouseSpot,
  projectHouseHotspots,
  GOD_SPOT,
  HOMESTEAD_HOTSPOT,
  TRAINING_HOTSPOT,
  worldExitSpawnOf,
  WORLD_GOD_SPOT,
} from '../worldmap';
import { RPG_SCENE_PALETTE } from '../worldmap';
import { RPG_SCENES, sceneOf, roomSceneKey, worldExitHouseIdOf, worldExitSceneKey } from '../scenes';
import { RPG_BOOT_ITEMS, rpgBoot, type RpgBootKey } from '../rpg-boot';

/** G1 骨架纯函数与数据不变式：tile 槽位表是数据结构不是美术——换资产零改动
 *  的前提是「每行等宽、码在类型表内、命中判定矩形语义稳定」。 */

describe('worldmap tile 槽位表', () => {
  it('HOME_MAP 与 WORLD_MAP 全部行等宽（矩形网格不变式）；世界 54×32', () => {
    const widths = (m: readonly string[]) => new Set([...m].map((r) => r.length));
    expect(widths(HOME_MAP).size).toBe(1);
    expect(widths(WORLD_MAP).size).toBe(1);
    expect(WORLD_MAP.length).toBe(32);
    expect(WORLD_MAP[0]!.length).toBe(54);
  });

  it('地图里出现的码全部在 TILE_TYPES 词表内（表外码 = 定义错误）', () => {
    for (const map of [HOME_MAP, WORLD_MAP]) {
      for (const row of map) {
        for (const code of row) {
          expect(TILE_TYPES[code], `tile code ${JSON.stringify(code)} missing`).toBeDefined();
        }
      }
    }
  });

  it('tileColor 未知码回落深底；取色全走 G2.6 色板', () => {
    expect(tileColor('?', 0, 0)).toBe(RPG_SCENE_PALETTE.bgDeep);
    const hex = new Set(Object.values(RPG_SCENE_PALETTE) as string[]);
    for (const row of WORLD_MAP) {
      for (let c = 0; c < row.length; c++) {
        expect(hex.has(tileColor(row[c]!, c, 0)), `tile ${row[c]} color not in scene palette`).toBe(true);
      }
    }
  });

  it('hitTest：矩形内命中、边界外不命中、多热点取首个', () => {
    const spots = [
      { ...HOMESTEAD_HOTSPOT },
      { ...TRAINING_HOTSPOT },
    ];
    expect(hitTest(spots, HOMESTEAD_HOTSPOT.x + 1, HOMESTEAD_HOTSPOT.y + 1)?.id).toBe('homestead');
    // 矩形右/下边界是开区间（x+w 不含）
    expect(hitTest(spots, HOMESTEAD_HOTSPOT.x + HOMESTEAD_HOTSPOT.w, HOMESTEAD_HOTSPOT.y)).toBeNull();
    expect(hitTest(spots, -1, 0)).toBeNull();
  });
});

describe('场景与热点布点', () => {
  it('注册表含 world，缺省仍落 home', () => {
    expect(sceneOf('world').kind).toBe('world');
    expect(sceneOf(undefined).key).toBe('home');
    expect(RPG_SCENES.some((s) => s.kind === 'world')).toBe(true);
  });

  it('Home 门在南墙（最后一行），God 摆位在室内且不压门', () => {
    const door = HOME_HOTSPOTS.find((h) => h.id === 'door');
    expect(door).toBeDefined();
    expect(door!.y).toBe(HOME_MAP.length - 1);
    expect(GOD_SPOT.y).toBeLessThan(HOME_MAP.length - 1);
    expect(hitTest(HOME_HOTSPOTS, GOD_SPOT.x, GOD_SPOT.y)).toBeNull();
  });

  it('世界热点全部落在地图边界内', () => {
    for (const h of WORLD_HOTSPOTS) {
      expect(h.x + h.w).toBeLessThanOrEqual(WORLD_MAP[0]!.length);
      expect(h.y + h.h).toBeLessThanOrEqual(WORLD_MAP.length);
    }
  });

  it('G2.6 地图丰富化：松树/灌木/草丛/花草/岸石/湖水/石板/符文/耕地/幼苗 tile 全部落位', () => {
    const codes = new Set(WORLD_MAP.join('').split(''));
    for (const code of ['T', 'b', ',', '*', 'W', 'S', 's', 'y', 'f', 'g', 'P']) {
      expect(codes.has(code), `tile ${code} missing`).toBe(true);
    }
  });

  it('G2.6 solid 判定：树/石/水不可走、草丛/花/幼苗可走', () => {
    for (const code of ['T', 'W', 'S']) expect(TILE_TYPES[code]!.solid).toBe(true);
    for (const code of ['b', ',', '*', 'f', 'g', 'P', 's', 'y']) expect(TILE_TYPES[code]!.solid).toBeFalsy();
  });

  it('projectHouseSpot 沿路排开（路南 3×3、间隔 1）、越界返回 null；热点只含非隐藏项目', () => {
    expect(projectHouseSpot(0)).toEqual({ x: 2, y: 11 });
    expect(projectHouseSpot(1)).toEqual({ x: 6, y: 11 });
    expect(projectHouseSpot(-1)).toBeNull();
    const spots = projectHouseHotspots([
      { id: 1 },
      { id: 2 },
    ]);
    expect(spots.map((s) => s.id)).toEqual(['project-1', 'project-2']);
    // 每座房都在地图边界内（放不下的自然截断）
    for (const s of spots) {
      expect(s.x + s.w).toBeLessThanOrEqual(WORLD_MAP[0]!.length);
      expect(s.y + s.h).toBeLessThanOrEqual(WORLD_MAP.length);
    }
    // 槽位上限之外的截断：把第 i 座推到地图外（3 tile 宽）
    const beyond = projectHouseSpot(100);
    expect(beyond === null || beyond.x + 3 <= WORLD_MAP[0]!.length).toBe(true);
  });
});

describe('出房落点（world-exit）', () => {
  const houses = [
    { id: 11, coreProjectId: 1 },
    { id: 22, coreProjectId: 2 },
  ];
  const projects = [{ id: 1 }, { id: 2 }];

  it('场景键三件套：拼装、解析、归一 world 场景', () => {
    expect(worldExitSceneKey(11)).toBe('world-exit-11');
    expect(worldExitHouseIdOf('world-exit-11')).toBe(11);
    expect(worldExitHouseIdOf('world')).toBeNull();
    expect(worldExitHouseIdOf('world-exit-x')).toBeNull();
    expect(worldExitHouseIdOf(undefined)).toBeNull();
    expect(sceneOf('world-exit-11').kind).toBe('world');
    expect(sceneOf('world-exit-0').kind).toBe('world');
    // 房间键不受影响
    expect(sceneOf(roomSceneKey(5)).kind).toBe('room');
  });

  it('落在该房门外一格（3×3 槽位正南）：顶格与脚格都在房热点矩形之外', () => {
    const spawn = worldExitSpawnOf(11, houses, projects);
    // house 0 槽位 (2,11)、3×3 占 rows 11-13；门外一格 = (3,14)，
    // 化身占 rows 14-15（脚 = start.y+1），一步之内不误触发回屋。
    expect(spawn).toEqual({ start: { x: 3, y: 14 }, facing: 'down' });
    const hotspot = projectHouseHotspots(projects)[0]!;
    expect(hitTest([hotspot], spawn.start.x, spawn.start.y)).toBeNull(); // 顶格
    expect(hitTest([hotspot], spawn.start.x, spawn.start.y + 1)).toBeNull(); // 脚格
  });

  it('不同房槽位落点不重叠；查不到的房/项目回默认安全格', () => {
    const a = worldExitSpawnOf(11, houses, projects);
    const b = worldExitSpawnOf(22, houses, projects);
    expect(a.start).not.toEqual(b.start);
    expect(worldExitSpawnOf(99, houses, projects).start).toEqual({ x: WORLD_GOD_SPOT.x, y: WORLD_GOD_SPOT.y });
    expect(worldExitSpawnOf(11, houses, [{ id: 7 }]).start).toEqual({ x: WORLD_GOD_SPOT.x, y: WORLD_GOD_SPOT.y });
    // 项目序在末尾（房子排到路南尽头的最后一个槽位）也落门外一格，不回默认
    const late = worldExitSpawnOf(22, houses, [{ id: 9 }, { id: 2 }]);
    expect(late.start).toEqual({ x: 7, y: 14 });
  });

  it('所有槽位的门外落点都可走且不压任何热点矩形（全槽位扫描）', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
    const hotspots = projectHouseHotspots(many);
    for (let i = 0; i < 6; i++) {
      const spawn = worldExitSpawnOf(i + 1, many.map((p) => ({ id: p.id, coreProjectId: p.id })), many);
      for (let row = spawn.start.y; row <= spawn.start.y + 1; row++) {
        expect(TILE_TYPES[WORLD_MAP[row]![spawn.start.x]!]?.solid).toBeFalsy();
        for (const h of [...hotspots, HOMESTEAD_HOTSPOT, TRAINING_HOTSPOT]) {
          expect(hitTest([h], spawn.start.x, row)).toBeNull();
        }
      }
    }
  });
});

describe('rpg-boot 真计数器', () => {
  it('六格清单齐（五请求 + 本地模块）且 settle/failed/retry 状态机成立', () => {
    expect(RPG_BOOT_ITEMS.length).toBe(6);
    const keys = RPG_BOOT_ITEMS.map((i) => i.key);
    expect(keys).toEqual(['roles', 'orchestrations', 'runs', 'sessions', 'projects', 'modules']);
    const snap0 = rpgBoot.snapshot();
    const before = snap0.done;
    const key = 'roles' as RpgBootKey;
    rpgBoot.settle(key, false);
    expect(rpgBoot.snapshot().failed).toBe(true);
    rpgBoot.retry(key);
    expect(rpgBoot.snapshot().failed).toBe(false);
    rpgBoot.settle(key, true);
    expect(rpgBoot.snapshot().done).toBe(before + 1);
  });
});
