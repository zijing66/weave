import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Input } from '../ui/input';
import { Check, ChevronLeft, Folder, Globe, Search, X } from 'lucide-react';
import type { ProjectRow, SessionRow } from '@/lib/api';
import type { FederatedPeerBucket } from './federation-buckets';
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
 * 项目引用（仅 superagent 会话给入口）：项目行的 checkbox = 把**整个项目**插成
 * 青色标注胶囊（`#p<id>「名」`，纯上下文标注——模型自己读项目文件）；Enter 仍是
 * 下钻进会话。其他项目的会话只选会话，项目行不摆 checkbox。
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

/**
 * 落定引用名 = 宿主当前生效名（`effectiveTitle`），不是行上展示的 title——
 * 改名待生效时 title 已是新名，但宿主 SendMessage 按名字寻址、还认旧名；
 * 行展示仍用 title（用户看到的是自己改的名）。
 */
function refNameOf(s: SessionRow): string {
  return sessionLabel(s.effectiveTitle ?? s.title, s.sessionId);
}

export function SessionShuttlePicker({
  sessions,
  projects,
  statuses,
  currentProjectId,
  federatedPeers,
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
  /** 联邦对端账（peer 行 + 各自会话账；缺省/空 = 不出联邦分组）。 */
  federatedPeers?: ReadonlyArray<FederatedPeerBucket>;
  /** 落定目标：调用方插胶囊并关弹窗（多选时按 Enter 整批落定，顺序 = 选择序）。 */
  onPick: (sessionId: string, name: string) => void;
  onPickBatch?: (picked: ReadonlyArray<{ sessionId: string; name: string }>) => void;
  /** 引用整个项目（青色标注胶囊；缺席 = 不提供项目引用入口，含多选）。 */
  onPickProject?: (projectId: number, name: string) => void;
  onPickProjectsBatch?: (picked: ReadonlyArray<{ projectId: number; name: string }>) => void;
  /** 标题换 superagent 版（「引用项目/会话」）：项目引用的消费者是上帝/协调链。
   *  同时是**项目 checkbox 的总闸**——只有 superagent 会话能勾项目（其他项目的
   *  会话只选会话），看的是「发起引用的会话属谁」，不是项目行本身。 */
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
  /** Space 勾选的会话（选择序保序）：多选后 Enter = 整批落定；单选路径不经过它。
   *  project 随行记（胶囊 tooltip 揭示所属项目——勾的行往往已滚出视野）。 */
  const [picked, setPicked] = useState<Array<{ sessionId: string; name: string; project?: string }>>([]);
  /** Space 勾选的项目（焦点在项目栏时同款多选；与会话账互斥——勾的项目不进会话账）。 */
  const [pickedProjects, setPickedProjects] = useState<Array<{ projectId: number; name: string }>>([]);
  /** 窄屏两屏下钻：项目列表 ⇄ 会话列表（同 FilePicker 的 list/preview）。 */
  const [screen, setScreen] = useState<'projects' | 'sessions'>('sessions');
  /** 焦点所在联邦 peer（左栏 peer 行选中态）；null = 焦点在普通项目分组。 */
  const [peerIdx, setPeerIdx] = useState<number | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 打开那拍焦点钉在弹窗容器（tabIndex=-1，非输入控件不弹软键盘）——移动端
  // 打开选择器后焦点从宿主输入框漂进弹层时会残留软键盘，容器接住即收
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);
  const sessListRef = useRef<HTMLUListElement>(null);
  const projListRef = useRef<HTMLUListElement>(null);
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

  /** 右栏此刻的行集：搜索态 = 平铺结果；焦点在 peer = 对端会话；否则焦点项目的会话。 */
  const rightRows: Array<SessionRow | FederatedPeerBucket['sessions'][number]> =
    flat ?? (peerIdx != null ? (federatedPeers?.[peerIdx]?.sessions ?? []) : (groups[projIdx]?.rows ?? []));
  /** 右栏行是不是联邦行（两形行的取值字段同名：sessionId/title；状态图标对端恒灰点）。 */
  const rightIsPeer = peerIdx != null && !flat;

  // 换项目 / 换 peer / 换搜索词：右栏高亮收回首条；行集缩短时高亮收回界内。
  // 勾选账不清：多选的意义就是跨项目挑多条（勾 A 项目的会话 → 切到 B 项目再勾
  // → Enter 整批落定），换焦点就清账正好把这个流程打断（2026-11-18 用户报障
  // 「勾选项切换聚焦后丢失」）；勾账按 sessionId/projectId 记，行看不见也只是
  // 账在、随时可取消，不构成幽灵选择。
  useEffect(() => {
    setSessIdx(0);
  }, [query, projIdx, peerIdx]);
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
        // 联邦 peer 行在项目列表尾段：焦点越过普通项目组后进入 peer 段
        const peersLen = federatedPeers?.length ?? 0;
        if (peersLen > 0 && peerIdx == null && projIdx >= groups.length - 1 && step > 0) {
          setPeerIdx(0);
          return;
        }
        if (peerIdx != null) {
          const next = peerIdx + step;
          if (next < 0) {
            setPeerIdx(null);
            return;
          }
          setPeerIdx(Math.min(peersLen - 1, next));
          return;
        }
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
      if (!hit) return;
      // 联邦行落定 = peer 目标形（投递层一等公民）；普通行 = 本机 sessionId
      if (rightIsPeer && peerIdx != null) {
        onPick(`peer:${federatedPeers![peerIdx]!.peerName}/${hit.sessionId}`, refNameOf(hit as SessionRow));
      } else {
        onPick(hit.sessionId, refNameOf(hit as SessionRow));
      }
      return;
    }
    // Space = 焦点栏当前行打勾/取消（项目/会话同款多选）。搜索框里也勾（检索中
    // 空格勾选是主路径，检索词要空格就粘贴）；其他输入控件/按钮上的空格归它们自己。
    if (e.key === ' ') {
      if (e.target instanceof HTMLElement && e.target.closest('button')) return;
      if (inAnyInput(e) && e.target !== searchRef.current) return;
      e.preventDefault();
      if (focusCol === 'projects') {
        if (!onPickProject || !superagentTitle) return;
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
      const name = refNameOf(hit as SessionRow);
      const project = rightIsPeer ? null : ((hit as SessionRow).projectId != null ? (projectName.get((hit as SessionRow).projectId!) ?? `#${(hit as SessionRow).projectId}`) : undefined);
      setPicked((prev) =>
        prev.some((p) => p.sessionId === hit.sessionId)
          ? prev.filter((p) => p.sessionId !== hit.sessionId)
          : [...prev, { sessionId: hit.sessionId, name, project: project ?? undefined }],
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
          accent === 'project' ? 'bg-cyan-500/20' : 'bg-violet-500/20',
        )
      : accent === 'project'
        ? 'bg-cyan-500/[0.05] text-neutral-300'
        : 'bg-violet-500/[0.07] text-neutral-200';
  /** 焦点行的左缘竖条（绝对定位覆盖整行高）：颜色即焦点色。 */
  const focusBar = (accent: 'project' | 'session'): string =>
    accent === 'project' ? 'bg-cyan-400' : 'bg-violet-400';

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 max-lg:p-0"
      onClick={onClose}
    >
      {/* h-[70%] 不用 70dvh：根 zoom 下视口单位被二次放大（见 index.css #root 注）。
          tabIndex=-1：打开那拍把焦点钉在容器上（不是任何输入控件）——移动端
          不会因此弹软键盘；打字仍由 document 捕获监听转进搜索框（见 onKeyDown）。 */}
      <div
        tabIndex={-1}
        ref={panelRef}
        className="flex h-[70%] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-edge/[0.08] bg-neutral-900 shadow-mac outline-none max-lg:h-full max-lg:max-w-none max-lg:rounded-none"
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
            <Input
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
                      'flex w-full items-center gap-1.5 py-1 pl-2.5 pr-2.5 text-left text-xs transition-colors',
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
                    <Folder className="h-3.5 w-3.5 shrink-0 text-cyan-300/80" />
                    <span className="min-w-0 flex-1 truncate">{g.name}</span>
                    <span className="shrink-0 text-10 tabular-nums text-neutral-600">{g.rows.length}</span>
                    {/* checkbox 勾选（2026-11-15 用户裁决：移动端点不到 Space，勾选
                        手势统一成 checkbox——点行其余部分行为不变（下钻），多选键序
                        （Space/Enter 整批落定）照旧。2026-11-16 用户裁决：只有
                        superagent 会话能勾项目（其他项目的会话只选会话）——总闸 =
                        superagentTitle（发起引用的会话属谁），不按项目行分流。 */}
                    {superagentTitle && onPickProject && g.projectId != null && (
                      <span
                        role="checkbox"
                        aria-checked={projPicked}
                        aria-label={t('tasks.sessionPickerCheck')}
                        onClick={(e) => {
                          e.stopPropagation();
                          setProjIdx(i);
                          setCol('projects');
                          const name = g.name;
                          setPickedProjects((prev) =>
                            prev.some((p) => p.projectId === g.projectId)
                              ? prev.filter((p) => p.projectId !== g.projectId)
                              : [...prev, { projectId: g.projectId!, name }],
                          );
                        }}
                        className={cn(
                          'shrink-0 rounded-[3px] border p-px transition-colors',
                          projPicked
                            ? 'border-cyan-400 bg-cyan-500/80 text-white'
                            : 'border-neutral-600 text-transparent hover:border-cyan-400/70',
                        )}
                      >
                        <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                      </span>
                    )}
                  </button>
                </li>
                );
              })}
              {/* 联邦 peer 段：分隔行 + 每 peer 一行（下钻看对端会话；离线灰置）。 */}
              {(federatedPeers?.length ?? 0) > 0 && (
                <li aria-hidden className="px-2.5 pb-0.5 pt-2 text-10 uppercase tracking-wide text-neutral-600">
                  {t('tasks.sessionPickerFederated')}
                </li>
              )}
              {(federatedPeers ?? []).map((p, pi) => (
                <li key={p.peerId} className="relative">
                  <button
                    type="button"
                    role="option"
                    aria-selected={peerIdx === pi}
                    onMouseEnter={() => {
                      if (!kbdNav.current) {
                        setPeerIdx(pi);
                        setCol('projects');
                      }
                    }}
                    onClick={() => {
                      setPeerIdx(pi);
                      setCol('projects');
                      if (!isDesktop) setScreen('sessions');
                    }}
                    className={cn(
                      'flex w-full items-center gap-1.5 py-1 pl-2.5 pr-2.5 text-left text-xs transition-colors',
                      peerIdx === pi
                        ? rowClass(focusCol === 'projects', 'project')
                        : 'text-neutral-300 hover:bg-edge/[0.04]',
                      !p.online && 'opacity-60',
                    )}
                  >
                    {peerIdx === pi && focusCol === 'projects' && (
                      <span
                        aria-hidden
                        className={cn('absolute inset-y-0 left-0 w-[3px] rounded-full', focusBar('project'))}
                      />
                    )}
                    <Globe className={cn('h-3.5 w-3.5 shrink-0', p.online ? 'text-cyan-300/80' : 'text-neutral-600')} />
                    <span className="min-w-0 flex-1 truncate">{p.peerName}</span>
                    <span className="shrink-0 text-10 tabular-nums text-neutral-600">{p.sessions.length}</span>
                  </button>
                </li>
              ))}
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
              const status = rightIsPeer ? 'open' : (statuses.get(s.sessionId) ?? 'open');
              const pid = (s as SessionRow).projectId ?? null;
              const isPicked = picked.some((p) => p.sessionId === s.sessionId);
              const pickId = rightIsPeer && peerIdx != null
                ? `peer:${federatedPeers![peerIdx]!.peerName}/${s.sessionId}`
                : s.sessionId;
              const pick = (): void => onPick(pickId, refNameOf(s as SessionRow));
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
                      if (!isDesktop) pick();
                    }}
                    onDoubleClick={pick}
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
                    {rightIsPeer ? (
                      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-neutral-600" />
                    ) : (
                      <SessionStatusIcon status={status} harness={(s.harness as 'claude' | 'codex' | null) ?? null} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{sessionLabel(s.title, s.sessionId)}</span>
                    {/* 搜索态跨项目平铺：所属项目只有它能区分（层级模式左栏就是上下文） */}
                    {flat && pid != null && (
                      <span className="shrink-0 font-mono text-10 text-neutral-600">
                        {projectName.get(pid) ?? `#${pid}`}
                      </span>
                    )}
                    <span className="shrink-0 text-10 text-neutral-500">
                      {rightIsPeer ? t('tasks.sessionPickerRemote') : t(STATUS_KEY[status])}
                    </span>
                    {/* checkbox 勾选（2026-11-15 用户裁决：与项目行同款——移动端点
                        不到 Space，点 checkbox 即勾/取消；点行其余部分行为不变
                        （触屏单击落定、桌面双击落定），Space/Enter 批量落定照旧。
                        checkbox 即唯一勾选指示（旧 Check 标记退役——两个勾重复）。
                        2026-11-16 用户裁决：状态文案在前、checkbox 恒贴行尾——整齐。 */}
                    <span
                      role="checkbox"
                      aria-checked={isPicked}
                      aria-label={t('tasks.sessionPickerCheck')}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSessIdx(i);
                        setCol('sessions');
                        const name = refNameOf(s as SessionRow);
                        const projectId = (s as SessionRow).projectId;
                        const project = projectId != null ? (projectName.get(projectId) ?? `#${projectId}`) : undefined;
                        setPicked((prev) =>
                          prev.some((p) => p.sessionId === s.sessionId)
                            ? prev.filter((p) => p.sessionId !== s.sessionId)
                            : [...prev, { sessionId: s.sessionId, name, project }],
                        );
                      }}
                      className={cn(
                        'shrink-0 rounded-[3px] border p-px transition-colors',
                        isPicked
                          ? 'border-violet-400 bg-violet-500/80 text-white'
                          : 'border-neutral-600 text-transparent hover:border-violet-400/70',
                      )}
                    >
                      <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* 已选条（2026-11-18 用户裁决，与文件选择器同款）：所有已选项逐枚成胶囊
            （项目蓝 / 会话紫同行色），胶囊悬停浮现移除 X——跨项目挑的多条在这里
            全程可见可撤，不依赖回到原屏找 checkbox。flex+wrap 不上横向滚动。 */}
        {(pickedProjects.length > 0 || picked.length > 0) && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-edge/[0.06] px-3 py-1.5">
            {pickedProjects.map((p) => (
              <span
                key={`p${p.projectId}`}
                className="group flex items-center gap-1 rounded-full border border-cyan-400/40 bg-cyan-500/15 py-0.5 pl-2 pr-1 text-10 text-cyan-200"
              >
                <span className="max-w-40 truncate">{p.name}</span>
                <button
                  type="button"
                  aria-label={t('tasks.sessionPickerRemove')}
                  onClick={() => setPickedProjects((prev) => prev.filter((q) => q.projectId !== p.projectId))}
                  className="rounded-full text-cyan-300/60 opacity-0 transition-opacity group-hover:opacity-100 hover:text-cyan-100"
                >
                  <X className="h-2.5 w-2.5" strokeWidth={3} />
                </button>
              </span>
            ))}
            {picked.map((p) => (
              <span
                key={p.sessionId}
                className="group flex items-center gap-1 rounded-full border border-violet-400/40 bg-violet-500/15 py-0.5 pl-2 pr-1 text-10 text-violet-200"
              >
                <span className="max-w-40 truncate" title={p.project ? `${p.project} · ${p.name}` : p.name}>{p.name}</span>
                <button
                  type="button"
                  aria-label={t('tasks.sessionPickerRemove')}
                  onClick={() => setPicked((prev) => prev.filter((q) => q.sessionId !== p.sessionId))}
                  className="rounded-full text-violet-300/60 opacity-0 transition-opacity group-hover:opacity-100 hover:text-violet-100"
                >
                  <X className="h-2.5 w-2.5" strokeWidth={3} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 底条：条数（多选时并排勾选数）+ 确认钮 + 按键说明。确认钮常显（桌面也有）：
            checkbox 勾选后不依赖 Enter 键序——移动端没有键盘，「确认选择」必须是
            一枚看得见的钮（2026-11-15 用户反馈：选完项目无法确定）。 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-edge/[0.06] px-3 py-1.5 text-10 text-neutral-600">
          <span>
            {t('tasks.sessionPickerCount', { n: rightRows.length })}
            {pickedProjects.length > 0 && (
              <span className="ml-1.5 font-medium text-cyan-300">
                {t('tasks.sessionPickerPicked', { n: pickedProjects.length })}
              </span>
            )}
            {picked.length > 0 && (
              <span className="ml-1.5 font-medium text-violet-300">
                {t('tasks.sessionPickerPicked', { n: picked.length })}
              </span>
            )}
          </span>
          {(pickedProjects.length > 0 || picked.length > 0) && (
            <button
              type="button"
              onClick={() => {
                if (pickedProjects.length > 0) onPickProjectsBatch?.(pickedProjects);
                else if (picked.length > 0) onPickBatch?.(picked);
              }}
              className="ml-auto rounded bg-violet-600/90 px-2.5 py-1 text-11 font-medium text-white transition-colors hover:bg-violet-500"
            >
              {t('tasks.sessionPickerConfirm', { n: pickedProjects.length + picked.length })}
            </button>
          )}
          <span className={cn('ml-auto hidden items-center gap-1 lg:flex', pickedProjects.length + picked.length > 0 && 'ml-2')}>
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
