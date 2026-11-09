import { describe, it, expect } from 'vitest';
import { canWalk, resolveStep, triggerHotspotAt, cameraOffset, DIR_DELTA } from '../walker';
import { HOME_MAP, HOME_HOTSPOTS, WORLD_MAP, WORLD_HOTSPOTS, ROOM_MAP, ROOM_HOTSPOTS, GOD_SPOT, ROOM_GOD_SPOT, HOMESTEAD_HOTSPOT } from '../worldmap';

describe('canWalk 碰撞判据', () => {
  it('Home 内部木地板可走、四墙 # 与门两侧不可走、门格 D 可走', () => {
    expect(canWalk(HOME_MAP, 9, 5)).toBe(true);
    expect(canWalk(HOME_MAP, 0, 0)).toBe(false);
    expect(canWalk(HOME_MAP, 8, 11)).toBe(false); // 南墙 # 段
    expect(canWalk(HOME_MAP, 9, 11)).toBe(true); // 门 D
    expect(canWalk(HOME_MAP, 10, 11)).toBe(true);
  });

  it('越界（四边）一律拒绝', () => {
    expect(canWalk(HOME_MAP, -1, 5)).toBe(false);
    expect(canWalk(HOME_MAP, 20, 5)).toBe(false);
    expect(canWalk(HOME_MAP, 9, -1)).toBe(false);
    expect(canWalk(HOME_MAP, 9, 12)).toBe(false);
  });

  it('World 的 T/W/S solid 地形与 P/F/, 可走地形全图一致', () => {
    for (let y = 0; y < WORLD_MAP.length; y++) {
      const row = WORLD_MAP[y]!;
      for (let x = 0; x < row.length; x++) {
        const code = row[x]!;
        expect(canWalk(WORLD_MAP, x, y)).toBe(!'TWS'.includes(code));
      }
    }
  });
});

describe('resolveStep 格子步进', () => {
  it('四方向各走一格（Home 室内从 God 摆位起步）', () => {
    expect(resolveStep(HOME_MAP, GOD_SPOT, 'up')).toEqual({ x: 9, y: 4 });
    expect(resolveStep(HOME_MAP, GOD_SPOT, 'down')).toEqual({ x: 9, y: 6 });
    expect(resolveStep(HOME_MAP, GOD_SPOT, 'left')).toEqual({ x: 8, y: 5 });
    expect(resolveStep(HOME_MAP, GOD_SPOT, 'right')).toEqual({ x: 10, y: 5 });
  });

  it('撞墙拒绝返回 null（Home 北墙上一格向上 = null）', () => {
    expect(resolveStep(HOME_MAP, { x: 1, y: 1 }, 'up')).toBeNull();
    expect(resolveStep(HOME_MAP, { x: 1, y: 10 }, 'down')).toBeNull();
  });

  it('Room 场景同样成立（God 摆位 + 南墙门）', () => {
    expect(resolveStep(ROOM_MAP, ROOM_GOD_SPOT, 'up')).toEqual({ x: 6, y: 4 });
    expect(resolveStep(ROOM_MAP, { x: 9, y: 12 }, 'down')).toEqual({ x: 9, y: 13 }); // 门格
  });

  it('DIR_DELTA 是单位向量', () => {
    for (const d of Object.values(DIR_DELTA)) {
      expect(Math.abs(d.x) + Math.abs(d.y)).toBe(1);
    }
  });
});

describe('triggerHotspotAt 走到即触发', () => {
  it('Home：站上门格（脚格判定，1×2 化身 y=10 时脚 = y+1=11）触发门热点', () => {
    const h = triggerHotspotAt(HOME_HOTSPOTS, { x: 9, y: 10 });
    expect(h?.id).toBe('door');
  });

  it('Home：离门一格不触发', () => {
    expect(triggerHotspotAt(HOME_HOTSPOTS, { x: 9, y: 5 })).toBeNull();
  });

  it('World：宅基地矩形内（头格或脚格）触发', () => {
    const h = triggerHotspotAt(WORLD_HOTSPOTS, { x: HOMESTEAD_HOTSPOT.x + 1, y: HOMESTEAD_HOTSPOT.y });
    expect(h?.id).toBe('homestead');
  });

  it('Room：门格触发回世界地图', () => {
    expect(triggerHotspotAt(ROOM_HOTSPOTS, { x: 9, y: 12 })?.id).toBe('room-door');
  });
});

describe('cameraOffset 镜头裁决', () => {
  it('视口装得下全图 → 锁定 offset 0（Home 20×24=480px 宽）', () => {
    expect(cameraOffset(HOME_MAP, GOD_SPOT, 480, 288, 24)).toEqual({ x: 0, y: 0 });
  });

  it('World 672px > 视口 → 跟随且钳制贴边', () => {
    // 化身在宅基地附近（左上），镜头偏左但钳在 0
    const left = cameraOffset(WORLD_MAP, { x: 4, y: 4 }, 375, 300, 24);
    expect(left.x).toBe(0);
    // 化身在右侧水边，镜头贴右缘
    const right = cameraOffset(WORLD_MAP, { x: 24, y: 9 }, 375, 300, 24);
    expect(right.x).toBe(672 - 375);
  });

  it('视口尺寸未知（0）回落 offset 0', () => {
    expect(cameraOffset(WORLD_MAP, GOD_SPOT, 0, 0, 24)).toEqual({ x: 0, y: 0 });
  });
});
