import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder, Search, X } from 'lucide-react';
import type { ProjectRow, SessionRow } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useBackPop } from '@/lib/back-pop';
import { sessionLabel } from '@/lib/hook-payload';
import { SessionStatusIcon } from './SessionStatusIcon';
import { STATUS_KEY, type SessionStatus } from './session-status';

/**
 * 会话穿梭选择器（`#` 触发，层级同文件选择器）：左栏 = 项目、右栏 = 该项目下的
 * 会话（带终端状态图标与文案——与会话列表同一份状态机，`statuses` 由调用方从
 * 全局状态总线取）。键盘是主路径：**←→ 换层**（左＝回项目栏，右＝进会话栏）、
 * **↑↓ 栏内移动**、**Enter 落定**（项目行＝下钻，会话行＝选定）、Esc 先清搜索
 * 再关；可打印字符直接进搜索框——监听挂 document 捕获阶段，焦点落在哪儿都还能
 * 用键盘（FilePicker 同款）。搜索时跨全部项目平铺（每行带所属项目），清空即回
 * 层级模式。
 */

export function SessionShuttlePicker({
  sessions,
  projects,
  statuses,
  currentProjectId,
  onPick,
  onClose,
}: {
  /** 候选会话（调用方已排除当前会话）。 */
  sessions: SessionRow[];
  projects: ProjectRow[];
  /** sessionId → 终端状态（全局状态总线的推导结果；缺 = 按「打开」处理）。 */
  statuses: ReadonlyMap<string, SessionStatus>;
  /** 默认选中的项目（当前会话所属）：打开即落在它的会话列表上。 */
  currentProjectId: number | null;
  /** 落定一个目标：调用方插胶囊并关弹窗。 */
  onPick: (sessionId: string, name: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  /** 焦点在哪一栏（层级模式才有意义；搜索态恒在右栏的结果列表上）。 */
  const [col, setCol] = useState<'projects' | 'sessions'>('sessions');
  const [projIdx, setProjIdx] = useState(0);
  const [sessIdx, setSessIdx] = useState(0);

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

  /** 项目桶：projectId → 该项目的会话（最近活跃在前）。无名项目垫底成「未归属」。 */
  const groups = useMemo(() => {
    const byProject = new Map<number | null, SessionRow[]>();
    for (const s of sessions) {
      const key = s.projectId ?? null;
      const list = byProject.get(key) ?? [];
      list.push(s);
      byProject.set(key, list);
    }
    for (const list of byProject.values()) {
      list.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
    }
    const keys = [...byProject.keys()].sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return (projectName.get(a) ?? `#${a}`).localeCompare(projectName.get(b) ?? `#${b}`);
    });
    return keys.map((id) => ({
      projectId: id,
      name: id === null ? t('tasks.sessionPickerNoProject') : (projectName.get(id) ?? `#${id}`),
      rows: byProject.get(id)!,
    }));
  }, [sessions, projectName, t]);

  // 打开那拍落在当前会话所属的项目上（groups 首算即定，之后不随数据刷新漂）
  const initialProj = useRef(Math.max(0, groups.findIndex((g) => g.projectId === currentProjectId)));
  useEffect(() => {
    setProjIdx(initialProj.current);
  }, []);

  /** 搜索态：非空 = 跨全部项目平铺（层级两栏让位给单一结果列表）。 */
  const flat = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return sessions.filter((s) => {
      const label = sessionLabel(s.title, s.sessionId).toLowerCase();
      return label.includes(q) || s.sessionId.toLowerCase().includes(q);
    });
  }, [sessions, query]);

  /** 右栏此刻的行集：搜索态 = 平铺结果，层级态 = 焦点项目的会话。 */
  const rightRows = flat ?? groups[projIdx]?.rows ?? [];

  // 换项目 / 换搜索词：右栏高亮收回首条；行集缩短时高亮收回界内
  useEffect(() => {
    setSessIdx(0);
  }, [query, projIdx]);
  useEffect(() => {
    setSessIdx((i) => Math.min(i, Math.max(0, rightRows.length - 1)));
    // rightRows 每次渲染都是新数组，只认长度
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightRows.length]);

  // 高亮项滚进视野：↑↓ 连滑会走出可视区（两栏各自滚各自的）
  useEffect(() => {
    projListRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [projIdx, groups]);
  useEffect(() => {
    sessListRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sessIdx, rightRows]);

  /** ESC：搜索框有字先清字（一次退一层），没字才关弹窗。 */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (query !== '') setQuery('');
      else closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // query 进闭包：清字判据要跟上输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // 移动端返回键/侧滑 = 关闭弹窗
  useBackPop(true, () => {
    onClose();
    return true;
  });

  /** 方向键/回车的导航（document 捕获阶段，FilePicker 同款）。 */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      kbdNav.current = true;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      if (col === 'projects' && !flat) {
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
      if (col === 'sessions') setCol('projects');
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (!flat && col === 'projects') setCol('sessions');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // 项目行的 Enter = 下钻（与 → 同义）；会话行的 Enter 才是落定
      if (!flat && col === 'projects') {
        setCol('sessions');
        return;
      }
      const hit = rightRows[sessIdx];
      if (hit) onPick(hit.sessionId, sessionLabel(hit.title, hit.sessionId));
      return;
    }
    // 可打印字符直接进搜索框：打开选择器直接敲就是了
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
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

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  /** 行高亮：焦点栏实底、非焦点栏淡底——←→ 在哪边一眼可辨。 */
  const rowClass = (focused: boolean): string =>
    focused ? 'bg-violet-500/15 text-neutral-100' : 'bg-violet-500/[0.07] text-neutral-200';

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      {/* h-[70%] 不用 70dvh：根 zoom 下视口单位被二次放大（见 index.css #root 注） */}
      <div
        className="flex h-[70%] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-edge/[0.08] bg-neutral-900 shadow-mac"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头：标题 + 搜索 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-edge/[0.06] px-3 py-2">
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-200">
            {t('tasks.sessionPickerTitle')}
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
          <button
            type="button"
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:text-neutral-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 体：项目 | 会话（层级）；搜索态右栏独占（平铺结果，每行带所属项目）。 */}
        <div className="flex min-h-0 flex-1">
          {!flat && (
            <ul
              ref={projListRef}
              role="listbox"
              aria-label={t('orch.filterProject')}
              onMouseMove={() => {
                kbdNav.current = false;
              }}
              className="w-44 shrink-0 overflow-y-auto overscroll-contain border-r border-edge/[0.06] py-1"
            >
              {groups.map((g, i) => (
                <li key={g.projectId ?? 'none'}>
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
                    }}
                    onDoubleClick={() => {
                      setProjIdx(i);
                      setCol('sessions');
                    }}
                    className={cn(
                      'flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-xs transition-colors',
                      i === projIdx ? rowClass(col === 'projects') : 'text-neutral-300 hover:bg-edge/[0.04]',
                    )}
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0 text-blue-300/80" />
                    <span className="min-w-0 flex-1 truncate">{g.name}</span>
                    <span className="shrink-0 text-10 tabular-nums text-neutral-600">{g.rows.length}</span>
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
            className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain py-1"
          >
            {rightRows.length === 0 && (
              <li className="px-3 py-6 text-11 text-neutral-500">{t('orch.pickerEmpty')}</li>
            )}
            {rightRows.map((s, i) => {
              const status = statuses.get(s.sessionId) ?? 'open';
              const pid = s.projectId ?? null;
              return (
                <li key={s.sessionId}>
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
                    }}
                    onDoubleClick={() => onPick(s.sessionId, sessionLabel(s.title, s.sessionId))}
                    className={cn(
                      'flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs transition-colors',
                      i === sessIdx ? rowClass(col === 'sessions' || !!flat) : 'text-neutral-300 hover:bg-edge/[0.04]',
                    )}
                  >
                    <SessionStatusIcon status={status} harness={s.harness} />
                    <span className="min-w-0 flex-1 truncate">{sessionLabel(s.title, s.sessionId)}</span>
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

        {/* 底条：条数 + 按键说明 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-edge/[0.06] px-3 py-1.5 text-10 text-neutral-600">
          <span>{t('tasks.sessionPickerCount', { n: rightRows.length })}</span>
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
