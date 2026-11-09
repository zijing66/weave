import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { useMediaQuery } from '@/lib/use-media-query';
import {
  TILE_PX,
  tileColor,
  hitTest,
  RPG_SCENE_PALETTE,
  type Hotspot,
} from './worldmap';
import { SteleTile, tileDecor } from './tile-decor';
import { collectBaseRuns, collectSpriteRuns, type TileRun } from './tileset-map';
import { useTileSprites } from './tile-atlas';
import {
  resolveStep,
  triggerHotspotAt,
  cameraOffset,
  viewportScale,
  DIR_DELTA,
  type Cell,
  type Dir,
  type TileMap as WalkTileMap,
} from './walker';
import { rpgBoot, type RpgBootSnapshot } from './rpg-boot';

/**
 * 红白机像素场景渲染器（G1 骨架 + G4 行走 + G2.5 全屏化）：tilemap 逐格渲成
 * CSS 色块，热点 = 绝对定位的透明命中区，角色占 1×2 tile。G4：上帝化身格子
 * 步进（离散 transform，无插值）——键盘方向键/WASD 桌面、虚拟方向键触屏
 * （use-media-query 唯一判断入口）、点一格 = 朝那格走一步或触发热点、长按连走。
 * G2.5：画布铺满父级主区（拆卡片框），世界延展出屏由满屏镜头跟随（世界层整块
 * translate，拖动平移并进 cam）；页面级溢出恒 0。操作按钮（dpad）不浮在画面上
 * ——独立控制带（竖屏在下、横屏在右，orientation 媒体查询）。行走/碰撞/镜头
 * 裁决归 walker.ts 纯函数。
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
  onEmptyClick,
  /** 化身当前格的只读探针（E 键「面前热点」读位用；ref 挂回调，读时回调）。 */
  godPosProbe,
  indoor,
  /** 视口内浮层（不随镜头平移；底字幕这类「贴屏幕」的层用）。 */
  viewportOverlay,
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
  /** 点空处（无热点、非拖动的画布点按）——选中详情条「点空收起」用。 */
  onEmptyClick?: () => void;
  /** 可选：调用方持 ref，PixelScene 每拍把「读位回调」写进去。 */
  godPosProbe?: React.MutableRefObject<((read: (pos: Cell | null) => void) => void) | null> | null;
  /** 视口内浮层（不随镜头平移；底字幕这类「贴屏幕」的层用）。 */
  viewportOverlay?: React.ReactNode;
  /** 相机策略分档（G2.6 室内裁决）：false（缺省，world）= 视口自适应放大
   *  铺满视口；true（室内 Home/Room）= 不放大、地图装得下时世界层居中、
   *  四周露 viewport 深底（黑边是想要形态）。 */
  indoor?: boolean;
}) {
  const t = useT();
  const cols = map[0]?.length ?? 0;
  const rows = map.length;

  // G2.6 第三轮资产化：底图/sprite 双层 run——底图 run 同行同 kind 合并
  // （backgroundColor 兜底 + 单 tile data URL repeat-x 取块），sprite run
  // 承载树/灌木/花/作物/岸石透明贴图。div 数从逐格 1728 降到 ~200（世界层）。
  const tileSprites = useTileSprites();
  const baseRuns = useMemo(() => collectBaseRuns(map, indoor), [map, indoor]);
  const spriteRuns = useMemo(() => collectSpriteRuns(map), [map]);

  const baseRunNode = (run: TileRun): React.ReactNode => {
    const code = map[run.row]?.[run.col] ?? '.';
    // 北墙：底色墙暗面（立起段），墙板 tile 用 repeat-x 压在下半（position
    // 下移 TILE_PX、容器裁掉上半）
    const color = run.northWall
      ? RPG_SCENE_PALETTE.wallDark
      : tileColor(code, run.col, run.row);
    const img = run.baseTile ? tileSprites?.get(run.baseTile) : undefined;
    return (
      <div
        key={`b-${run.row}-${run.col}`}
        style={{
          position: 'absolute',
          left: run.col * TILE_PX,
          top: run.row * TILE_PX - (run.northWall ? TILE_PX : 0),
          width: run.span * TILE_PX,
          height: run.northWall ? TILE_PX * 2 : TILE_PX,
          backgroundColor: color,
          backgroundImage: img ? `url(${img})` : undefined,
          backgroundRepeat: 'repeat-x',
          backgroundSize: `${TILE_PX}px ${TILE_PX}px`,
          backgroundPosition: run.northWall ? `0 ${TILE_PX}px` : undefined,
          imageRendering: 'pixelated',
          pointerEvents: 'none',
        }}
      />
    );
  };

  const spriteRunNode = (run: TileRun): React.ReactNode => {
    const img = run.spriteTile ? tileSprites?.get(run.spriteTile) : undefined;
    return (
      <div
        key={`s-${run.row}-${run.col}`}
        style={{
          position: 'absolute',
          left: run.col * TILE_PX,
          top: run.row * TILE_PX,
          width: run.span * TILE_PX,
          height: TILE_PX,
          zIndex: 1,
          backgroundImage: img ? `url(${img})` : undefined,
          backgroundRepeat: 'repeat-x',
          backgroundSize: `${TILE_PX}px ${TILE_PX}px`,
          imageRendering: 'pixelated',
          pointerEvents: 'none',
        }}
      />
    );
  };

  // G2.6 参考图逐像素对齐：符文格出石碑（装饰层纯派生；松树已入 sprite 层）。
  const decor = useMemo(() => tileDecor(map), [map]);

  // ---- G4 行走状态（god 给出才启用） ----
  const [pos, setPos] = useState<Cell | null>(() => god?.start ?? null);
  // E 键探针：把「同步读当前格」的回调交给调用方（只读，不写状态）。
  useEffect(() => {
    if (!godPosProbe) return;
    godPosProbe.current = (read) => read(pos);
    return () => {
      godPosProbe.current = null;
    };
  });
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

  // G2.5 镜头升级：viewport 从 overflow-auto 滚动改为满屏镜头（世界层整块
  // translate）——滚动容器没了，拖动平移与镜头跟随都落到 cam 一处（transform
  // 直改一步一格，页面级溢出恒 0 不变）。
  // G2.6 复测欠账：满屏世界 = 视口自适应放大（世界层整层 scale，0.25 步进保
  // 像素感且不过档）——镜头/点按命中数学全按缩放后的有效视野（视口 ÷ scale）口径。
  const scale = useMemo(
    () => (indoor ? 1 : viewportScale(map, view.w, view.h, TILE_PX)),
    [indoor, map, view.w, view.h],
  );
  const cam = useMemo(
    () =>
      pos
        ? cameraOffset(map, pos, view.w / scale, view.h / scale, TILE_PX)
        : { x: 0, y: 0 },
    [map, pos, view.w, view.h, scale],
  );
  const [pan, setPan] = useState({ x: 0, y: 0 });
  useEffect(() => setPan({ x: 0, y: 0 }), [mapKey, hasGod, scale]);

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
    [map, hotspots, fireHotspot, onEmptyClick],
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
  // pointerId 记名 + setPointerCapture 拖跟；拖动偏移并进 cam（世界层整块
  // translate），镜头不因拖动回弹——无 god 的场景平移只在本拖动会话内生效。
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: cam.x + pan.x,
      baseY: cam.y + pan.y,
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
    // pan 与 cam 同口径（世界 px）：屏上位移 ÷ scale 折回世界单位
    setPan({ x: d.baseX - cam.x - dx / scale, y: d.baseY - cam.y - dy / scale });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.pointerId !== e.pointerId || d.moved) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const camX = (cam.x + pan.x) * scale;
    const camY = (cam.y + pan.y) * scale;
    const tx = Math.floor((e.clientX - rect.left + camX) / (TILE_PX * scale));
    const ty = Math.floor((e.clientY - rect.top + camY) / (TILE_PX * scale));
    // 双通道保留：点在热点上 = 直接触发（键盘时代的 hitTest 点按）
    const h = hitTest(hotspots, tx, ty);
    if (h) {
      fireHotspot(h);
      return;
    }
    // 点空处（G2.5：选中详情条的「点空收起」通道；走一步的判定照旧）
    onEmptyClick?.();
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
    /* G2.5 全屏世界：画布铺满父级主区（相对定位铺满），拆卡片框——世界延展出
       屏由满屏镜头跟随（cameraOffset 钳制镜头，装得下锁定全图），页面级溢出恒 0。 */
    <div className="rpg-pixel-scene flex min-h-0 flex-1">
      <div
        ref={viewportRef}
        className="rpg-pixel-viewport relative min-h-0 flex-1 overflow-hidden"
        onPointerDown={god ? onPointerDown : undefined}
        onPointerMove={god ? onPointerMove : undefined}
        onPointerUp={god ? onPointerUp : undefined}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: -(cam.x + pan.x) * scale,
            top: -(cam.y + pan.y) * scale,
            width: cols * TILE_PX,
            height: rows * TILE_PX,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            willChange: 'transform',
          }}
        >
          {/* 底图 run 层（色块兜底 + 图集取块同行合并） */}
          {baseRuns.map(baseRunNode)}
          {/* sprite run 层（树/灌木/花/作物/岸石；z1、不挡命中） */}
          {spriteRuns.map(spriteRunNode)}
          {/* tile 装饰层（石碑；z 在 sprite 上、角色下） */}
          {decor.map((d) => (
            <div
              key={`decor-${d.kind}-${d.x}-${d.y}`}
              style={{ position: 'absolute', left: d.x * TILE_PX, top: d.y * TILE_PX, width: TILE_PX, height: TILE_PX, zIndex: 2 }}
            >
              <SteleTile />
            </div>
          ))}
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
        {viewportOverlay}
      </div>
      {/* 控制带（G2.5 移动端新规）：操作按钮不浮在世界画面上——竖屏整条垫在
          画布下方、横屏整条立在画布右方（orientation 媒体查询 + flex order，
          纯 CSS 表达，零新依赖）；HUD 三件套照旧 overlay。 */}
      {god && touch && (
        <div className="rpg-control-belt">
          <Dpad onStep={stepAndTrigger} />
        </div>
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
