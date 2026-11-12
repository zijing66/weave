import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { RPG_SCENES, roomSceneKey, sceneOf, worldExitHouseIdOf } from './scenes';
import { useRpgData } from './use-rpg-data';
import { CharacterSprite, GodSprite, spriteSeedOf } from './CharacterSprite';
import { CollabScene } from './CollabScene';
import { ClassroomScene } from './ClassroomScene';
import { MeetingScene } from './MeetingScene';
import { HouseCreateDialog } from './HouseCreateDialog';
import { HomeConsole } from './HomeConsole';
import { TrainingPanel } from './TrainingPanel';
import { RoomScene } from './RoomScene';
import { PixelScene, RpgBootBar, rpgRetryHandlers } from './PixelScene';
import {
  GOD_SPOT,
  HOME_HOTSPOTS,
  HOME_MAP,
  HOUSE_TILES,
  TILE_PX,
  TRAINING_HOTSPOT,
  WORLD_GOD_SPOT,
  WORLD_HOTSPOTS,
  WORLD_MAP,
  peerGodSeatSpot,
  projectHouseHotspots,
  visitorNpcSpot,
  worldExitSpawnOf,
  type Hotspot,
} from './worldmap';
import { usePeers, usePeerSessionsMulti, livenessOf } from './peer-faces';
import { PeerSeatBar, peerSeatRowsOf, visitorLabelOf, visitorRowsOf } from './peer-camp';
import { RoutingInbox } from './inbox';
import { GoalsPanel } from './goals';
import { triggerHotspotAt, type Cell } from './walker';
import { HouseTile } from './tile-decor';
import { useTileSprites } from './tile-atlas';
import { rpgBoot, type RpgBootKey } from './rpg-boot';
import {
  AlertStrip,
  ClockWidget,
  DetailHud,
  SpriteHeadBars,
  headBarsOf,
  nextSelectedRoleId,
} from './hud';
import { latestSessionOf } from './hud-derive';
import { useRateSeries } from './use-rate';
import { api } from '@/lib/api';
import { PROJECTS_QUERY } from '@/hooks/use-projects';
import { navigate } from '@/lib/route';
import { useBackPop } from '@/lib/back-pop';
import type { ProjectRow } from '@/lib/api';

/**
 * RPG 游戏视图（G1 骨架 + G2.5 全屏世界）：主区 100% 给满屏场景，管理面全部
 * 变画布上的浮层（HUD overlay：半透明表面、按需弹、Esc/✕ 关、移动端返回键
 * useBackPop）——不再占布局位。场景切换只走门/热点（G4 双通道唯一正门），
 * 键盘党保留数字键 1-6 直跳（全局 keydown、仅本视图生效）。位置即 URL；
 * 进场景 = 淡出过渡（`.rpg-scene-fade`）。tile 槽位表/命中判定归 worldmap.ts。
 */

export function RpgView({
  sceneKey,
  onOpenSession,
  projects,
  onBack,
}: {
  sceneKey: string | undefined;
  onOpenSession: (projectId: number, sessionId: string) => void;
  projects: ProjectRow[];
  /** 返回项目视图（App 层给：选中项目 → 项目任务页，无选中 → 全局任务页）。 */
  onBack: () => void;
}) {
  const t = useT();
  const scene = sceneOf(sceneKey);
  const rpgData = useRpgData();
  const [housePending, setHousePending] = useState<ProjectRow | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  // 决策路由信箱（G6）：全场景顶层 overlay，警报带「级2 待批」点开。
  const [inboxOpen, setInboxOpen] = useState(false);
  // 任务沙盘全局面板（G6 批4c）：任意场景可唤起，不锁 Home；入口常驻 HUD。
  const [goalsOpen, setGoalsOpen] = useState(false);
  useRpgBootProgress();
  const boot = useSyncExternalStore(rpgBoot.subscribe, rpgBoot.snapshot, rpgBoot.snapshot);
  // 启动浮层满格判据：全清即淡出退场；失败项停住等重试，不假满格。
  const bootDone = boot.done >= boot.total && !boot.failed;
  const [entered, setEntered] = useState(false);
  // 进场淡入（门切换过渡：场景键变化时重放一次 transition）
  useEffect(() => {
    setEntered(false);
    const id = window.setTimeout(() => setEntered(true), 30);
    return () => window.clearTimeout(id);
  }, [scene.key]);

  // 场景切换（门/快捷键共路）：进房间/换场景，浮层全部收起。
  const navigateScene = useCallback((next: string): void => {
    setConsoleOpen(false);
    navigate({ kind: 'rpg', scene: next });
  }, []);

  // 数字键 1-6 直跳场景（键盘党通道）：仅本视图生效；输入面（输入框/文本域/
  // contentEditable）不打断；场景切换条已拆，这是唯一的快捷键门。
  const sceneCount = RPG_SCENES.length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const n = /^Digit([1-9])$/.exec(e.code);
      if (!n) return;
      const idx = Number(n[1]) - 1;
      if (idx >= sceneCount) return;
      navigateScene(RPG_SCENES[idx]!.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sceneCount, navigateScene]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 场景层（满屏世界，G2.5 铺满主区） */}
      <div className={'rpg-scene-fade flex min-h-0 flex-1 flex-col' + (entered ? ' rpg-entered' : '')}>
        {scene.kind === 'home' ? (
          <HomeIndoorScene projects={projects} consoleOpen={consoleOpen} onConsole={setConsoleOpen} />
        ) : scene.kind === 'world' ? (
          <WorldScene
            key={sceneKey ?? 'world'}
            exitHouseId={worldExitHouseIdOf(sceneKey)}
            projects={projects}
            onOpenSession={onOpenSession}
            onNoHouse={setHousePending}
          />
        ) : scene.kind === 'room' ? (
          <RoomBoard houseId={roomHouseIdOf(sceneKey)} />
        ) : scene.kind === 'classroom' ? (
          <ClassroomSkin onOpenSession={onOpenSession} />
        ) : scene.kind === 'meeting' ? (
          <MeetingSkin onOpenSession={onOpenSession} />
        ) : (
          <OfficeSkin onOpenSession={onOpenSession} />
        )}
      </div>

      {/* 启动装载浮层（G2.6 收尾，对齐首屏 BootSplash 口径）：进入游戏 = 全屏
          深底 + 六格真实进度满格前盖住世界（此前数据被 dashboard 预热时六格
          瞬时满格、顶条一闪即逝，用户看不到任何装载过程）；失败停住重试。 */}
      <RpgBootSplash done={bootDone} />
      <div className="rpg-hud-anchor pointer-events-none absolute left-0 top-0 z-10 flex items-start gap-2 p-2">
        <div className="rpg-hud-face pointer-events-auto flex flex-col gap-0.5 px-2 py-1 text-xs">
          <div className="flex items-center gap-1">
            <span className="font-semibold">{t('rpg.entry')}</span>
            <span className="text-[var(--w-text-dim)]">·</span>
            <span className="text-[var(--w-text-dim)]">{t(scene.titleKey)}</span>
            <button
              type="button"
              onClick={onBack}
              className="rpg-back-btn rounded px-1.5 py-0.5 text-[11px] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)] hover:text-[#4ec9b0]"
            >
              {t('rpg.back')}
            </button>
          </div>
          <SceneHotkeysHint />
          <button
            type="button"
            onClick={() => setGoalsOpen(true)}
            className="mt-0.5 w-fit rounded border border-[var(--w-border)] px-1.5 py-0.5 text-[11px] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)] hover:text-[#ffd166]"
          >
            ⚑ {t('rpg.goalsEntry')}
            {(rpgData.goals ?? []).some((g) => g.status === 'active') && (
              <span className="ml-1 rounded bg-sky-900/70 px-1 text-[10px] tabular-nums text-sky-200">
                {(rpgData.goals ?? []).filter((g) => g.status === 'active').length}
              </span>
            )}
          </button>
        </div>
      </div>
      <AlertStrip data={rpgData} onOpenRouting={() => setInboxOpen(true)} />
      <ClockRateBadge />

      {/* 决策路由信箱（G6）：顶部警报带「级2 待批」点开；Esc/返回键收起。 */}
      <RoutingInbox open={inboxOpen} onClose={() => setInboxOpen(false)} data={rpgData} />

      {/* 任务沙盘全局面板（G6 批4c）：goal 列表 + 立项 + 状态动作；Esc/返回键收起。 */}
      <GoalsPanel open={goalsOpen} onClose={() => setGoalsOpen(false)} data={rpgData} />

      {housePending != null && (
        <HouseCreateDialog
          coreProject={housePending}
          projects={projects.filter((p) => !p.archivedAt)}
          roles={rpgData.roles ?? []}
          onClose={() => setHousePending(null)}
        />
      )}
    </div>
  );
}

/** 启动装载浮层（对齐首屏 BootSplash 时序）：满格 → 淡出 → 卸载；失败不过
 *  done、停重在浮层里的重试按钮。chunk 下载期由 App 侧 RpgChunkFallback
 *  先盖一层，模块挂载后这里无缝接棒。 */
function RpgBootSplash({ done }: { done: boolean }) {
  const [phase, setPhase] = useState<'show' | 'exit' | 'gone'>('show');
  useEffect(() => {
    if (!done || phase === 'gone') return;
    if (phase === 'show') {
      const timer = window.setTimeout(() => setPhase('exit'), 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setPhase('gone'), 320);
    return () => window.clearTimeout(timer);
  }, [done, phase]);
  if (phase === 'gone') return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        'rpg-boot-overlay fixed inset-0 z-[80] flex flex-col items-center justify-center ' +
        (phase === 'exit' ? 'rpg-boot-overlay-exit' : 'rpg-boot-overlay-enter')
      }
    >
      <RpgBootBar />
    </div>
  );
}

/** 时钟位（G2.5 三件套之外的一格）：右上角 = 时钟 + 事件速率 + 在跑会话数——
 *  rate 走 dashboard 缓存（读不到不摆）、在跑数 = 状态总线派生。 */
function ClockRateBadge() {
  const data = useRpgData();
  const { rate } = useRateSeries();
  const runningCount = useMemo(() => {
    let n = 0;
    for (const s of data.sessions ?? []) {
      const st = data.statuses.get(s.sessionId);
      if (st === 'running' || st === 'compacting') n++;
    }
    return data.sessions == null ? null : n;
  }, [data.sessions, data.statuses]);
  return <ClockWidget rate={rate} runningCount={runningCount} />;
}

/** 快捷键提示（G2.6 规格行，挂在左上徽章下一行；触屏无键盘不摆）。 */
function SceneHotkeysHint() {
  const t = useT();
  const coarse = useMediaQueryCoarse();
  if (coarse) return null;
  return (
    <span className="whitespace-nowrap text-[10px] text-[var(--w-text-dim)]">
      {t('rpg.sceneHotkeys')}
    </span>
  );
}

function useMediaQueryCoarse(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(hover: none), (pointer: coarse)').matches,
  );
  useEffect(() => {
    const mql = window.matchMedia('(hover: none), (pointer: coarse)');
    const onChange = (): void => setCoarse(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return coarse;
}

function roomHouseIdOf(sceneKey: string | undefined): number {
  const m = /^room-(\d+)$/.exec(sceneKey ?? '');
  return m ? Number(m[1]) : 0;
}

/** 房间棋盘（G2）：houseId=0（无房或缺省深链）回落提示；有房进 RoomScene。 */
function RoomBoard({ houseId }: { houseId: number }) {
  const t = useT();
  if (houseId <= 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <p className="text-sm text-[var(--w-text-dim)]">{t('rpg.roomNoHouse')}</p>
      </div>
    );
  }
  return <RoomScene houseId={houseId} />;
}

function ClassroomSkin(props: { onOpenSession: (projectId: number, sessionId: string) => void }) {
  return <ClassroomScene {...props} />;
}
function MeetingSkin(props: { onOpenSession: (projectId: number, sessionId: string) => void }) {
  return <MeetingScene {...props} />;
}
function OfficeSkin(props: { onOpenSession: (projectId: number, sessionId: string) => void }) {
  return <CollabScene skin="office" {...props} />;
}

/**
 * Home 室内（G1 骨架 + G2 统一控制台 + G2.5 overlay 化）：tile 俯瞰 + 南墙门
 * （出室外）+ 上帝化身自由走动；统一控制台（Home 管理面唯一形态）变画布上的
 * 浮层——门旁热点/ HUD 入口按需弹，弹时世界画面仍可见底下。
 */
function HomeIndoorScene({
  projects,
  consoleOpen,
  onConsole,
}: {
  projects: ProjectRow[];
  consoleOpen: boolean;
  onConsole: (open: boolean) => void;
}) {
  const t = useT();
  const data = useRpgData();

  const onHotspot = (h: Hotspot): void => {
    if (h.action.type === 'scene') navigate({ kind: 'rpg', scene: h.action.scene });
    else if (h.action.type === 'console') onConsole(true);
  };

  if (data.roles == null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PixelScene
          map={HOME_MAP}
          indoor
          hotspots={HOME_HOTSPOTS}
          onHotspot={onHotspot}
          god={{ start: GOD_SPOT, node: (facing) => <GodSprite size={1.25} facing={facing} /> }}
        />
        <div className="p-8 text-sm text-[var(--w-text-dim)]">…</div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PixelScene
        map={HOME_MAP}
          indoor
        hotspots={HOME_HOTSPOTS}
        onHotspot={onHotspot}
        god={{
          start: GOD_SPOT,
          node: (facing) => (
            <div title={t('rpg.godAvatar')}>
              <GodSprite size={0.75} facing={facing} />
            </div>
          ),
        }}
      >
        {/* 门牌 */}
        <span
          className="pointer-events-none absolute whitespace-nowrap text-[11px] text-[var(--w-text-dim)]"
          style={{ left: 8 * TILE_PX, top: 11 * TILE_PX - 26 }}
        >
          {t('rpg.doorExit')} ↓
        </span>
        {/* 上帝自由区铭牌 */}
        <span
          className="pointer-events-none absolute whitespace-nowrap text-[11px] text-[var(--w-text-dim)]"
          style={{ left: GOD_SPOT.x * TILE_PX + TILE_PX * 3, top: GOD_SPOT.y * TILE_PX }}
        >
          {t('rpg.godZone')}
        </span>
      </PixelScene>

      {/* 统一控制台浮层入口（HUD 右上角、时钟位下方错开）：hud-anchor 是
          「容器 none + 子元素 auto」的透传模式——按钮必须作子元素挂，不能
          自己扛 hud-anchor 类（pointer-events:none 会让点击穿透）。 */}
      <div className="rpg-hud-anchor absolute right-2 top-11 z-10">
        <button
          type="button"
          onClick={() => onConsole(!consoleOpen)}
          className="rpg-console-entry rounded border border-[var(--w-border)] bg-[var(--w-surface-1)]/85 px-3 py-1.5 text-xs text-[var(--w-text)] backdrop-blur-sm hover:bg-[var(--w-surface-2)]"
        >
          {t('rpg.consoleTitle')}
        </button>
      </div>

      {/* 统一控制台（G2，G2.5 变浮层）：画布上的半透明面板，Esc/✕ 关 */}
      {consoleOpen && (
        <HomeConsoleOverlay projects={projects} onClose={() => onConsole(false)} />
      )}
    </div>
  );
}

/** 统一控制台浮层壳（G2.5）：HomeConsole 内容原样搬进浮层表面。 */
function HomeConsoleOverlay({ projects, onClose }: { projects: ProjectRow[]; onClose: () => void }) {
  useBackPop(true, () => {
    onClose();
    return true;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="rpg-overlay-surface absolute inset-2 z-20 flex min-h-0 flex-col overflow-auto rounded-lg border border-[var(--w-border)] p-3 shadow-xl">
      <button
        type="button"
        onClick={onClose}
        aria-label="close"
        className="absolute right-2 top-2 z-10 rounded px-2 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
      >
        ✕
      </button>
      <HomeConsole projects={projects} />
    </div>
  );
}

/** 室外世界地图（G1 + G3 修炼点 + G2.5 修炼面板 overlay 化）：宅基地（回 Home）/
 *  修炼点（G3 修炼浮层）/ 项目房（有房进房协同棋盘；无房弹建房对话框）。
 *  项目房沿土路一字排开、超出槽位截断展示。 */
function WorldScene({
  projects,
  exitHouseId,
  onOpenSession,
  onNoHouse,
}: {
  projects: ProjectRow[];
  /** 出房上下文（`world-exit-<houseId>`）：非空 = 落该房门外一格；查房数据
   *  未到 = 暂不挂化身（挂上再落初始格，不闪错位）。 */
  exitHouseId: number | null;
  onOpenSession: (projectId: number, sessionId: string) => void;
  onNoHouse: (p: ProjectRow) => void;
}) {
  const t = useT();
  void onOpenSession;
  const data = useRpgData();
  const coarse = useMediaQueryCoarse();
  const [trainingOpen, setTrainingOpen] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  // G5 联机席位：客席区选中（对等上帝席 / 来访 NPC 共用一条只读详情条）。
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const houses = useQuery({ queryKey: ['rpg-houses'], queryFn: () => api.listHouses(), staleTime: 15_000 });
  // F1 面：peers 注册表判在线（90s 心跳窗）→ 对等上帝席位。
  const peers = usePeers();
  // F2 面：在线对端的只读 sessions 代理（来访 NPC + 跨机原语重放的数据源）。
  const onlinePeerKeys = useMemo(
    () => peers.filter((p) => p.enabled && livenessOf(p.lastSeenAt)).map((p) => ({ id: p.id, name: p.name })),
    [peers],
  );
  const peerViews = usePeerSessionsMulti(onlinePeerKeys);
  // 世界项目房不含超级代理项目（2026-11-11 裁决：上帝 = coordinator 本身，
  // 不是一座房——它自由行走全图，不占项目房槽位，用户项目房序号不变）。
  const activeProjects = useMemo(
    () => projects.filter((p) => !p.archivedAt && !p.superagent),
    [projects],
  );
  const houseHotspots = useMemo(() => projectHouseHotspots(activeProjects), [activeProjects]);
  // 出房落点：houses 落地才算得出（房槽位按项目序）；查不到 = 回默认安全格，
  //  普通世界入口沿 WORLD_GOD_SPOT。落点随场景键重算（key 化身重挂）。
  const exitSpawn = useMemo(() => {
    if (exitHouseId == null) return null;
    if (houses.data == null) return undefined;
    return worldExitSpawnOf(exitHouseId, houses.data.houses, activeProjects);
  }, [exitHouseId, houses.data, activeProjects]);
  // G2.6 资产化：房体九宫用单 tile data URL（加载失败退色块）
  const tileSprites = useTileSprites();
  const hotspots = useMemo(() => [...WORLD_HOTSPOTS, ...houseHotspots], [houseHotspots]);
  const selectedRole = useMemo(
    () => data.roles?.find((r) => r.id === selectedRoleId) ?? null,
    [data.roles, selectedRoleId],
  );

  // 修炼浮层：Esc / 移动端返回键收起（G2.5 overlay 纪律）。
  useBackPop(trainingOpen, () => {
    setTrainingOpen(false);
    return true;
  });
  useEffect(() => {
    if (!trainingOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setTrainingOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [trainingOpen]);

  // G2.6 交互补齐：[空格] 选中最近角色 / 循环切换；[E] 触发脚下/面前热点
  // （与走到格触发同管道 triggerHotspotAt）。浮层开着（修炼）时不抢键。
  const fireHotspotRef = useRef<(h: Hotspot) => void>(() => {});
  useEffect(() => {
    if (coarse || trainingOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setSelectedRoleId((cur) => nextSelectedRoleId(data.roles ?? [], cur));
      } else if (e.code === 'KeyE') {
        e.preventDefault();
        godPosRef.current?.((pos) => {
          if (!pos) return;
          // 脚格锚定（G2.6 复测裁决）：E = 脚格本身 + 脚格四邻——「面前」无朝向
          // 态，四邻全覆盖（命中哪个热点触发哪个，与走到格触发同管道）。
          const foot = { x: pos.x, y: pos.y + 1 };
          const near = [foot, { x: foot.x, y: foot.y - 1 }, { x: foot.x, y: foot.y + 1 }, { x: foot.x - 1, y: foot.y }, { x: foot.x + 1, y: foot.y }];
          const h = near.map((p) => triggerHotspotAt(hotspots, { x: p.x, y: p.y - 1 })).find(Boolean);
          if (h) fireHotspotRef.current(h);
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [coarse, trainingOpen, data.roles, hotspots]);

  const onHotspot = (h: Hotspot): void => {
    fireHotspotRef.current(h);
  };
  fireHotspotRef.current = (h: Hotspot): void => {
    if (h.action.type === 'scene') navigate({ kind: 'rpg', scene: h.action.scene });
    else if (h.action.type === 'project') {
      // 项目房 → 进房协同棋盘（G2）：house 存在即进房间场景；没建房的项目
      // 弹组建流（核心预填该项目，「直接进项目视图」保留老出口）。
      const projectId = h.action.type === 'project' ? h.action.projectId : 0;
      const house = houses.data?.houses.find((x) => x.coreProjectId === projectId);
      if (house) navigate({ kind: 'rpg', scene: roomSceneKey(house.id) });
      else {
        const target = activeProjects.find((p) => p.id === projectId);
        if (target) onNoHouse(target);
      }
    } else if (h.action.type === 'training') {
      // 修炼点（G3 点亮）：开修炼动作浮层（种田/钓鱼/锻造三入口）
      setTrainingOpen((cur) => !cur);
    }
  };

  // 化身实时格（E 键读面前热点用）：PixelScene 不外吐 pos，这里用同步快照
  // （god 起始格起步，行走由 walker 判——E 只读不写）。
  const godPosRef = useRef<((read: (pos: Cell | null) => void) => void) | null>(null);

  // G2.5 三件套①③ + G2.6 选中青色标记：在野角色静态摆位 + 头顶状态条 +
  // 被选中者脚下青描边；点选 sprite 展开底部详情 HUD（点空处/✕ 收起）。
  const now = Date.now();
  const roleSprites = useMemo(
    () =>
      (data.roles ?? []).map((role, i) => {
        const spot = wandererSpot(i);
        if (!spot) return null;
        const bars = headBarsOf(role, data, now);
        const selected = role.id === selectedRoleId;
        return {
          key: `wanderer-${role.id}`,
          x: spot.x,
          y: spot.y,
          node: (
            <div
              className={
                'relative flex cursor-pointer flex-col items-center' +
                (selected ? ' rpg-selected-mark' : '')
              }
              title={role.name}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedPeerId(null);
                setSelectedRoleId((cur) => (cur === role.id ? null : role.id));
              }}
            >
              <SpriteHeadBars bars={bars} />
              <CharacterSprite
                archetype={role.archetype}
                status="idle"
                size={0.75}
                gender={role.gender}
                appearanceSeed={role.appearanceSeed}
              />
              <span
                className={
                  'whitespace-nowrap rounded-sm px-1 text-[9px] ' +
                  (selected ? 'bg-[#4ec9b0]/25 text-[#4ec9b0]' : 'bg-[var(--w-surface-1)]/70 text-[var(--w-text-dim)]')
                }
              >
                {role.name}
              </span>
            </div>
          ),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.roles, data.sessionById, data.statuses, data.runs, selectedRoleId],
  );

  // G5 联机席位（只摆有数据：无在线对端 = 客席区整块不出现）：
  //  席位排 = 对等上帝（机器）；来访 NPC 排 = 对端真在跑的会话（只读），
  //  NPC 状态徽章重放对端回合忙态（turnOpen → battle 帧）。
  const peerSeats = useMemo(() => peerSeatRowsOf(peers), [peers]);
  const visitorRows = useMemo(() => visitorRowsOf(peers, peerViews), [peers, peerViews]);
  const campSprites = useMemo(() => {
    if (peerSeats.length === 0 && visitorRows.length === 0) return [];
    const nodes: Array<{ key: string; x: number; y: number; node: React.ReactNode }> = [];
    for (const seat of peerSeats) {
      const spot = peerGodSeatSpot(seat.spotIndex)!;
      // 对等上帝 = 另一台机的上帝：其外貌种子在本机读不到，按 peer id 派生
      //  确定性外貌（刷新不变，不蹭本机上帝的脸）。
      const seed = spriteSeedOf(seat.peer.id);
      nodes.push({
        key: `peer-seat-${seat.peer.id}`,
        x: spot.x,
        y: spot.y,
        node: (
          <div
            className="flex cursor-pointer flex-col items-center"
            title={t('rpg.peerGodSeat', { name: seat.peer.name })}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedRoleId(null);
              setSelectedPeerId(seat.peer.id);
            }}
          >
            <CharacterSprite
              archetype={null}
              status="idle"
              size={0.75}
              god
              bar="ok"
              gender={seed % 2 ? 'female' : 'male'}
              appearanceSeed={seed}
            />
            <span className="flex items-center gap-1 rounded-sm bg-[var(--w-surface-1)]/70 px-1 text-[9px] text-[var(--w-text-dim)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#4ec9b0]" />
              {seat.peer.name}
            </span>
          </div>
        ),
      });
    }
    for (const v of visitorRows) {
      const spot = visitorNpcSpot(v.spotIndex)!;
      nodes.push({
        key: `visitor-${v.peer.id}-${v.sessionId}`,
        x: spot.x,
        y: spot.y,
        node: (
          <div
            className="flex cursor-pointer flex-col items-center opacity-95"
            title={`${v.peer.name} · ${visitorLabelOf(v)}`}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedRoleId(null);
              setSelectedPeerId(v.peer.id);
            }}
          >
            <CharacterSprite
              archetype="适配"
              status={v.turnOpen ? 'battle' : 'idle'}
              size={0.75}
              bar="ok"
              gender={spriteSeedOf(v.sessionId) % 2 ? 'female' : 'male'}
              appearanceSeed={spriteSeedOf(v.sessionId)}
            />
            <span className="whitespace-nowrap rounded-sm bg-[var(--w-surface-1)]/70 px-1 text-[9px] text-[var(--w-text-dim)]">
              {visitorLabelOf(v)}
            </span>
          </div>
        ),
      });
    }
    return nodes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerSeats, visitorRows]);
  const selectedPeer = useMemo(
    () => peers.find((p) => p.id === selectedPeerId) ?? null,
    [peers, selectedPeerId],
  );

  // ④ 最近回合摘要：该角色项目下最近 runs（≤3 行，真实账派生）。
  const recentRuns = useMemo(() => {
    if (!selectedRole) return [];
    return (data.runs ?? [])
      .filter((r) => r.projectId === selectedRole.projectId)
      .slice(0, 3)
      .map((r) => `${r.status === 'failed' ? '✕' : r.status === 'done' ? '✓' : '▶'} #${r.id} ${r.orchestrationName}`);
  }, [selectedRole, data.runs]);
  const behavior = recentRuns[0] != null ? t('rpg.behaviorLastRun', { name: recentRuns[0] }) : null;
  const statusLabel = useMemo(() => {
    if (!selectedRole) return '';
    const row = latestSessionOf(selectedRole.projectId, data.sessionById);
    const st = row ? (data.statuses.get(row.sessionId) ?? 'open') : 'open';
    return st === 'running' || st === 'compacting'
      ? t('rpg.statusBattle')
      : st === 'failed'
        ? t('rpg.statusDefeated')
        : t('rpg.statusIdle');
  }, [selectedRole, data.sessionById, data.statuses, t]);
  const progress = useQuery({
    queryKey: ['rpg-progress', selectedRoleId],
    queryFn: () => api.progressOf(selectedRoleId!),
    enabled: selectedRoleId != null,
    staleTime: 15_000,
  });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PixelScene
        map={WORLD_MAP}
        hotspots={hotspots}
        onHotspot={onHotspot}
        onEmptyClick={() => {
          setSelectedRoleId(null);
          setSelectedPeerId(null);
        }}
        sprites={[...roleSprites.filter((s): s is NonNullable<typeof s> => s != null), ...campSprites]}
        godPosProbe={godPosRef}
        viewportOverlay={
          /* G2.6 底部字幕：贴视口底（不随镜头/控制带平移）；无选中才摆
              （选中时详情条占位，不叠两行）；常驻上帝条在场时垫高一档。 */
          selectedRoleId == null ? (
            <div className="rpg-hud-anchor pointer-events-none absolute inset-x-0 bottom-14 z-10 flex justify-center">
              <span className="rpg-subtitle text-sm">{t('rpg.worldSubtitle')}</span>
            </div>
          ) : null
        }
        god={
          exitSpawn === undefined
            ? undefined
            : {
                start: exitSpawn?.start ?? WORLD_GOD_SPOT,
                facing: exitSpawn?.facing,
                node: (facing: 'up' | 'down' | 'left' | 'right') => (
                  <div title={t('rpg.godAvatar')}>
                    <GodSprite size={0.75} facing={facing} />
                  </div>
                ),
              }
        }
      >
        {/* G2.6 参考图：项目房 tile 级房体（坡屋顶+窗光+门前小牌+投影），
            seed 派生窗位微差连排不呆板；画在热点之下、label 之上。 */}
        {houseHotspots.map((h, i) => (
          <div
            key={`house-body-${h.id}`}
            className="pointer-events-none absolute"
            style={{ left: h.x * TILE_PX, top: h.y * TILE_PX, width: HOUSE_TILES * TILE_PX, height: HOUSE_TILES * TILE_PX, zIndex: (h.y + HOUSE_TILES - 1) * 2 + 1 }}
            aria-hidden
          >
            <HouseTile seed={i} sprites={tileSprites} />
          </div>
        ))}
        {hotspots.map((h) => (
          <span
            key={`label-${h.id}`}
            className="pointer-events-none absolute whitespace-nowrap text-[9px] text-[rgba(242,237,228,0.5)] [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]"
            style={{ left: h.x * TILE_PX, top: h.y * TILE_PX - 14 }}
          >
            {t(h.labelKey as 'rpg.doorExit')}
          </span>
        ))}
        {/* G2.6 灵田灵气：修炼点四周低亮度青色发光（克制的呼吸，参考图 A 灵气感）。 */}
        <div
          className="rpg-aura pointer-events-none"
          style={{
            left: (TRAINING_HOTSPOT.x - 1) * TILE_PX,
            top: (TRAINING_HOTSPOT.y - 1) * TILE_PX,
            width: (TRAINING_HOTSPOT.w + 2) * TILE_PX,
            height: (TRAINING_HOTSPOT.h + 2) * TILE_PX,
          }}
        />
        {/* G5 客席区铭牌（只摆有数据：一个席位/来访都没有 = 不渲染） */}
        {campSprites.length > 0 && (
          <span
            className="pointer-events-none absolute whitespace-nowrap text-[11px] text-[var(--w-text-dim)]"
            style={{ left: 13 * TILE_PX, top: 4 * TILE_PX - 12 }}
          >
            {t('rpg.peerGuestZone')}
          </span>
        )}
      </PixelScene>
      {activeProjects.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center">
          <span className="rounded bg-[var(--w-surface-1)]/85 px-3 py-1 text-xs text-[var(--w-text-dim)]">
            {t('rpg.worldNoProjects')}
          </span>
        </div>
      )}
      {trainingOpen && data.roles != null && (
        <div className="rpg-overlay-surface absolute inset-x-2 bottom-2 z-20 max-h-[70%] overflow-auto rounded-lg border border-[var(--w-border)] p-3 shadow-xl sm:inset-x-auto sm:right-2 sm:w-[480px]">
          <TrainingPanel roles={data.roles} onClose={() => setTrainingOpen(false)} />
        </div>
      )}
      {/* G2.6 五区详情 HUD（选中真实角色才摆；派生不出的区不摆） */}
      {selectedRole != null && (
        <DetailHud
          role={selectedRole}
          statusLabel={statusLabel}
          behavior={behavior}
          progress={progress.data?.progress ?? null}
          recentRuns={recentRuns}
          compact={coarse}
          onClose={() => setSelectedRoleId(null)}
        />
      )}
      {/* G5 客席只读详情条（对等上帝席 / 来访 NPC 选中才摆；写操作永远落本机） */}
      {selectedPeer != null && (
        <PeerSeatBar
          peer={selectedPeer}
          view={selectedPeerId != null ? peerViews.get(selectedPeerId) ?? null : null}
          onClose={() => setSelectedPeerId(null)}
        />
      )}
      {/* 底部常驻上帝条（G2.6 收尾裁决：详情 HUD 常驻，不点选也有底座）——
          无选中才摆；角色/客席选中时由对应详情条占位。不造假数据：上帝没有
          六维/修为账，只摆化身 + 指引。 */}
      {selectedRole == null && selectedPeer == null && <GodHudStrip />}
    </div>
  );
}

/** 常驻上帝条：横向半透明 HUD（与 DetailHud 同款表面），化身头像 + 名 + 指引。 */
function GodHudStrip() {
  const t = useT();
  return (
    <div className="rpg-hud-face pointer-events-auto absolute inset-x-2 bottom-2 z-20 flex items-center gap-3 px-3 py-2 shadow-xl">
      <div className="h-10 w-8 shrink-0">
        <GodSprite size={0.75} />
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs text-[#d7d1c6]">{t('rpg.godAvatar')}</div>
        <div className="truncate text-[10px] text-[var(--w-text-dim)]">{t('rpg.godHudHint')}</div>
      </div>
    </div>
  );
}

/** 在野角色锚位（纯函数，可单测）：世界地图（54×32）草地上第 i 个角色的
 *  1×2 sprite 左上角——路南草带一排横列（x=22 起、间隔 4：避开项目房连排
 *  cols 2-20 / 宅基地 / 灵田 (11-14,18-21) 与湖 cols 25+）；出界 = null
 *  （调用方截断，不摆）。 */
export function wandererSpot(i: number): { x: number; y: number } | null {
  if (!Number.isInteger(i) || i < 0) return null;
  const x = 22 + i * 4;
  const y = 12;
  if (x + 1 > 54) return null;
  return { x, y };
}

/** G1 判据⑥：加载进度（真实六格）随 RpgView 挂载驱动——每格 = 一项真实请求
 *  （会话状态总线 = 首拍 listSessions；模块装载 = 挂载完成的事实本身）。 */
export function useRpgBootProgress(): void {
  const snapshot = useSyncExternalStore(rpgBoot.subscribe, rpgBoot.snapshot, rpgBoot.snapshot);
  const qc = useQueryClient();
  const startedRef = useMemo(() => ({ started: false }), []);
  useEffect(() => {
    if (startedRef.started) return;
    startedRef.started = true;
    const runs: Record<RpgBootKey, () => Promise<unknown>> = {
      roles: () => qc.fetchQuery({ queryKey: ['rpg-roles'], queryFn: () => api.listRoles() }),
      orchestrations: () =>
        qc.fetchQuery({ queryKey: ['rpg-orchestrations'], queryFn: () => api.listOrchestrations() }),
      runs: () =>
        qc.fetchQuery({ queryKey: ['rpg-runs'], queryFn: () => api.listOrchestrationRuns({ limit: 50 }) }),
      sessions: () => api.listSessions(),
      projects: () => qc.fetchQuery(PROJECTS_QUERY),
      // 本地模块装载（tile 表/场景定义/组件树）——useEffect 跑到即事实落定。
      modules: () => Promise.resolve(true),
    };
    for (const it of snapshot.items) {
      rpgRetryHandlers.set(it.key, () => bootItem(it.key, runs[it.key]!));
      bootItem(it.key, runs[it.key]!);
    }
    return () => {
      for (const it of snapshot.items) rpgRetryHandlers.delete(it.key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function bootItem(key: RpgBootKey, run: () => Promise<unknown>): void {
  rpgBoot.start(key);
  run()
    .then(() => rpgBoot.settle(key, true))
    .catch(() => rpgBoot.settle(key, false));
}
