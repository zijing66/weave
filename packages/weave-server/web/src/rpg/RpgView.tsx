import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { RPG_SCENES, roomSceneKey, sceneOf } from './scenes';
import { useRpgData } from './use-rpg-data';
import { CharacterSprite } from './CharacterSprite';
import { CollabScene } from './CollabScene';
import { ClassroomScene } from './ClassroomScene';
import { MeetingScene } from './MeetingScene';
import { HouseCreateDialog } from './HouseCreateDialog';
import { HomeConsole } from './HomeConsole';
import { TrainingPanel } from './TrainingPanel';
import { RoomScene } from './RoomScene';
import { RoleProgressPanel } from './RoleProgressPanel';
import { PixelScene, RpgBootBar, rpgRetryHandlers } from './PixelScene';
import {
  GOD_SPOT,
  HOME_HOTSPOTS,
  HOME_MAP,
  WORLD_HOTSPOTS,
  WORLD_MAP,
  projectHouseHotspots,
  type Hotspot,
} from './worldmap';
import { rpgBoot, type RpgBootKey } from './rpg-boot';
import { AlertStrip, ClockWidget, SpriteHeadBars, headBarsOf, SelectionDetailBar } from './hud';
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
  useRpgBootProgress();
  const boot = useSyncExternalStore(rpgBoot.subscribe, rpgBoot.snapshot, rpgBoot.snapshot);
  const [bootDismissed, setBootDismissed] = useState(false);
  // 全清即淡出退场（复用门切换 transition）；失败项停住等重试，不假满格。
  const bootVisible = !bootDismissed && (boot.done < boot.total || boot.failed);
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

      {/* HUD 层（G2.5 overlay 三排）：启动进度 / 头部徽章（返回项目视图）/
          场景快捷键提示。浮层弹开时画布仍可见底下（半透明表面）。 */}
      {bootVisible && (
        <div className="rpg-hud-anchor pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center">
          <div className="pointer-events-auto mt-2 rounded border border-[var(--w-border)] bg-[var(--w-surface-1)]/95 p-2 shadow-lg">
            <RpgBootBar />
            {!boot.failed && boot.done >= boot.total && (
              <button
                type="button"
                onClick={() => setBootDismissed(true)}
                className="mt-1 rounded bg-[var(--w-surface-2)] px-2 py-0.5 text-[11px] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)]"
              >
                {t('rpg.bootDone')}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="rpg-hud-anchor pointer-events-none absolute left-0 top-0 z-10 flex items-start gap-2 p-2">
        <div className="pointer-events-auto flex items-center gap-1 rounded border border-[var(--w-border)] bg-[var(--w-surface-1)]/80 px-2 py-1 text-xs backdrop-blur-sm">
          <span className="font-semibold">{t('rpg.entry')}</span>
          <span className="text-[var(--w-text-dim)]">·</span>
          <span className="text-[var(--w-text-dim)]">{t(scene.titleKey)}</span>
          <button
            type="button"
            onClick={onBack}
            className="rpg-back-btn rounded px-1.5 py-0.5 text-[11px] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)] hover:text-[var(--w-text)]"
          >
            {t('rpg.back')}
          </button>
        </div>
      </div>
      <SceneHotkeysHint />
      <AlertStrip data={rpgData} />
      <ClockRateBadge />

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

/** 键盘党提示（桌面指针常态才摆：触屏无键盘，摆了就是死字）。 */
function SceneHotkeysHint() {
  const t = useT();
  const coarse = useMediaQueryCoarse();
  if (coarse) return null;
  return (
    <div className="rpg-hud-anchor pointer-events-none absolute bottom-2 left-2 z-10">
      <span className="rounded bg-[var(--w-surface-1)]/70 px-2 py-1 text-[10px] text-[var(--w-text-dim)]">
        {t('rpg.sceneHotkeys')}
      </span>
    </div>
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
          hotspots={HOME_HOTSPOTS}
          onHotspot={onHotspot}
          god={{ start: GOD_SPOT, node: <CharacterSprite archetype={null} status="idle" size={0.5} /> }}
        />
        <div className="p-8 text-sm text-[var(--w-text-dim)]">…</div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PixelScene
        map={HOME_MAP}
        hotspots={HOME_HOTSPOTS}
        onHotspot={onHotspot}
        god={{
          start: GOD_SPOT,
          node: (
            <div title={t('rpg.godAvatar')}>
              <CharacterSprite archetype={null} status="idle" size={0.5} />
            </div>
          ),
        }}
      >
        {/* 门牌 */}
        <span
          className="pointer-events-none absolute whitespace-nowrap text-[11px] text-[var(--w-text-dim)]"
          style={{ left: 8 * 24, top: 11 * 24 - 26 }}
        >
          {t('rpg.doorExit')} ↓
        </span>
        {/* 上帝自由区铭牌 */}
        <span
          className="pointer-events-none absolute whitespace-nowrap text-[11px] text-[var(--w-text-dim)]"
          style={{ left: GOD_SPOT.x * 24 + 72, top: GOD_SPOT.y * 24 }}
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
  onOpenSession,
  onNoHouse,
}: {
  projects: ProjectRow[];
  onOpenSession: (projectId: number, sessionId: string) => void;
  onNoHouse: (p: ProjectRow) => void;
}) {
  const t = useT();
  void onOpenSession;
  const data = useRpgData();
  const [trainingOpen, setTrainingOpen] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const houses = useQuery({ queryKey: ['rpg-houses'], queryFn: () => api.listHouses(), staleTime: 15_000 });
  const activeProjects = useMemo(() => projects.filter((p) => !p.archivedAt), [projects]);
  const houseHotspots = useMemo(() => projectHouseHotspots(activeProjects), [activeProjects]);
  const hotspots = useMemo(() => [...WORLD_HOTSPOTS, ...houseHotspots], [houseHotspots]);

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

  const onHotspot = (h: Hotspot): void => {
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

  // G2.5 三件套①③：在野角色静态摆位（草地锚位，纯派生可测）+ 头顶状态条；
  // 点选 sprite 展开底部选中详情条（点空处/✕ 收起）。
  const now = Date.now();
  const roleSprites = useMemo(
    () =>
      (data.roles ?? []).map((role, i) => {
        const spot = wandererSpot(i);
        if (!spot) return null;
        const bars = headBarsOf(role, data, now);
        return {
          key: `wanderer-${role.id}`,
          x: spot.x,
          y: spot.y,
          node: (
            <div
              className="relative flex cursor-pointer flex-col items-center"
              title={role.name}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedRoleId((cur) => (cur === role.id ? null : role.id));
              }}
            >
              <SpriteHeadBars bars={bars} />
              <CharacterSprite archetype={role.archetype} status="idle" size={0.5} />
              <span className="whitespace-nowrap rounded bg-[var(--w-surface-1)]/70 px-1 text-[9px] text-[var(--w-text-dim)]">
                {role.name}
              </span>
            </div>
          ),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.roles, data.sessionById, data.statuses, data.runs],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PixelScene
        map={WORLD_MAP}
        hotspots={hotspots}
        onHotspot={onHotspot}
        onEmptyClick={() => setSelectedRoleId(null)}
        sprites={roleSprites.filter((s): s is NonNullable<typeof s> => s != null)}
        god={
          data.roles?.length
            ? {
                start: GOD_SPOT,
                node: (
                  <div className="relative">
                    <CharacterSprite archetype={data.roles[0]!.archetype} status="idle" size={0.5} />
                  </div>
                ),
              }
            : undefined
        }
      >
        {hotspots.map((h) => (
          <span
            key={`label-${h.id}`}
            className="pointer-events-none absolute whitespace-nowrap text-[11px] text-[var(--w-text-dim)]"
            style={{ left: h.x * 24, top: h.y * 24 - 22 }}
          >
            {t(h.labelKey as 'rpg.doorExit')}
          </span>
        ))}
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
      {/* G2.5 三件套③：底部选中详情条（点 sprite 展开；点空处/✕ 收起） */}
      {selectedRoleId != null && data.roles?.some((r) => r.id === selectedRoleId) && (
        <SelectionDetailBar roleId={selectedRoleId} onClose={() => setSelectedRoleId(null)}>
          <RoleProgressPanel roleId={selectedRoleId} />
        </SelectionDetailBar>
      )}
    </div>
  );
}

/** 在野角色锚位（纯函数，可单测）：世界地图草地上第 i 个角色的 1×2 sprite
 *  左上角——从北面草带向下一排（避开宅基/修炼/项目房槽位与土路）；出界 = null
 *  （调用方截断，不摆）。 */
export function wandererSpot(i: number): { x: number; y: number } | null {
  if (!Number.isInteger(i) || i < 0) return null;
  const x = 2 + i * 2;
  const y = 2;
  if (x + 1 > 26) return null;
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
