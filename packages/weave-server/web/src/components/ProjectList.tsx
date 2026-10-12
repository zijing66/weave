import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { api, type HarnessCheck, type ProjectRow } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { HarnessIcon } from '@/components/tasks/HarnessIcon';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import type { ActionState } from '@/lib/action-feedback';
import type { HarnessSessionCounts } from '@/components/tasks/session-status';
import {
  Circle,
  FolderOpen,
  Globe,
  GripVertical,
  RefreshCw,
  Terminal,
  ToggleLeft,
  ToggleRight,
  TriangleAlert,
} from 'lucide-react';

interface ProjectListProps {
  projects: ProjectRow[];
  selectedId?: number;
  /** Whether the global-config pseudo-project is currently active. */
  globalActive: boolean;
  onSelect: (p: ProjectRow) => void;
  onSelectGlobal: () => void;
  /** Context-menu action: open the project folder in the OS file manager. */
  onOpenExplorer: (p: ProjectRow) => void;
  /** Context-menu action: open a terminal at the project folder. */
  onOpenTerminal: (p: ProjectRow) => void;
  /** Row hover → lazily fetch + cache that project's pending-update count. */
  onHoverProject?: (projectId: number) => void;
  /** Row quick action: autoSync flag (undefined until the config cache loads). */
  autoSyncOf?: (projectId: number) => boolean | undefined;
  /** Row quick action: pending update count (undefined until hover-loaded). */
  updatesOf?: (projectId: number) => number | undefined;
  /** Row quick action: flip autoSync for the row's project. */
  onToggleAutoSync?: (p: ProjectRow) => void;
  /** Row quick action: run one sync for the row's project. */
  onSyncNow?: (p: ProjectRow) => void;
  /** 行内按钮反馈态（loading → ✅ → 2s 复原），由 App 的 useActionFeedback 供。 */
  autoSyncStateOf?: (projectId: number) => ActionState;
  syncStateOf?: (projectId: number) => ActionState;
  /** 开目录/终端按钮的反馈态（同源 useActionFeedback，键与回调成对）。 */
  openExplorerStateOf?: (projectId: number) => ActionState;
  openTerminalStateOf?: (projectId: number) => ActionState;
  /** Row badges: 该项目各 harness 的「运行中/打开」会话计数（全局状态总线供给）。 */
  sessionStatsOf?: (projectId: number) => HarnessSessionCounts[] | undefined;
  /** 拖拽落定后的目标顺序（id 全量列表）——持久化与失败回滚都归 App。 */
  onReorder?: (ids: number[]) => void;
}

/** One open context-menu instance: screen position + target project. */
interface ProjectMenu {
  x: number;
  y: number;
  project: ProjectRow;
}

export function ProjectList({
  projects,
  selectedId,
  globalActive,
  onSelect,
  onSelectGlobal,
  onOpenExplorer,
  onOpenTerminal,
  onHoverProject,
  autoSyncOf,
  updatesOf,
  onToggleAutoSync,
  onSyncNow,
  autoSyncStateOf,
  syncStateOf,
  openExplorerStateOf,
  openTerminalStateOf,
  sessionStatsOf,
  onReorder,
}: ProjectListProps) {
  const t = useT();
  const sortSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // 项目行拖拽排序：内嵌 DndContext 与 App 级资产拖拽完全隔离（draggable
  // 只绑最近 context）；落定只算目标顺序，持久化/失败回滚都归 App。
  const onSortEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = projects.findIndex((p) => p.id === Number(active.id));
    const to = projects.findIndex((p) => p.id === Number(over.id));
    if (from < 0 || to < 0) return;
    onReorder?.(arrayMove(projects, from, to).map((p) => p.id));
  };
  const [menu, setMenu] = useState<ProjectMenu | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Any interaction outside the menu closes it (click, another right-click,
  // scroll, Esc). Clicks INSIDE the menu are left to the item buttons' own
  // onClick (which closes the menu itself): closing here first would flush
  // synchronously mid-dispatch, unmount the button before the delegated
  // listener on <body> runs, and React drops the click on the detached target.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event): void => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener('click', close, true);
    window.addEventListener('contextmenu', close, true);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close, true);
      window.removeEventListener('contextmenu', close, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);

  return (
    <div className="flex flex-col">
      {/* 全局配置 */}
      <p className="px-4 pt-2 pb-1 text-[11px] text-neutral-500 uppercase tracking-wide">
        {t('project.globalConfig')}
      </p>
      <div className="px-2">
        <button
          onClick={onSelectGlobal}
          className={cn(
            'w-full flex items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-200',
            globalActive ? 'bg-neutral-800/80' : 'hover:bg-neutral-800/50',
          )}
        >
          <Globe
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              globalActive ? 'text-emerald-400' : 'text-neutral-500',
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{t('project.globalConfig')}</span>
            <span className="block text-[11px] text-neutral-500">
              {t('project.globalSubtitle')}
            </span>
          </span>
        </button>
      </div>

      {/* 项目 */}
      <p className="px-4 pt-3 pb-1 text-[11px] text-neutral-500 uppercase tracking-wide">
        {t('project.sectionHeader')}
      </p>
      {projects.length === 0 && (
        <p className="p-3 text-xs text-neutral-500">{t('project.noneRegistered')}</p>
      )}
      <ul className="p-2 space-y-1">
        <DndContext sensors={sortSensors} onDragEnd={onSortEnd}>
          <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
        {projects.map((p) => {
          const autoSync = autoSyncOf?.(p.id);
          const pending = updatesOf?.(p.id);
          const stats = sessionStatsOf?.(p.id) ?? [];
          return (
            <SortableProjectLi key={p.id} id={p.id}>
              {({ setNodeRef, style, attributes, listeners, isDragging }) => (
            <li
              ref={setNodeRef}
              style={style}
              className={cn(
                'group relative rounded-xl border transition-colors duration-200',
                !globalActive && selectedId === p.id
                  ? 'border-white/[0.14] bg-neutral-800/60'
                  : 'border-white/[0.06] bg-neutral-900/50 hover:border-white/[0.10]',
                isDragging && 'z-10 opacity-80',
              )}
              onMouseEnter={() => onHoverProject?.(p.id)}
            >
              <div className="flex items-start">
                {/* 拖拽手柄：「这张卡可拖」的显式 affordance；listeners 只挂它，
                    行点选/右键不误触（PointerSensor 5px 位移阈值激活）。 */}
                <span
                  {...attributes}
                  {...listeners}
                  title={t('project.dragToReorder')}
                  className="ml-1 mt-2 shrink-0 cursor-grab touch-none rounded p-0.5 text-neutral-600 transition-colors hover:text-neutral-300 active:cursor-grabbing"
                >
                  <GripVertical className="h-3.5 w-3.5" />
                </span>
              <button
                onClick={() => onSelect(p)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({ x: e.clientX, y: e.clientY, project: p });
                }}
                className={cn(
                  'min-w-0 flex-1 flex items-start gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors duration-200',
                  'hover:bg-white/[0.04]',
                )}
              >
                <Circle
                  className={cn(
                    'h-2 w-2 mt-1.5 shrink-0',
                    !globalActive && selectedId === p.id
                      ? 'text-emerald-400'
                      : 'text-neutral-500',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm" title={p.name}>
                    {p.name}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-500" title={p.path}>
                    {p.path}
                  </span>
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5 mt-1.5">
                  <SessionBadges counts={stats} />
                  <HealthBadge projectId={p.id} />
                </span>
              </button>
              </div>
              {/* 快捷操作簇（批 8）：卡内独立一行换行展示，不与文字同行重叠。
                  stopPropagation 在 QuickButton 内双保险。 */}
              <div className="flex items-center gap-0.5 px-2 pb-1 pl-9">
                <QuickButton
                  title={`${autoSync ? t('app.autoSyncOnTooltip') : t('app.autoSyncOffTooltip')}\n\n${t('app.scopeCoverageTooltip')}`}
                  pressed={autoSync}
                  onClick={() => onToggleAutoSync?.(p)}
                >
                  <FeedbackIcon
                    state={autoSyncStateOf?.(p.id) ?? 'idle'}
                    className="h-3.5 w-3.5"
                    icon={
                      autoSync ? (
                        <ToggleRight className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <ToggleLeft className="h-3.5 w-3.5 text-neutral-400" />
                      )
                    }
                  />
                </QuickButton>
                <span className="relative">
                  <QuickButton
                    title={`${pending ? t('project.syncPending', { n: pending }) : t('project.syncNow')}\n\n${t('app.scopeCoverageTooltip')}`}
                    onClick={() => onSyncNow?.(p)}
                  >
                    <FeedbackIcon
                      state={syncStateOf?.(p.id) ?? 'idle'}
                      className="h-3.5 w-3.5"
                      icon={
                        <RefreshCw
                          className={cn(
                            'h-3.5 w-3.5',
                            pending ? 'text-orange-300' : 'text-neutral-400',
                          )}
                        />
                      }
                    />
                  </QuickButton>
                  {Boolean(pending) && (
                    <span className="pointer-events-none absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-orange-500" />
                  )}
                </span>
                <QuickButton title={t('project.openInExplorer')} onClick={() => onOpenExplorer(p)}>
                  <FeedbackIcon
                    state={openExplorerStateOf?.(p.id) ?? 'idle'}
                    className="h-3.5 w-3.5"
                    icon={<FolderOpen className="h-3.5 w-3.5" />}
                  />
                </QuickButton>
                <QuickButton title={t('project.openInTerminal')} onClick={() => onOpenTerminal(p)}>
                  <FeedbackIcon
                    state={openTerminalStateOf?.(p.id) ?? 'idle'}
                    className="h-3.5 w-3.5"
                    icon={<Terminal className="h-3.5 w-3.5" />}
                  />
                </QuickButton>
              </div>
            </li>
              )}
            </SortableProjectLi>
          );
        })}
          </SortableContext>
        </DndContext>
      </ul>

      {/* 右键菜单 — portal 到 body：侧栏的 .frosted（backdrop-filter）会成为
          fixed 后代的 containing block，留在组件树里会被裁剪在侧栏内。 */}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              left: Math.min(menu.x, window.innerWidth - 200),
              top: Math.min(menu.y, window.innerHeight - 96),
            }}
            className="fixed z-50 w-48 rounded-lg border border-white/[0.08] bg-neutral-900 shadow-mac py-1"
            onContextMenu={(e) => e.preventDefault()}
          >
            <p className="px-3 pb-1 pt-0.5 text-[10px] text-neutral-500 truncate" title={menu.project.path}>
              {menu.project.name}
            </p>
            <MenuButton
              icon={<FolderOpen className="h-3.5 w-3.5" />}
              label={t('project.openInExplorer')}
              onClick={() => {
                onOpenExplorer(menu.project);
                setMenu(null);
              }}
            />
            <MenuButton
              icon={<Terminal className="h-3.5 w-3.5" />}
              label={t('project.openInTerminal')}
              onClick={() => {
                onOpenTerminal(menu.project);
                setMenu(null);
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * 项目行的 sortable 接线：li 拿 ref/位移样式，主按钮拿激活 attributes/listeners
 * （点选/右键不受影响——PointerSensor 以 5px 位移阈值激活拖拽）。
 */
function SortableProjectLi({
  id,
  children,
}: {
  id: number;
  children: (bind: {
    setNodeRef: (el: HTMLElement | null) => void;
    style: React.CSSProperties;
    attributes: ReturnType<typeof useSortable>['attributes'];
    listeners: ReturnType<typeof useSortable>['listeners'];
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition: transition ?? undefined,
    position: 'relative',
  };
  return children({ setNodeRef, style, attributes, listeners, isDragging });
}

function MenuButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/[0.06]"
    >
      <span className="text-neutral-400">{icon}</span>
      {label}
    </button>
  );
}

/** Row quick-action icon button — tooltip 与 aria-label 同词，点击不触发行选中。 */
function QuickButton({
  title,
  pressed,
  onClick,
  children,
}: {
  title: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="pointer-events-auto [&_svg]:pointer-events-none p-1 rounded-md text-neutral-400 hover:text-neutral-100 hover:bg-white/[0.08] transition-colors"
    >
      {children}
    </button>
  );
}

/**
 * 项目行会话徽标（跑马灯）：按 harness 分桶——运行中 = 该 harness 图标动效 + 数量
 * （橙），打开 = 同形静态图标 + 数量（暗）。同一 harness 两种状态同时存在则两枚并排
 * （一静一动），不同 harness 各自一枚。计数与状态由全局状态总线统一推导。
 */
function SessionBadges({ counts }: { counts: HarnessSessionCounts[] }) {
  const t = useT();
  return (
    <>
      {counts.map((c) => (
        <span key={c.harness ?? 'unknown'} className="flex shrink-0 items-center gap-1">
          {c.running > 0 && (
            <span
              className="flex items-center gap-0.5"
              title={t('project.sessionsRunning', { n: c.running })}
            >
              <HarnessIcon harness={c.harness} running />
              <span className="text-[10px] font-medium text-orange-300">{c.running}</span>
            </span>
          )}
          {c.open > 0 && (
            <span
              className="flex items-center gap-0.5"
              title={t('project.sessionsOpen', { n: c.open })}
            >
              <HarnessIcon harness={c.harness} />
              <span className="text-[10px] font-medium text-neutral-400">{c.open}</span>
            </span>
          )}
        </span>
      ))}
    </>
  );
}

/** check id → web 词典 key（core 只回结构，文案由词典渲染）。 */
const HEALTH_KEYS: Record<string, MessageKey> = {
  'instruction-link-not-materialised': 'health.check.instructionLinkNotMaterialised',
  'instruction-files-duplicated': 'health.check.instructionFilesDuplicated',
  'instruction-link-dangling': 'health.check.instructionLinkDangling',
  'statusline-path-unresolved': 'health.check.statuslinePathUnresolved',
  'statusline-path-foreign': 'health.check.statuslinePathForeign',
  'statusline-script-missing': 'health.check.statuslineScriptMissing',
};

/**
 * 健康徽标（批 8）：全 ok → 绿点；有 fail → 警示图标 + tooltip 列出失败项。
 * 请求失败（daemon 未运行 / 端点 500）→ 静默不显示，不打扰。
 */
function HealthBadge({ projectId }: { projectId: number }) {
  const t = useT();
  const [fails, setFails] = useState<HarnessCheck[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getHarnessChecks(projectId)
      .then((r) => {
        if (alive) setFails(r.checks.filter((c) => !c.ok));
      })
      .catch(() => {
        // daemon 未运行或端点出错 —— 静默，不显示徽标
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  if (fails === null) return null;

  if (fails.length === 0) {
    return <span title={t('health.okTip')} className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />;
  }

  const tip = [
    t('health.badgeTip', { count: fails.length }),
    ...fails.flatMap((c) => {
      const key = HEALTH_KEYS[c.id];
      return key ? [t(key, c.params)] : [];
    }),
  ].join('\n');

  return (
    <span title={tip} className="shrink-0">
      <TriangleAlert className="h-3.5 w-3.5 text-amber-400" />
    </span>
  );
}
