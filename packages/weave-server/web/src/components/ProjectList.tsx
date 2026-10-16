import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
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
import { AgentBadge } from '@/components/AgentBadge';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { HarnessIcon } from '@/components/tasks/HarnessIcon';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { ActionState } from '@/lib/action-feedback';
import type { HarnessSessionCounts } from '@/components/tasks/session-status';
import {
  Archive,
  ArchiveRestore,
  FolderOpen,
  Globe,
  GripVertical,
  RefreshCw,
  Terminal,
  ToggleLeft,
  ToggleRight,
  TriangleAlert,
  X,
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
  /** Row badges: 该项目各 harness 的「运行中/就绪」会话计数（全局状态总线供给）。 */
  sessionStatsOf?: (projectId: number) => HarnessSessionCounts[] | undefined;
  /** Row 快速操作：该项目已打开的终端窗口数（0 = 无角标）。 */
  terminalsOf?: (projectId: number) => number;
  /** 拖拽落定后的目标顺序（id 全量列表）——持久化与失败回滚都归 App。 */
  onReorder?: (ids: number[]) => void;
  /** 归档项目（仅基础信息；非空时「项目」标题旁出现查看入口）。 */
  archivedProjects?: ProjectRow[];
  /** 右键菜单「归档项目」：确认在组件内，动作（API + 刷新）归 App。 */
  onArchive?: (p: ProjectRow) => void;
  /** 归档面「恢复」按钮动作。 */
  onRestore?: (p: ProjectRow) => void;
  /** 恢复按钮三态（键 = 项目 id）。 */
  restoreStateOf?: (projectId: number) => ActionState;
}

/** One open context-menu instance: screen position + target project. */
interface ProjectMenu {
  x: number;
  y: number;
  project: ProjectRow;
}

/** 触屏长按开菜单的门槛（位移超过它算滑动，不算长按）。 */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 8;

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
  terminalsOf,
  onReorder,
  archivedProjects = [],
  onArchive,
  onRestore,
  restoreStateOf,
}: ProjectListProps) {
  const t = useT();
  // 传感器按指针能力分流（同 App）：鼠标 5px 位移激活；触屏 200ms 长按激活
  // （容差 8px——长按期间手指微动不误触、不吞列表滚动）。
  const finePointer = useMediaQuery('(pointer: fine)');
  const mouseSensor = useSensor(PointerSensor, { activationConstraint: { distance: 5 } });
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } });
  const sortSensors = useSensors(finePointer ? mouseSensor : touchSensor);
  // 归档弹窗开合：本地 UI 态；入口按钮只在有归档项目时出现
  const [archivedOpen, setArchivedOpen] = useState(false);
  // 待确认归档的项目：右键菜单设入，应用内 ConfirmDialog 确认后交 App 执行
  const [confirmTarget, setConfirmTarget] = useState<ProjectRow | null>(null);
  // 恢复最后一个归档项目后列表空 → 自动收弹窗（不留死态）
  useEffect(() => {
    if (archivedOpen && archivedProjects.length === 0) setArchivedOpen(false);
  }, [archivedOpen, archivedProjects.length]);

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

  // Any interaction outside the menu closes it (press, another right-click,
  // scroll, Esc). Events INSIDE the menu are left to the item buttons' own
  // onClick (which closes the menu itself): closing here first would flush
  // synchronously mid-dispatch, unmount the button before the delegated
  // listener on <body> runs, and React drops the click on the detached target.
  // 触发用 pointerdown 而非 click：触屏长按开菜单后，抬手还会补一个 click，
  // 那一击会当场把刚开的菜单关掉（pointerdown 不会被补发）。
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event): void => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('contextmenu', close, true);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('contextmenu', close, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);

  /** 触屏长按 = 右键的等价动作（移动端没有右键这回事）；抬手补的那个 click
   *  要吞掉，否则它顺带点选这个项目（用户要的是菜单里那一项）。 */
  const suppressClick = useRef(false);
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const clearPress = (): void => {
    if (!press.current) return;
    window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const onPressDown = (project: ProjectRow) => (e: React.PointerEvent): void => {
    // 上一轮长按若没等到补发的那个 click，别把这一次的点击也吞了
    suppressClick.current = false;
    if (finePointer || e.button !== 0) return;
    const { clientX: x, clientY: y } = e;
    const timer = window.setTimeout(() => {
      press.current = null;
      suppressClick.current = true;
      setMenu({ x, y, project });
    }, LONG_PRESS_MS);
    press.current = { x, y, timer };
  };
  const onPressMove = (e: React.PointerEvent): void => {
    const p = press.current;
    if (!p) return;
    // 位移即取消：滑动列表 / 拖拽手柄都不是长按
    if (Math.abs(e.clientX - p.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - p.y) > LONG_PRESS_SLOP) {
      clearPress();
    }
  };

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
      <div className="flex items-center gap-1 px-4 pt-3 pb-1">
        <p className="flex-1 text-[11px] text-neutral-500 uppercase tracking-wide">
          {t('project.sectionHeader')}
        </p>
        {/* 查看归档入口：有归档项目才出现，点击弹 3 列卡片弹窗 */}
        {archivedProjects.length > 0 && (
          <button
            type="button"
            aria-label={t('project.archivedCount', { n: archivedProjects.length })}
            title={t('project.archivedCount', { n: archivedProjects.length })}
            onClick={() => setArchivedOpen(true)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 transition-colors hover:text-neutral-200 hover:bg-neutral-800/50"
          >
            <Archive className="h-3 w-3" />
            {archivedProjects.length}
          </button>
        )}
      </div>
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
          const terminals = terminalsOf?.(p.id) ?? 0;
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
                onClick={() => {
                  // 长按刚开的菜单：这一击是抬手补的，不当点选
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  onSelect(p);
                }}
                onPointerDown={onPressDown(p)}
                onPointerMove={onPressMove}
                onPointerUp={clearPress}
                onPointerCancel={clearPress}
                onContextMenu={(e) => {
                  // 触屏长按也会弹原生菜单：一律压掉，但那条路走长按
                  e.preventDefault();
                  e.stopPropagation();
                  if (!finePointer) return;
                  setMenu({ x: e.clientX, y: e.clientY, project: p });
                }}
                className={cn(
                  'min-w-0 flex-1 flex items-start gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors duration-200',
                  'hover:bg-white/[0.04]',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm" title={p.name}>
                    {p.name}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-500" title={p.path}>
                    {p.path}
                  </span>
                  {/* 已接入 harness（init 选择结果，服务端派生）：起会话的 harness
                      选项同一份事实。 */}
                  {(p.harnesses?.length ?? 0) > 0 && (
                    <span
                      className="mt-1 flex flex-wrap items-center gap-1"
                      title={t('project.harnessesTip')}
                    >
                      {p.harnesses!.map((h) => (
                        <AgentBadge key={h.id} agent={h.id} />
                      ))}
                    </span>
                  )}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5 mt-1.5">
                  <SessionBadges counts={stats} />
                  <HealthBadge projectId={p.id} />
                </span>
              </button>
              </div>
              {/* 快捷操作簇（批 8）：卡内独立一行换行展示，不与文字同行重叠。
                  stopPropagation 在 QuickButton 内双保险。 */}
              <div className="flex items-center gap-1 px-2 pb-1 pl-9">
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
                {/* 终端：该项目已有终端窗口开着 → 图标转绿 + 角标示数
                    （窗口级口径；分屏 pane 与会话都不计）。 */}
                <span className="relative">
                  <QuickButton
                    title={
                      terminals > 0
                        ? `${t('project.terminalsOpen', { n: terminals })}\n\n${t('project.openInTerminal')}`
                        : t('project.openInTerminal')
                    }
                    onClick={() => onOpenTerminal(p)}
                  >
                    <FeedbackIcon
                      state={openTerminalStateOf?.(p.id) ?? 'idle'}
                      className="h-3.5 w-3.5"
                      icon={
                        <Terminal
                          className={cn('h-3.5 w-3.5', terminals > 0 && 'text-emerald-400')}
                        />
                      }
                    />
                  </QuickButton>
                  {terminals > 0 && (
                    <span className="pointer-events-none absolute -top-1 -right-1.5 rounded-full bg-emerald-900/80 px-1 text-[9px] leading-3 text-emerald-300">
                      {terminals}
                    </span>
                  )}
                </span>
              </div>
            </li>
              )}
            </SortableProjectLi>
          );
        })}
          </SortableContext>
        </DndContext>
      </ul>

      {/* 归档弹窗 — portal 到 body（同右键菜单：侧栏 .frosted 会裁剪 fixed 后代）。
          3 列卡片网格；恢复最后一个后列表空 → 效果里自动收弹窗。 */}
      {archivedOpen &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center p-3 lg:p-6">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setArchivedOpen(false)} />
            <div className="relative w-[680px] max-w-full rounded-2xl border border-white/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
              <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-white/[0.06] frosted">
                <Archive className="h-4 w-4 text-neutral-400" />
                <span className="text-sm font-semibold text-neutral-200">
                  {t('project.archivedSection')}
                </span>
                <span className="text-xs text-neutral-500">{archivedProjects.length}</span>
                <button
                  onClick={() => setArchivedOpen(false)}
                  className="ml-auto p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
                  title={t('common.close')}
                >
                  <X className="h-4 w-4" />
                </button>
              </header>
              <div className="p-4 max-h-[60vh] overflow-y-auto">
                <div className="grid grid-cols-3 gap-3">
                  {archivedProjects.map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-neutral-900/50 p-3"
                    >
                      <div className="flex items-center gap-2">
                        <Archive className="h-4 w-4 shrink-0 text-neutral-600" />
                        <span className="truncate text-sm text-neutral-200" title={p.name}>
                          {p.name}
                        </span>
                      </div>
                      <p className="text-[11px] text-neutral-500 truncate" title={p.path}>
                        {p.path}
                      </p>
                      {p.archivedAt && (
                        <p className="text-[11px] text-neutral-600">
                          {t('project.archivedOn', { date: new Date(p.archivedAt).toLocaleString() })}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => onRestore?.(p)}
                        title={t('project.restoreTooltip')}
                        className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-white/[0.16] hover:bg-white/[0.08] hover:text-neutral-100"
                      >
                        <FeedbackIcon
                          state={restoreStateOf?.(p.id) ?? 'idle'}
                          className="h-3.5 w-3.5"
                          icon={<ArchiveRestore className="h-3.5 w-3.5" />}
                        />
                        {t('project.restore')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 归档确认弹窗：替代原生 window.confirm */}
      <ConfirmDialog
        open={confirmTarget !== null}
        title={t('project.archive')}
        message={confirmTarget ? t('project.archiveConfirm', { name: confirmTarget.name }) : ''}
        confirmLabel={t('common.confirm')}
        onConfirm={() => {
          if (confirmTarget) onArchive?.(confirmTarget);
        }}
        onClose={() => setConfirmTarget(null)}
      />

      {/* 右键菜单 — portal 到 body：侧栏的 .frosted（backdrop-filter）会成为
          fixed 后代的 containing block，留在组件树里会被裁剪在侧栏内。 */}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              left: Math.min(menu.x, window.innerWidth - 200),
              top: Math.min(menu.y, window.innerHeight - 88),
            }}
            className="fixed z-50 w-48 rounded-lg border border-white/[0.08] bg-neutral-900 shadow-mac py-1"
            onContextMenu={(e) => e.preventDefault()}
          >
            <p className="px-3 pb-1 pt-0.5 text-[10px] text-neutral-500 truncate" title={menu.project.path}>
              {menu.project.name}
            </p>
            {/* 右键只留归档：开目录/开终端与行内按钮簇重复，行内是快捷路径。
                破坏性动作（历史会话即清空）：应用内 ConfirmDialog 确认再交 App 执行。 */}
            <MenuButton
              icon={<Archive className="h-3.5 w-3.5" />}
              label={t('project.archive')}
              onClick={() => {
                setConfirmTarget(menu.project);
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
      className="pointer-events-auto [&_svg]:pointer-events-none inline-flex h-5 w-5 items-center justify-center rounded border border-white/[0.08] bg-white/[0.02] text-neutral-400 transition-colors hover:border-white/[0.16] hover:bg-white/[0.08] hover:text-neutral-100"
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
