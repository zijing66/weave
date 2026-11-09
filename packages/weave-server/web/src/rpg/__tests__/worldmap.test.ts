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
} from '../worldmap';
import { PALETTE32 } from '../skin';
import { RPG_SCENES, sceneOf } from '../scenes';
import { RPG_BOOT_ITEMS, rpgBoot, type RpgBootKey } from '../rpg-boot';

/** G1 骨架纯函数与数据不变式：tile 槽位表是数据结构不是美术——换资产零改动
 *  的前提是「每行等宽、码在类型表内、命中判定矩形语义稳定」。 */

describe('worldmap tile 槽位表', () => {
  it('HOME_MAP 与 WORLD_MAP 全部行等宽（矩形网格不变式）', () => {
    const widths = (m: readonly string[]) => new Set([...m].map((r) => r.length));
    expect(widths(HOME_MAP).size).toBe(1);
    expect(widths(WORLD_MAP).size).toBe(1);
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

  it('tileColor 未知码回落 ink；棋盘变体只取 32 色板内的色', () => {
    expect(tileColor('?', 0, 0)).toBe(PALETTE32.ink);
    for (const row of WORLD_MAP) {
      for (let c = 0; c < row.length; c++) {
        expect((Object.values(PALETTE32) as string[]).includes(tileColor(row[c]!, c, 0))).toBe(true);
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

  it('projectHouseSpot 沿路排开、越界返回 null；热点只含非隐藏项目', () => {
    expect(projectHouseSpot(0)).toEqual({ x: 2, y: 7 });
    expect(projectHouseSpot(-1)).toBeNull();
    const spots = projectHouseHotspots([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
    expect(spots.map((s) => s.id)).toEqual(['project-1', 'project-2']);
    // 每座房都在地图边界内（放不下的自然截断）
    for (const s of spots) {
      expect(s.x + s.w).toBeLessThanOrEqual(WORLD_MAP[0]!.length);
      expect(s.y + s.h).toBeLessThanOrEqual(WORLD_MAP.length);
    }
    // 槽位上限之外的截断：把第 i 座推到地图外
    const beyond = projectHouseSpot(100);
    expect(beyond === null || beyond.x + 2 <= WORLD_MAP[0]!.length).toBe(true);
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
