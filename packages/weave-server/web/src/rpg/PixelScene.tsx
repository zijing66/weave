import { useMemo, useSyncExternalStore } from 'react';
import { useT } from '@/i18n/I18nProvider';
import {
  TILE_PX,
  tileColor,
  hitTest,
  type TileMap,
  type Hotspot,
} from './worldmap';
import { rpgBoot, type RpgBootSnapshot } from './rpg-boot';

/**
 * 红白机像素场景渲染器（G1 骨架）：tilemap 逐格渲成 CSS 色块（32 色板 +
 * 棋盘变体防塑料感），热点 = 绝对定位的透明命中区（悬停提亮 + label），
 * 角色占 1×2 tile 静态摆位（行走 G4）。tile 类型表与命中判定归 worldmap.ts——
 * 换真 tileset 资产 = 换渲染映射，本组件结构不动。
 */

export function PixelScene({
  map,
  hotspots,
  onHotspot,
  sprites,
  children,
}: {
  map: TileMap;
  hotspots: readonly Hotspot[];
  onHotspot: (h: Hotspot) => void;
  /** 静态摆位的角色（1×2 tile）：px = tile 坐标。 */
  sprites?: readonly { key: string; x: number; y: number; node: React.ReactNode }[];
  /** 场景内浮层（表单区/详情面板，铺在画布上方）。 */
  children?: React.ReactNode;
}) {
  const t = useT();
  const cols = map[0]?.length ?? 0;
  const rows = map.length;

  const cells = useMemo(() => {
    const out: React.ReactNode[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const code = map[r]?.[c] ?? '.';
        out.push(
          <div
            key={`${r}-${c}`}
            style={{
              position: 'absolute',
              left: c * TILE_PX,
              top: r * TILE_PX,
              width: TILE_PX,
              height: TILE_PX,
              background: tileColor(code, c, r),
            }}
          />,
        );
      }
    }
    return out;
  }, [map, cols, rows]);

  return (
    <div
      className="rpg-pixel-scene relative overflow-auto rounded border border-[var(--w-border)]"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x0 = e.currentTarget.scrollLeft;
        const y0 = e.currentTarget.scrollTop;
        const h = hitTest(hotspots, Math.floor((e.clientX - rect.left + x0) / TILE_PX), Math.floor((e.clientY - rect.top + y0) / TILE_PX));
        if (h) {
          e.stopPropagation();
          onHotspot(h);
        }
      }}
    >
      <div style={{ position: 'relative', width: cols * TILE_PX, height: rows * TILE_PX }}>
        {cells}
        {/* 墙体/门用 tile 类型表补充辨识度：热点矩形画提亮描边 */}
        {sprites?.map((s) => (
          <div key={s.key} style={{ position: 'absolute', left: s.x * TILE_PX, top: s.y * TILE_PX, width: TILE_PX, height: TILE_PX * 2 }}>
            {s.node}
          </div>
        ))}
        {/* 热点层（画布内可见命中区） */}
        {hotspots.map((h) => (
          <div
            key={h.id}
            style={{
              position: 'absolute',
              left: h.x * TILE_PX,
              top: h.y * TILE_PX,
              width: h.w * TILE_PX,
              height: h.h * TILE_PX,
            }}
            className="rpg-hotspot"
            title={t(h.labelKey as 'rpg.doorExit')}
            onClick={(e) => {
              e.stopPropagation();
              onHotspot(h);
            }}
          />
        ))}
        {children}
      </div>
    </div>
  );
}

/** 进度条（判据⑥）：红白机分段像素条 + 当前项名 + 失败项重试。 */
export function RpgBootBar() {
  const t = useT();
  const snap: RpgBootSnapshot = useSyncExternalStore(rpgBoot.subscribe, rpgBoot.snapshot, rpgBoot.snapshot);
  const current = snap.items.find((i) => i.state === 'failed') ?? snap.items.find((i) => i.state === 'pending') ?? null;

  return (
    <div className="rpg-boot-bar">
      <div className="rpg-boot-cells">
        {snap.items.map((i) => (
          <div
            key={i.key}
            className={
              'rpg-boot-cell' +
              (i.state === 'done' ? ' done' : i.state === 'failed' ? ' failed' : '')
            }
          />
        ))}
      </div>
      {current && (
        <div className="rpg-boot-label">
          {current.state === 'failed'
            ? t('rpg.bootFailed', { item: t(current.labelKey as 'rpg.bootRoles') })
            : t('rpg.bootLoading', { item: t(current.labelKey as 'rpg.bootRoles') })}
          {current.state === 'failed' && (
            <button
              type="button"
              className="ml-2 rounded bg-[var(--w-surface-2)] px-2 py-0.5 text-[11px] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)]"
              onClick={() => {
                rpgBoot.retry(current.key);
                rpgRetryHandlers.get(current.key)?.();
              }}
            >
              {t('rpg.bootRetry')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 重试处理器注册表（数据 hook 侧登记真实重拉；UI 不发假请求）。 */
export const rpgRetryHandlers = new Map<string, () => void>();
