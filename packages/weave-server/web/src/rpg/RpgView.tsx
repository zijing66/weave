import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { RPG_SCENES, sceneOf } from './scenes';
import { useRpgData } from './use-rpg-data';
import { CharacterSprite } from './CharacterSprite';
import { gameStatusOf } from './status-map';
import { CollabScene } from './CollabScene';
import { ClassroomScene } from './ClassroomScene';
import { MeetingScene } from './MeetingScene';
import { RoleProgressPanel } from './RoleProgressPanel';
import { HomeConsole } from './HomeConsole';
import { TrainingPanel } from './TrainingPanel';
import { RoomScene } from './RoomScene';
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
import { api } from '@/lib/api';
import { PROJECTS_QUERY } from '@/hooks/use-projects';
import { STATUS_BADGE } from '@/components/tasks/session-status';
import { navigate } from '@/lib/route';
import type { ProjectRow, SessionRow } from '@/lib/api';

/**
 * RPG 游戏视图（G1 红白机骨架）：Home 重做为室内俯瞰场景（tile 网格 + 门热点 +
 * 上帝化身静态摆位 + 管理区），`/rpg/world` 新增室外世界地图（宅基地/修炼点/
 * 项目房）。既有协同场景（办公区/教室/会议室）原样保留。位置即 URL；进场景 =
 * 淡出过渡（`.rpg-scene-fade`）。tile 槽位表/命中判定归 worldmap.ts。
 */

export function RpgView({
  sceneKey,
  onOpenSession,
  projects,
}: {
  sceneKey: string | undefined;
  onOpenSession: (projectId: number, sessionId: string) => void;
  projects: ProjectRow[];
}) {
  const t = useT();
  const scene = sceneOf(sceneKey);
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      {bootVisible && (
        <div className="rpg-scene-fade rounded border border-[var(--w-border)] p-3">
          <RpgBootBar />
          {!boot.failed && boot.done >= boot.total && (
            <button
              type="button"
              onClick={() => setBootDismissed(true)}
              className="mt-2 rounded bg-[var(--w-surface-2)] px-2 py-0.5 text-[11px] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)]"
            >
              {t('rpg.bootDone')}
            </button>
          )}
        </div>
      )}
      {/* 场景注册表切换条（触屏态触控面放大到 ≥44px，桌面观感不动——§11） */}
      <div className="rpg-scene-switch flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.sceneRegistry')}</span>
        {RPG_SCENES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => navigateScene(s.key)}
            className={
              'rounded px-2 py-0.5 text-xs ' +
              (s.key === scene.key
                ? 'bg-[var(--w-accent)] text-white'
                : 'bg-[var(--w-surface-2)] text-[var(--w-text-dim)]')
            }
          >
            {t(s.titleKey)}
          </button>
        ))}
      </div>

      <div className={'rpg-scene-fade flex min-h-0 flex-1 flex-col' + (entered ? ' rpg-entered' : '')}>
        {scene.kind === 'home' ? (
          <HomeIndoorScene projects={projects} />
        ) : scene.kind === 'world' ? (
          <WorldScene projects={projects} onOpenSession={onOpenSession} />
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
    </div>
  );
}

/** 门切换与注册表切换共用一把 navigate（`lib/route.ts` 唯一写口）。 */
function navigateScene(scene: string): void {
  navigate({ kind: 'rpg', scene });
}

/** 房间场景键 = `room-<houseId>`（URL 唯一真源：深链可直接进某间房）。 */
export function roomSceneKey(houseId: number): string {
  return `room-${houseId}`;
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
 * Home 室内（G1 骨架 + G2 统一控制台）：tile 俯瞰 + 南墙门（出室外）+ 上帝
 * 化身自由区静态摆位 + 角色卡阵/修行详情 + 统一控制台（分身编辑/角色创建/
 * team 管理三合一——2026-11-08 用户裁决，不开散装入口；任务管理归 G6 不摆）。
 */
function HomeIndoorScene({ projects }: { projects: ProjectRow[] }) {
  const t = useT();
  const data = useRpgData();
  const [detailRoleId, setDetailRoleId] = useState<number | null>(null);

  const onHotspot = (h: Hotspot): void => {
    if (h.action.type === 'scene') navigateScene(h.action.scene);
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
    <div className="flex min-h-0 flex-1 flex-col gap-3">
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
          className="absolute whitespace-nowrap text-[11px] text-[var(--w-text-dim)]"
          style={{ left: 8 * 24, top: 11 * 24 - 26 }}
        >
          {t('rpg.doorExit')} ↓
        </span>
        {/* 上帝自由区铭牌 */}
        <span
          className="absolute whitespace-nowrap text-[11px] text-[var(--w-text-dim)]"
          style={{ left: GOD_SPOT.x * 24 + 72, top: GOD_SPOT.y * 24 }}
        >
          {t('rpg.godZone')}
        </span>
      </PixelScene>

      {/* 角色卡阵（在场点名，修行详情保留） */}
      {data.roles.length > 0 && (
        <div className="flex flex-wrap gap-4">
          {data.roles.map((role) => {
            // 角色 = 项目：取该项目最近会话的派生状态（无会话 = 待命）。
            const row = latestSessionOf(role.projectId, data.sessionById);
            const status = row ? (data.statuses.get(row.sessionId) ?? 'open') : 'open';
            const game = gameStatusOf(status);
            return (
              <button
                key={role.id}
                type="button"
                onClick={() => setDetailRoleId((cur) => (cur === role.id ? null : role.id))}
                className={
                  'flex w-40 flex-col items-center gap-2 rounded border p-3 ' +
                  (detailRoleId === role.id
                    ? 'border-[var(--w-accent)] bg-[var(--w-surface-3)]'
                    : row
                      ? 'border-[var(--w-border)] bg-[var(--w-surface-2)] hover:border-[var(--w-accent)]'
                      : 'border-dashed border-[var(--w-border)] opacity-70')
                }
                title={t('rpg.roleProgress')}
              >
                <div className={(game === 'gone' ? 'opacity-40 ' : '') + 'pointer-events-none'}>
                  <CharacterSprite archetype={role.archetype} status={game} size={3} />
                </div>
                <span className="truncate text-sm font-medium">{role.name}</span>
                <span className={'rounded px-1.5 py-0.5 text-[11px] ' + STATUS_BADGE[status]}>
                  {role.archetype ?? '—'} · {t(`tasks.status${cap(status)}` as 'tasks.statusOpen')}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {detailRoleId != null && (
        <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">
              {t('rpg.roleProgress')}
            </span>
            <button
              type="button"
              onClick={() => setDetailRoleId(null)}
              className="rounded px-2 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
            >
              ✕
            </button>
          </div>
          <RoleProgressPanel roleId={detailRoleId} />
        </div>
      )}

      {/* 统一控制台（G2）：分身编辑 / 角色创建 / team 管理三合一，不开散装入口 */}
      <HomeConsole projects={projects} />
    </div>
  );
}

/** 室外世界地图（G1）：宅基地（回 Home）/ 修炼点槽位（G3 占位）/ 项目房
 *  （既有项目 → 点击进项目视图）。项目房沿土路一字排开、超出槽位截断展示。 */
function WorldScene({
  projects,
  onOpenSession,
}: {
  projects: ProjectRow[];
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  const t = useT();
  void onOpenSession;
  const data = useRpgData();
  const [trainingOpen, setTrainingOpen] = useState(false);
  const houses = useQuery({ queryKey: ['rpg-houses'], queryFn: () => api.listHouses(), staleTime: 15_000 });
  const activeProjects = useMemo(() => projects.filter((p) => !p.archivedAt), [projects]);
  const houseHotspots = useMemo(() => projectHouseHotspots(activeProjects), [activeProjects]);
  const hotspots = useMemo(() => [...WORLD_HOTSPOTS, ...houseHotspots], [houseHotspots]);

  const onHotspot = (h: Hotspot): void => {
    if (h.action.type === 'scene') navigateScene(h.action.scene);
    else if (h.action.type === 'project') {
      // 项目房 → 进房协同棋盘（G2）：house 存在即进房间场景；没建房的项目
      // 回落既有项目视图（不破既有路由，URL 唯一真源）。
      const projectId = h.action.type === 'project' ? h.action.projectId : 0;
      const house = houses.data?.houses.find((x) => x.coreProjectId === projectId);
      if (house) navigateScene(roomSceneKey(house.id));
      else navigate({ kind: 'project', projectId, category: 'tasks', sessionId: null });
    } else if (h.action.type === 'training') {
      // 修炼点（G3 点亮）：开修炼动作面板（种田/钓鱼/锻造三入口）
      setTrainingOpen((cur) => !cur);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PixelScene
        map={WORLD_MAP}
        hotspots={hotspots}
        onHotspot={onHotspot}
        sprites={undefined}
        god={
          data.roles?.length
            ? {
                start: GOD_SPOT,
                node: <CharacterSprite archetype={data.roles[0]!.archetype} status="idle" size={0.5} />,
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
        <p className="text-xs text-[var(--w-text-dim)]">{t('rpg.worldNoProjects')}</p>
      )}
      {trainingOpen && data.roles != null && (
        <TrainingPanel roles={data.roles} onClose={() => setTrainingOpen(false)} />
      )}
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function latestSessionOf(
  projectId: number,
  sessionById: ReadonlyMap<string, SessionRow>,
): SessionRow | undefined {
  let best: SessionRow | undefined;
  for (const s of sessionById.values()) {
    if (s.projectId !== projectId) continue;
    if (!best || s.createdAt > best.createdAt) best = s;
  }
  return best;
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
