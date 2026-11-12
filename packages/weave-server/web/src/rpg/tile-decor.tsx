import { TILE_PX, RPG_SCENE_PALETTE as P } from './worldmap';
import { DOOR_TILES } from './tileset-map';
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

/** 项目房体（3×3 热点格，¾ 侧俯瞰三面，2026-11-11 用户裁决：房屋应可见三个
 *  面——正面墙 + 东侧山墙 + 屋顶南坡）。tile 网格不动（canvas/引擎都是俯视
 *  正交），体感靠三方块的像素阶梯：屋顶右倾梯形（脊偏左、檐口右探 = 透视
 *  挤压）+ 瓦楞横纹，东墙深一档木色、顶边随屋檐斜率，南墙亮木 + 谷仓门
 * （复用图集门 tile，seed 奇偶换扇）+ 暖窗光。门在南墙正中 = 出房落点语义。
 *  房高溢出 3×3 槽顶部（西北向抬升），z-index 由调用方按脚点行排（painter
 *  order），站在房后的东西被正确盖住。 */
export function HouseTile({ seed, sprites }: { seed: number; sprites: TileSprites | null }): React.ReactNode {
  const doorTile = sprites?.get(DOOR_TILES[seed % 2]!);
  const roofBands = `repeating-linear-gradient(to bottom, ${P.roofRidge} 0px 3px, ${P.roof} 3px 10px, ${P.roofDeep} 10px 12px)`;
  const wallPlanks = `repeating-linear-gradient(to bottom, ${P.wallWood} 0px 7px, ${P.woodDeep} 7px 9px)`;
  const W = TILE_PX * 3; // 72
  // 屋顶：脊线在槽顶上方 8px、偏左（x 10-50）；檐口压到 y≈42、左右各探 5px
  const roofClip = 'polygon(14% 0%, 70% 0%, 107% 100%, -6% 100%)';
  return (
    <div className="absolute inset-0" style={{ overflow: 'visible' }} aria-hidden>
      {/* 房前独立落影（先画，压在墙脚之下） */}
      <div style={{ position: 'absolute', left: -2, right: 2, top: W - 3, height: 8, background: 'rgba(26,23,33,0.32)' }} />
      {/* 东侧山墙（暗面）：顶边随屋檐向右上挑（透视斜率 = 屋顶右缘同斜率） */}
      <div
        style={{
          position: 'absolute',
          left: W - 18,
          top: 30,
          width: 18,
          height: W - 30,
          background: wallPlanks,
          filter: 'brightness(0.72)',
          clipPath: 'polygon(0% 38%, 100% 0%, 100% 100%, 0% 100%)',
        }}
      >
        {/* 山墙小窗（暖光，夜灯感） */}
        <div style={{ position: 'absolute', left: 5, top: 18, width: 7, height: 7, background: P.windowGlow, boxShadow: `inset 0 0 0 1px ${P.woodDeep}` }} />
      </div>
      {/* 南面正墙（亮面）：木墙板 + 檐口压影 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 40,
          width: W - 16,
          height: W - 40,
          background: wallPlanks,
        }}
      >
        {/* 檐口在墙上投的影（两道暗线，像素阶） */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 2, background: 'rgba(26,23,33,0.55)' }} />
        {/* 暖窗（左） */}
        <div style={{ position: 'absolute', left: 5, top: 6, width: 9, height: 9, background: P.windowGlow, boxShadow: `inset 0 0 0 1px ${P.woodDeep}` }} />
        {/* 墙脚暗缘 */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: 'rgba(26,23,33,0.4)' }} />
      </div>
      {/* 南墙正中 = 谷仓门（图集门 tile，16px 艺术格放大 1.5×=24px 对齐门格） */}
      {doorTile != null && (
        <div
          style={{
            position: 'absolute',
            left: 24,
            top: 40,
            width: 24,
            height: 24,
            backgroundImage: `url(${doorTile})`,
            backgroundSize: '24px 24px',
            imageRendering: 'pixelated',
          }}
        />
      )}
      {doorTile == null && (
        /* 图集未就绪的门兜底（木门深色块 + 门框） */
        <div style={{ position: 'absolute', left: 24, top: 40, width: 24, height: 24, background: P.door, boxShadow: `inset 0 0 0 2px ${P.woodDeep}` }} />
      )}
      {/* 屋顶南坡（三方块的视觉主导面）：右倾梯形 + 瓦楞横纹 + 脊线帽 */}
      <div
        style={{
          position: 'absolute',
          left: -5,
          top: -8,
          width: W + 10,
          height: 50,
          background: roofBands,
          clipPath: roofClip,
          imageRendering: 'pixelated',
        }}
      >
        {/* 脊线帽（沿梯形上边） */}
        <div style={{ position: 'absolute', left: '14%', width: '56%', top: 0, height: 2, background: P.roofRidge, boxShadow: '0 1px 0 rgba(26,23,33,0.4)' }} />
        {/* 屋顶右缘高光（透视挤压的受光边） */}
        <div style={{ position: 'absolute', right: 0, top: '10%', width: 2, height: '88%', background: P.roofRidge, opacity: 0.5 }} />
        {/* 檐口下缘投影（压在两墙之上） */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: 'rgba(26,23,33,0.45)' }} />
        {/* 屋顶烟囱（seed 奇偶摆位微差） */}
        <div style={{ position: 'absolute', left: seed % 2 ? '62%' : '22%', top: 2, width: 6, height: 7, background: P.stele, boxShadow: `inset 0 -2px 0 ${P.wallWood}` }} />
      </div>
    </div>
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
