import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { useMediaQuery } from '@/lib/use-media-query';
import {
  TILE_PX,
  tileColor,
  hitTest,
  type Hotspot,
} from './worldmap';
import {
  resolveStep,
  triggerHotspotAt,
  cameraOffset,
  DIR_DELTA,
  type Cell,
  type Dir,
  type TileMap as WalkTileMap,
} from './walker';
import { rpgBoot, type RpgBootSnapshot } from './rpg-boot';

/**
 * 红白机像素场景渲染器（G1 骨架 + G4 行走）：tilemap 逐格渲成 CSS 色块，热点 =
 * 绝对定位的透明命中区，角色占 1×2 tile。G4：上帝化身格子步进（离散 transform，
 * 无插值）——键盘方向键/WASD 桌面、虚拟方向键触屏（use-media-query 唯一判断
 * 入口）、点一格 = 朝那格走一步或触发热点、长按连走、镜头跟随（画布自己滚，
 * 页面零横向溢出）。行走/碰撞/镜头裁决归 walker.ts 纯函数。
 */

/** 步进节拍（ms）：长按连走间隔——红白机手感约 6 格/秒。 */
const STEP_MS = 160;
/** 点按 vs 拖动（平移镜头）的位移分流阈值（px）。 */
const DRAG_THRESHOLD_PX = 8;

export function PixelScene({
  map,
  hotspots,
  onHotspot,
  sprites,
  /** 上帝化身（可走）：摆位由内部状态驱动，初始格由调用方给。 */
  god,
  children,
}: {
  map: WalkTileMap;
  hotspots: readonly Hotspot[];
  onHotspot: (h: Hotspot) => void;
  /** 静态摆位的角色（1×2 tile）：px = tile 坐标（NPC/席位不动）。 */
  sprites?: readonly { key: string; x: number; y: number; node: React.ReactNode }[];
  /** 上帝化身（可走）；不给 = 该场景无行走（既有皮肤面）。 */
  god?: GodAvatar;
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

  // ---- G4 行走状态（god 给出才启用） ----
  const [pos, setPos] = useState<Cell | null>(() => god?.start ?? null);
  // 场景切换（map 变了 = 换场景）或化身出现（异步数据后到，god 从 undefined
  // 变有值）时落初始格——行走进行中不回卷（pos 已非 null 才是「进行中」）。
  const mapKey = useMemo(() => `${cols}x${rows}`, [cols, rows]);
  const hasGod = god != null;
  useEffect(() => {
    setPos((cur) => cur ?? god?.start ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey, hasGod]);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setView({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const cam = useMemo(
    () => (pos ? cameraOffset(map, pos, view.w, view.h, TILE_PX) : { x: 0, y: 0 }),
    [map, pos, view.w, view.h],
  );
  // 镜头跟随：画布自己滚（overflow-auto 的 scrollTop/Left），页面级溢出恒 0
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !god) return;
    el.scrollLeft = cam.x;
    el.scrollTop = cam.y;
  }, [cam, god]);

  // 热点触发统一出口：走到格上触发 = 点击热点同一处（onHotspot 由调用方路由）
  const fireHotspot = useCallback(
    (h: Hotspot) => onHotspot(h),
    [onHotspot],
  );

  const stepAndTrigger = useCallback(
    (dir: Dir) => {
      setPos((cur) => {
        if (!cur) return cur;
        const next = resolveStep(map, cur, dir);
        if (!next) return cur;
        const h = triggerHotspotAt(hotspots, next);
        if (h) window.setTimeout(() => fireHotspot(h), 0);
        return next;
      });
    },
    [map, hotspots, fireHotspot],
  );

  // 键盘：方向键 + WASD（桌面指针常态；触屏也有键时不冲突——按下即走）
  useEffect(() => {
    if (!god) return;
    const keyDir = (code: string): Dir | null => {
      switch (code) {
        case 'ArrowUp':
        case 'KeyW':
          return 'up';
        case 'ArrowDown':
        case 'KeyS':
          return 'down';
        case 'ArrowLeft':
        case 'KeyA':
          return 'left';
        case 'ArrowRight':
        case 'KeyD':
          return 'right';
        default:
          return null;
      }
    };
    const held = new Set<Dir>();
    let timer = 0;
    const pump = () => {
      window.clearInterval(timer);
      timer = 0;
      if (held.size === 0) return;
      const dir = [...held][held.size - 1]!;
      stepAndTrigger(dir);
      timer = window.setInterval(() => stepAndTrigger(dir), STEP_MS);
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const dir = keyDir(e.code);
      if (!dir) return;
      e.preventDefault();
      held.add(dir);
      pump();
    };
    const onUp = (e: KeyboardEvent) => {
      const dir = keyDir(e.code);
      if (!dir) return;
      held.delete(dir);
      pump();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.clearInterval(timer);
    };
  }, [god, stepAndTrigger]);

  // 画布点按：点一格 = 朝那格走一步（曼哈顿主轴；走到热点格即触发）；
  // 拖动 = 平移镜头（位移超阈值判拖，与点按分流——§11 手势分流约束）。
  // pointerId 记名 + setPointerCapture 拖跟；拖动落定回写 scrollTop/Left（镜头）
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollL: number;
    scrollT: number;
    moved: boolean;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      scrollL: e.currentTarget.scrollLeft,
      scrollT: e.currentTarget.scrollTop,
      moved: false,
    };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    e.currentTarget.scrollLeft = d.scrollL - dx;
    e.currentTarget.scrollTop = d.scrollT - dy;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.pointerId !== e.pointerId || d.moved) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const tx = Math.floor((e.clientX - rect.left + e.currentTarget.scrollLeft) / TILE_PX);
    const ty = Math.floor((e.clientY - rect.top + e.currentTarget.scrollTop) / TILE_PX);
    // 双通道保留：点在热点上 = 直接触发（键盘时代的 hitTest 点按）
    const h = hitTest(hotspots, tx, ty);
    if (h) {
      fireHotspot(h);
      return;
    }
    // 点空地 = 朝那格走一步（主轴：水平位移大先横走，否则竖走）
    if (!pos) return;
    const ddx = tx - pos.x;
    const ddy = ty - (pos.y + 1); // 脚格
    if (ddx === 0 && ddy === 0) return;
    const dir: Dir =
      Math.abs(ddx) >= Math.abs(ddy) ? (ddx > 0 ? 'right' : 'left') : ddy > 0 ? 'down' : 'up';
    stepAndTrigger(dir);
  };

  const touch = useMediaQuery('(hover: none), (pointer: coarse)');

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        ref={viewportRef}
        className="rpg-pixel-scene relative min-h-52 overflow-auto rounded border border-[var(--w-border)]"
        onPointerDown={god ? onPointerDown : undefined}
        onPointerMove={god ? onPointerMove : undefined}
        onPointerUp={god ? onPointerUp : undefined}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <div style={{ position: 'relative', width: cols * TILE_PX, height: rows * TILE_PX }}>
          {cells}
          {/* 静态摆位角色（席位/NPC 不动——G4 裁决：只有上帝化身可走） */}
          {sprites?.map((s) => (
            <div key={s.key} style={{ position: 'absolute', left: s.x * TILE_PX, top: s.y * TILE_PX, width: TILE_PX, height: TILE_PX * 2 }}>
              {s.node}
            </div>
          ))}
          {/* 上帝化身：transform 离散步进（translate 整格），无逐帧重绘 */}
          {god && pos && (
            <div
              className="rpg-god-sprite"
              style={{ position: 'absolute', width: TILE_PX, height: TILE_PX * 2, transform: `translate(${pos.x * TILE_PX}px, ${pos.y * TILE_PX}px)` }}
            >
              {god.node}
            </div>
          )}
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
              onPointerUp={(e) => {
                e.stopPropagation();
                fireHotspot(h);
              }}
            />
          ))}
          {children}
        </div>
      </div>
      {god && touch && (
        <Dpad onStep={stepAndTrigger} />
      )}
    </div>
  );
}

/** 虚拟方向键（触屏/窄指针，§11 触控面 ≥44px）：按下即走一步、按住连走。 */
function Dpad({ onStep }: { onStep: (dir: Dir) => void }) {
  const timerRef = useRef<number>(0);
  const start = (dir: Dir) => {
    onStep(dir);
    window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => onStep(dir), STEP_MS);
  };
  const stop = () => {
    window.clearInterval(timerRef.current);
    timerRef.current = 0;
  };
  useEffect(() => stop, []);
  const btn = (dir: Dir, label: string, style: React.CSSProperties): React.ReactNode => (
    <button
      type="button"
      aria-label={label}
      style={{ width: 52, height: 52, ...style }}
      className="rpg-dpad-btn select-none text-lg text-[var(--w-text-dim)]"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start(dir);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      {DIR_ARROW[dir]}
    </button>
  );
  return (
    <div
      className="relative mx-auto shrink-0"
      style={{ width: 160, height: 160 }}
      onPointerUp={stop}
    >
      {btn('up', '↑', { position: 'absolute', left: 54, top: 0 })}
      {btn('down', '↓', { position: 'absolute', left: 54, top: 108 })}
      {btn('left', '←', { position: 'absolute', left: 0, top: 54 })}
      {btn('right', '→', { position: 'absolute', left: 108, top: 54 })}
    </div>
  );
}

const DIR_ARROW: Record<Dir, string> = { up: '▲', down: '▼', left: '◀', right: '▶' };

export interface GodAvatar {
  /** 初始格（tile 坐标，1×2 顶格）。 */
  start: Cell;
  node: React.ReactNode;
}

export { DIR_DELTA };

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
