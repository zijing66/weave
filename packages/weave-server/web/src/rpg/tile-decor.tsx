import { TILE_PX, RPG_SCENE_PALETTE as P } from './worldmap';
import { houseGridTiles } from './tileset-map';
import type { TileSprites } from './tile-atlas';

/**
 * tile 级装饰部件（G2.6 第三轮资产化）：石碑 + 青水晶仍走 CSS 色块部件
 * （图集无对应 tile）；松树已由 tileset-map 的 sprite 层接管（图集松树），
 * PineTile 部件随之退役。项目房体 = 图集九宫（山墙带/梁墙/平墙/窗/谷仓门），
 * background 多层一次成画，加载失败退 wallWood 纯色。
 */

/** 石碑 + 青水晶（修炼点旁，参考图右侧石碑阵）：灰石碑身 + 顶帽 + 底座青晶
 *  发光块（box-shadow 青光晕，克制的静态光）。 */
export function SteleTile(): React.ReactNode {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {/* 碑身 */}
      <div style={{ position: 'absolute', left: 8, top: 4, width: 8, height: 16, background: P.stele }} />
      {/* 顶帽 */}
      <div style={{ position: 'absolute', left: 6, top: 2, width: 12, height: 3, background: P.steleTop }} />
      {/* 青水晶发光块（碑脚） */}
      <div
        style={{
          position: 'absolute',
          left: 10,
          top: 18,
          width: 4,
          height: 4,
          background: P.crystal,
          boxShadow: `0 0 6px ${P.crystal}, 0 0 12px ${P.crystalDeep}`,
        }}
      />
    </div>
  );
}

/** 项目房体（3×3 热点格，G2.6 资产化）：图集九宫一次成画——顶行山墙 X 带、
 *  中行带梁墙 + 蓝窗、底行平墙 + 谷仓门（seed 奇偶换门）。backgroundColor
 *  兜底（图集加载失败退木墙色块）。 */
export function HouseTile({ seed, sprites }: { seed: number; sprites: TileSprites | null }): React.ReactNode {
  const tiles = houseGridTiles(seed);
  const images: string[] = [];
  const positions: string[] = [];
  tiles.forEach((n, i) => {
    const img = sprites?.get(n);
    if (!img) return;
    images.push(`url(${img})`);
    positions.push(`${(i % 3) * TILE_PX}px ${Math.floor(i / 3) * TILE_PX}px`);
  });
  return (
    <div
      className="absolute inset-0"
      aria-hidden
      style={{
        backgroundColor: P.wallWood,
        backgroundImage: images.join(',') || undefined,
        backgroundPosition: positions.join(',') || undefined,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
      }}
    />
  );
}

/**
 * 装饰层派生（纯函数，可单测）：扫 tilemap，符文格出石碑（松树已由图集
 * sprite 层接管，不再派生）。返回 { x, y, kind, seed } 列表——渲染层按 tile 摆。
 * 房体由项目房热点派生（动态），不在此处。
 */
export function tileDecor(
  map: readonly string[],
): { x: number; y: number; kind: 'stele'; seed: number }[] {
  const out: { x: number; y: number; kind: 'stele'; seed: number }[] = [];
  for (let r = 0; r < map.length; r++) {
    const row = map[r] ?? '';
    for (let c = 0; c < row.length; c++) {
      if (row[c] === 'y') out.push({ x: c, y: r, kind: 'stele', seed: c + r });
    }
  }
  return out;
}
