import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, Check, ChevronLeft, Folder, Search, X } from 'lucide-react';
import type { ProjectRow, SessionRow } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useBackPop } from '@/lib/back-pop';
import { useMediaQuery } from '@/lib/use-media-query';
import { sessionLabel } from '@/lib/hook-payload';
import { SessionStatusIcon } from './SessionStatusIcon';
import { STATUS_KEY, type SessionStatus } from './session-status';

/**
 * 会话穿梭选择器（`#` 触发，层级同文件选择器）：桌面左栏 = 项目、右栏 = 该项目
 * 下的会话（带终端状态图标与文案——与会话列表同一份状态机，`statuses` 由调用方
 * 从全局状态总线取）。键盘是主路径：**←→ 换层**（左＝回项目栏，右＝进会话栏）、
 * **↑↓ 栏内移动**、**Space 多选**（焦点栏当前行打勾；多选后 Enter = 整批落定）、
 * **Enter 落定**（项目行＝下钻，会话行＝选定）、Esc 先清搜索再关；可打印字符直接
 * 进搜索框——监听挂 document 捕获阶段，焦点落在哪儿都还能用键盘（FilePicker 同
 * 款）。搜索时跨全部项目平铺（每行带所属项目），清空即回层级模式。
 *
 * 项目引用（仅 superagent 仓给入口）：项目行上的 `P`（或项目行右侧的按钮）= 把**整个项目**插成青色标注胶囊
 * （`#p<id>「名」`，纯上下文标注——模型自己读项目文件）；Enter 仍是下钻进会话。
 *
 * **焦点栏高亮**：焦点行实底 + 左缘竖条（三像素 accent），非焦点栏淡底无竖条——
 * ←→ 在哪边一眼可辨（原先两栏只差一档底色，看不出焦点在哪边）。
 *
 * 移动端一屏一列（同 FilePicker）：项目列表 ⇄ 会话列表两屏下钻，头部返回箭头 +
 * 系统返回手势都归「回项目列表」，退无可退才关弹窗；触屏单击会话行直接落定。
 *
 * 内建仓库（RPG 角色仓/协调者仓，`hidden:true`）不进候选：项目行与会话行（层级
 * 桶与搜索平铺两路）都在渲染层滤——唯一判据 = shuttleVisibleProjects（纯函数）。
 */

/** 隐藏过滤的唯一判据（纯函数供单测；与 ProjectList.visibleProjectsOf 同口径）。 */
export function shuttleVisibleProjects(projects: readonly ProjectRow[]): ProjectRow[] {
  return projects.filter((p) => !p.hidden);
}

export function SessionShuttlePicker({
  sessions,
  projects,
  statuses,
  currentProjectId,
  onPick,
  onPickBatch,
  onPickProject,
  onPickProjectsBatch,
  superagentTitle,
  onClose,
}: {
  /** 候选会话（调用方已排除当前会话）。 */
  sessions: SessionRow[];
  projects: ProjectRow[];
  /** sessionId → 终端状态（全局状态总线的推导结果；缺 = 按「打开」处理）。 */
  statuses: ReadonlyMap<string, SessionStatus>;
  /** 默认选中的项目（当前会话所属）：打开即落在它的会话列表上。 */
  currentProjectId: number | null;
  /** 落定目标：调用方插胶囊并关弹窗（多选时按 Enter 整批落定，顺序 = 选择序）。 */
  onPick: (sessionId: string, name: string) => void;
  onPickBatch?: (picked: ReadonlyArray<{ sessionId: string; name: string }>) => void;
  /** 引用整个项目（青色标注胶囊；缺席 = 不提供项目引用入口，含多选）。 */
  onPickProject?: (projectId: number, name: string) => void;
  onPickProjectsBatch?: (picked: ReadonlyArray<{ projectId: number; name: string }>) => void;
  /** 标题换 superagent 版（「引用项目/会话」）：项目引用的消费者是上帝/协调链。 */
  superagentTitle?: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  // 内建仓库（RPG 角色仓/协调者仓）不进候选：行集与会话分组都在渲染层滤（use-projects 注）。
  const visibleProjects = useMemo(() => shuttleVisibleProjects(projects), [projects]);
  const hiddenProjectIds = useMemo(
    () => new Set(projects.filter((p) => p.hidden).map((p) => p.id)),
    [projects],
  );
  const [query, setQuery] = useState('');
  /** 桌面两栏的焦点在哪一栏（窄屏没有「两栏焦点」，跟下钻的屏走——见 focusCol）。 */
  const [col, setCol] = useState<'projects' | 'sessions'>('sessions');
  const [sessIdx, setSessIdx] = useState(0);
  /** Space 勾选的会话（选择序保序）：多选后 Enter = 整批落定；单选路径不经过它。 */
  const [picked, setPicked] = useState<Array<{ sessionId: string; name: string }>>([]);
  /** Space 勾选的项目（焦点在项目栏时同款多选；与会话账互斥——勾的项目不进会话账）。 */
  const [pickedProjects, setPickedProjects] = useState<Array<{ projectId: number; name: string }>>([]);
  /** 窄屏两屏下钻：项目列表 ⇄ 会话列表（同 FilePicker 的 list/preview）。 */
  const [screen, setScreen] = useState<'projects' | 'sessions'>('sessions');

  const searchRef = useRef<HTMLInputElement>(null);
  const projListRef = useRef<HTMLUListElement>(null);
  const sessListRef = useRef<HTMLUListElement>(null);
  /** 键盘导航中：方向键按下后悬停不再抢高亮，直到鼠标真的动一下（FilePicker 同款）。 */
  const kbdNav = useRef(false);

  const projectName = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  /** 项目桶：projectId → 该项目的会话（最近活跃在前）。无名项目垫底成「未归属」。
   *  隐藏项目（内建仓库）的会话整桶不进候选。 */
  const groups = useMemo(() => {
    const byProject = new Map<number | null, SessionRow[]>();
    for (const s of sessions) {
      const key = s.projectId ?? null;
      if (key != null && hiddenProjectIds.has(key)) continue;
      const list = byProject.get(key) ?? [];
      list.push(s);
      byProject.set(key, list);
    }
    for (const list of byProject.values()) {
      list.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
    }
    // 项目顺序与用户的项目列表一致（左栏同源），无名项目垫底
    const keys = [...byProject.keys()].sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return visibleProjects.findIndex((p) => p.id === a) - visibleProjects.findIndex((p) => p.id === b);
    });
    return keys.map((id) => ({
      projectId: id,
      name: id === null ? t('tasks.sessionPickerNoProject') : (projectName.get(id) ?? `#${id}`),
      rows: byProject.get(id)!,
      // 「引用整个项目」入口只给内建超级代理仓（项目引用的消费者是上帝/协调链）
      superagent: id != null && visibleProjects.find((p) => p.id === id)?.superagent === true,
    }));
  }, [sessions, visibleProjects, hiddenProjectIds, projectName, t]);

  // 打开那拍落在当前会话所属的项目上（惰性初始化：首算即定，之后不随数据刷新漂）
  const [projIdx, setProjIdx] = useState(() =>
    Math.max(0, groups.findIndex((g) => g.projectId === currentProjectId)),
  );

  /** 搜索态：非空 = 跨全部项目平铺（层级两栏让位给单一结果列表）。隐藏项目的会话不进候选。 */
  const flat = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return sessions.filter((s) => {
      if (s.projectId != null && hiddenProjectIds.has(s.projectId)) return false;
      const label = sessionLabel(s.title, s.sessionId).toLowerCase();
      return label.includes(q) || s.sessionId.toLowerCase().includes(q);
    });
  }, [sessions, hiddenProjectIds, query]);

  /** 焦点列：搜索态恒在会话栏；桌面由 ←→ 切，窄屏跟着下钻的屏走（两态合一，
   *  不再用一个 effect 把 col 同步成 screen）。 */
  const focusCol: 'projects' | 'sessions' = flat ? 'sessions' : isDesktop ? col : screen;
  /** 窄屏两屏下钻（桌面两栏、搜索态平铺都不适用）。 */
  const drilldown = !isDesktop && !flat;

  /** 右栏此刻的行集：搜索态 = 平铺结果，层级态 = 焦点项目的会话。 */
  const rightRows = flat ?? groups[projIdx]?.rows ?? [];

  // 换项目 / 换搜索词：右栏高亮收回首条；行集缩短时高亮收回界内；勾选账清掉
  // （勾的是「这一屏的行」，换屏后旧勾容易变成看不见的幽灵选择）
  useEffect(() => {
    setSessIdx(0);
    setPicked([]);
    setPickedProjects([]);
  }, [query, projIdx]);
  useEffect(() => {
    setSessIdx((i) => Math.min(i, Math.max(0, rightRows.length - 1)));
  }, [rightRows.length]);

  // 高亮项滚进视野：↑↓ 连滑会走出可视区（两栏各自滚各自的）
  useEffect(() => {
    projListRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [projIdx, groups]);
  useEffect(() => {
    sessListRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    // rightRows 每次渲染都是新数组，只认长度（内容变了高亮会被上面的 effect 收回 0）
  }, [sessIdx, rightRows.length]);

  /** ESC：搜索框有字先清字（一次退一层），没字才关弹窗。 */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** 搜索词进 ref：监听器只挂一次，不必每敲一键拆装 document 捕获级 keydown。 */
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (queryRef.current !== '') setQuery('');
      else closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // 移动端返回键/侧滑：先归弹窗自己的层（会话屏回项目列表 → 清搜索），退无可退才关
  useBackPop(true, () => {
    if (drilldown && screen === 'sessions') {
      setScreen('projects');
      return true;
    }
    if (query !== '') {
      setQuery('');
      return true;
    }
    onClose();
    return true;
  });

  /** 事件目标是否在输入控件里（搜索框的空格/字符归输入，不被导航键抢走）。 */
  const inAnyInput = (e: KeyboardEvent): boolean =>
    e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

  /** 方向键/回车的导航（document 捕获阶段，FilePicker 同款）。 */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      kbdNav.current = true;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      if (focusCol === 'projects') {
        setProjIdx((i) => Math.min(groups.length - 1, Math.max(0, i + step)));
      } else {
        setSessIdx((i) => Math.min(rightRows.length - 1, Math.max(0, i + step)));
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (flat) {
        setQuery(''); // 搜索态 ← 清搜索回层级
        return;
      }
      // 窄屏两屏下钻：会话屏 ← 回项目屏（同返回手势）
      if (drilldown) {
        setScreen('projects');
        return;
      }
      setCol('projects');
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      // 项目行 → = 下钻：窄屏换屏，桌面换焦点栏
      if (drilldown && screen === 'projects') {
        setScreen('sessions');
        return;
      }
      if (!flat && col === 'projects') setCol('sessions');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // 项目行的 Enter = 下钻（与 → 同义）；会话行的 Enter 才是落定。
      // 多选有账 = 整批落定（顺序 = Space 勾选序），不管焦点在哪一行。
      if (focusCol === 'projects') {
        if (pickedProjects.length > 0 && onPickProjectsBatch) {
          onPickProjectsBatch(pickedProjects);
          return;
        }
        if (drilldown) setScreen('sessions');
        else setCol('sessions');
        return;
      }
      if (picked.length > 0) {
        onPickBatch?.(picked);
        return;
      }
      const hit = rightRows[sessIdx];
      if (hit) onPick(hit.sessionId, sessionLabel(hit.title, hit.sessionId));
      return;
    }
    // Space = 焦点栏当前行打勾/取消（项目/会话同款多选）。搜索框里也勾（检索中
    // 空格勾选是主路径，检索词要空格就粘贴）；其他输入控件/按钮上的空格归它们自己。
    if (e.key === ' ') {
      if (e.target instanceof HTMLElement && e.target.closest('button')) return;
      if (inAnyInput(e) && e.target !== searchRef.current) return;
      e.preventDefault();
      if (focusCol === 'projects') {
        if (!onPickProject) return;
        const g = groups[projIdx];
        const pid = g?.projectId;
        if (pid == null) return;
        const name = g!.name;
        setPickedProjects((prev) =>
          prev.some((p) => p.projectId === pid)
            ? prev.filter((p) => p.projectId !== pid)
            : [...prev, { projectId: pid, name }],
        );
        return;
      }
      const hit = rightRows[sessIdx];
      if (!hit) return;
      const name = sessionLabel(hit.title, hit.sessionId);
      setPicked((prev) =>
        prev.some((p) => p.sessionId === hit.sessionId)
          ? prev.filter((p) => p.sessionId !== hit.sessionId)
          : [...prev, { sessionId: hit.sessionId, name }],
      );
      return;
    }
    // 可打印字符直接进搜索框：打开选择器直接敲就是了
    const inInput = inAnyInput(e);
    if (!inInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setQuery((q) => q + e.key);
      searchRef.current?.focus();
      setCol('sessions');
    }
  };

  /** 监听器只挂一次、转给当下的闭包：省得每次渲染拆装。 */
  const keyHandler = useRef(onKeyDown);
  keyHandler.current = onKeyDown;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keyHandler.current(e);
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // 不自动聚焦搜索框（FilePicker 同款）：默认焦点在列表上，Space 才是勾选；
  // 可打印字符由导航监听转进搜索框，跟从搜索框里打一样。

  /** 行高亮：焦点行 = 实底 + **左缘竖条**（三像素 accent，颜色随栏——项目蓝 /
   *  会话紫，两栏各自的焦点色不同进一步拉开）+ 亮字；非焦点栏淡底。原先两栏只差
   *  一档底色，看不出 ←→ 的焦点在哪边（用户实测反馈）。 */
  const rowClass = (focused: boolean, accent: 'project' | 'session'): string =>
    focused
      ? cn(
          'relative text-neutral-100',
          accent === 'project' ? 'bg-blue-500/20' : 'bg-violet-500/20',
        )
      : accent === 'project'
        ? 'bg-blue-500/[0.05] text-neutral-300'
        : 'bg-violet-500/[0.07] text-neutral-200';
  /** 焦点行的左缘竖条（绝对定位覆盖整行高）：颜色即焦点色。 */
  const focusBar = (accent: 'project' | 'session'): string =>
    accent === 'project' ? 'bg-blue-400' : 'bg-violet-400';

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 max-lg:p-0"
      onClick={onClose}
    >
      {/* h-[70%] 不用 70dvh：根 zoom 下视口单位被二次放大（见 index.css #root 注） */}
      <div
        className="flex h-[70%] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-edge/[0.08] bg-neutral-900 shadow-mac max-lg:h-full max-lg:max-w-none max-lg:rounded-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头：标题 + 搜索。窄屏会话屏换「← 项目名」——箭头即回项目列表。 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-edge/[0.06] px-3 py-2">
          {drilldown && screen === 'sessions' && (
            <Tooltip label={t('tasks.fileBack')}>
              <button
                type="button"
                aria-label={t('tasks.fileBack')}
                onClick={() => setScreen('projects')}
                className="-ml-1 rounded p-1 text-neutral-400 hover:text-neutral-100"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-200">
            {drilldown && screen === 'sessions'
              ? (groups[projIdx]?.name ?? t('tasks.sessionPickerTitle'))
              : t(superagentTitle ? 'tasks.sessionPickerTitleSuper' : 'tasks.sessionPickerTitle')}
          </p>
          <div className="relative w-56 shrink-0 max-lg:w-40">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-600" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('tasks.sessionPickerSearch')}
              className="w-full rounded border border-edge/[0.1] bg-neutral-950 py-1 pl-7 pr-6 text-11 text-neutral-100 focus:border-violet-500/40 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label={t('tasks.fileClearSearch')}
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-neutral-600 hover:text-neutral-300"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <Tooltip label={t('common.close')}>
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={onClose}
              className="rounded p-1 text-neutral-500 hover:text-neutral-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>

        {/* 体：项目 | 会话（层级）；搜索态右栏独占（平铺结果，每行带所属项目）。
            窄屏一屏一列：项目列表 ⇄ 会话列表两屏下钻（同 FilePicker 的 list/preview）。 */}
        <div className="flex min-h-0 flex-1">
          {!flat && (isDesktop || screen === 'projects') && (
            <ul
              ref={projListRef}
              role="listbox"
              aria-label={t('orch.filterProject')}
              onMouseMove={() => {
                kbdNav.current = false;
              }}
              className={cn(
                'shrink-0 overflow-y-auto overscroll-contain py-1',
                isDesktop ? 'w-44 border-r border-edge/[0.06]' : 'min-h-0 w-full',
              )}
            >
              {groups.map((g, i) => {
                const projPicked = pickedProjects.some((p) => p.projectId === g.projectId);
                return (
                <li key={g.projectId ?? 'none'} className="relative">
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === projIdx}
                    onMouseEnter={() => {
                      if (!kbdNav.current) {
                        setProjIdx(i);
                        setCol('projects');
                      }
                    }}
                    onClick={() => {
                      setProjIdx(i);
                      setCol('projects');
                      // 窄屏点项目行 = 下钻进该项目的会话列表（同文件选择器进目录）
                      if (!isDesktop) setScreen('sessions');
                    }}
                    onDoubleClick={() => {
                      setProjIdx(i);
                      setCol('sessions');
                      if (!isDesktop) setScreen('sessions');
                    }}
                    className={cn(
                      // pr-7 让位给行右侧的「引用整个项目」小钮（有入口时）
                      'flex w-full items-center gap-1.5 py-1 pl-2.5 pr-7 text-left text-xs transition-colors',
                      i === projIdx
                        ? rowClass(focusCol === 'projects', 'project')
                        : 'text-neutral-300 hover:bg-edge/[0.04]',
                    )}
                  >
                    {i === projIdx && focusCol === 'projects' && (
                      <span
                        aria-hidden
                        className={cn('absolute inset-y-0 left-0 w-[3px] rounded-full', focusBar('project'))}
                      />
                    )}
                    <Folder className="h-3.5 w-3.5 shrink-0 text-blue-300/80" />
                    <span className="min-w-0 flex-1 truncate">{g.name}</span>
                    {projPicked && <Check className="h-3 w-3 shrink-0 text-blue-300" strokeWidth={3} />}
                    <span className="shrink-0 text-10 tabular-nums text-neutral-600">{g.rows.length}</span>
                  </button>
                  {/* 引用整个项目：纯上下文标注（`#p<id>「名」`，青色胶囊）——与下钻
                      分开（点行 = 下钻、点它 = 引用），触屏也能直接够到。仅内建
                      superagent 仓有这枚钮（项目引用的消费者是上帝/协调链）。 */}
                  {onPickProject && g.projectId != null && g.superagent && (
                    <Tooltip
                      label={t('tasks.projectRefPick')}
                      side="top"
                      // Tooltip 的 wrapper 自己当定位容器：span 走行内流会顶挤/悬空错位
                      className="absolute inset-y-0 right-1.5 flex items-center"
                    >
                      <button
                        type="button"
                        aria-label={t('tasks.projectRefPick')}
                        onClick={() => onPickProject(g.projectId!, g.name)}
                        className="rounded p-1 text-neutral-500 transition-colors hover:bg-edge/[0.08] hover:text-cyan-300"
                      >
                        <Box className="h-3 w-3" />
                      </button>
                    </Tooltip>
                  )}
                </li>
                );
              })}
            </ul>
          )}
          <ul
            ref={sessListRef}
            role="listbox"
            aria-label={t('tasks.sessionPickerTitle')}
            onMouseMove={() => {
              kbdNav.current = false;
            }}
            className={cn(
              'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain py-1',
              // 窄屏项目屏：会话列表让位（一屏一列）
              drilldown && screen === 'projects' && 'hidden',
            )}
          >
            {rightRows.length === 0 && (
              <li className="px-3 py-6 text-11 text-neutral-500">{t('orch.pickerEmpty')}</li>
            )}
            {rightRows.map((s, i) => {
              const status = statuses.get(s.sessionId) ?? 'open';
              const pid = s.projectId ?? null;
              const isPicked = picked.some((p) => p.sessionId === s.sessionId);
              return (
                <li key={s.sessionId} className="relative">
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === sessIdx}
                    onMouseEnter={() => {
                      if (!kbdNav.current) {
                        setSessIdx(i);
                        setCol('sessions');
                      }
                    }}
                    onClick={() => {
                      setSessIdx(i);
                      setCol('sessions');
                      // 触屏没有可靠的双击，会话也没有预览步骤：单击直接落定
                      if (!isDesktop) onPick(s.sessionId, sessionLabel(s.title, s.sessionId));
                    }}
                    onDoubleClick={() => onPick(s.sessionId, sessionLabel(s.title, s.sessionId))}
                    className={cn(
                      'flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs transition-colors',
                      i === sessIdx
                        ? rowClass(focusCol === 'sessions', 'session')
                        : 'text-neutral-300 hover:bg-edge/[0.04]',
                      isPicked && i !== sessIdx && 'bg-violet-500/10',
                    )}
                  >
                    {i === sessIdx && focusCol === 'sessions' && (
                      <span
                        aria-hidden
                        className={cn('absolute inset-y-0 left-0 w-[3px] rounded-full', focusBar('session'))}
                      />
                    )}
                    <SessionStatusIcon status={status} harness={s.harness} />
                    <span className="min-w-0 flex-1 truncate">{sessionLabel(s.title, s.sessionId)}</span>
                    {/* Space 勾选的行：勾标记盖在状态文案前（勾选序 = 落定序） */}
                    {isPicked && (
                      <Check className="h-3 w-3 shrink-0 text-violet-300" strokeWidth={3} />
                    )}
                    {/* 搜索态跨项目平铺：所属项目只有它能区分（层级模式左栏就是上下文） */}
                    {flat && pid != null && (
                      <span className="shrink-0 font-mono text-10 text-neutral-600">
                        {projectName.get(pid) ?? `#${pid}`}
                      </span>
                    )}
                    <span className="shrink-0 text-10 text-neutral-500">{t(STATUS_KEY[status])}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* 底条：条数（多选时并排勾选数）+ 按键说明 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-edge/[0.06] px-3 py-1.5 text-10 text-neutral-600">
          <span>
            {t('tasks.sessionPickerCount', { n: rightRows.length })}
            {pickedProjects.length > 0 && (
              <span className="ml-1.5 font-medium text-blue-300">
                {t('tasks.sessionPickerPicked', { n: pickedProjects.length })}
              </span>
            )}
            {picked.length > 0 && (
              <span className="ml-1.5 font-medium text-violet-300">
                {t('tasks.sessionPickerPicked', { n: picked.length })}
              </span>
            )}
          </span>
          <span className="ml-auto hidden items-center gap-1 lg:flex">
            {t('tasks.sessionPickerKeys')
              .split(' · ')
              .map((chunk) => (
                <kbd
                  key={chunk}
                  className="rounded border border-edge/[0.14] bg-neutral-950 px-1.5 py-0.5 font-sans text-10 font-normal text-neutral-400"
                >
                  {chunk}
                </kbd>
              ))}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
