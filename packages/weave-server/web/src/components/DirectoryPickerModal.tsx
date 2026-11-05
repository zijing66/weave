import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type BrowseChild, type BrowseRoot } from '@/lib/api';
import { cn } from '@/lib/utils';
import { cssPx } from '@/lib/font-scale';
import { useBackPop } from '@/lib/back-pop';
import { useT } from '@/i18n/I18nProvider';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import type { MessageKey } from '@/i18n/dict';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Home,
  Library,
  ListX,
  Loader2,
  Monitor,
  X,
} from 'lucide-react';

interface DirectoryPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the checked absolute paths when the user confirms. */
  onConfirm: (paths: string[]) => void;
  /** Paths already registered as libraries — shown greyed out, re-check skipped. */
  existingPaths?: string[];
}

const ROOT_LABELS: Record<BrowseRoot['kind'], { labelKey: MessageKey; icon: typeof Home }> = {
  home: { labelKey: 'picker.home', icon: Home },
  desktop: { labelKey: 'picker.desktop', icon: Monitor },
  downloads: { labelKey: 'picker.downloads', icon: Download },
  documents: { labelKey: 'picker.documents', icon: FileText },
  'library-parent': { labelKey: 'picker.libraryParent', icon: Library },
  drive: { labelKey: 'picker.drive', icon: HardDrive },
  root: { labelKey: 'picker.root', icon: HardDrive },
};

const ROOT_ORDER: BrowseRoot['kind'][] = [
  'home',
  'desktop',
  'downloads',
  'documents',
  'library-parent',
  'drive',
  'root',
];

/** 用户自加的快速访问项（树里右键添加）：纯前端偏好，localStorage 记忆。 */
const QUICK_ACCESS_KEY = 'weave:pickerQuickAccess';
/** 分栏视图列宽（拖动分隔条调整）：本会话内 sessionStorage 记忆。 */
const COL_WIDTH_KEY = 'weave:pickerColWidth';
const COL_WIDTH_MIN = 96;
const COL_WIDTH_MAX = 480;
const COL_WIDTH_DEFAULT = 208;
/** 分栏最多同时可见的列数（Finder 缺省 3–4 列）：超限时最左列滚出，不是无限横扩。 */
const COLS_MAX = 3;

function loadColWidth(): number {
  try {
    const n = Number(sessionStorage.getItem(COL_WIDTH_KEY));
    if (Number.isFinite(n) && n >= COL_WIDTH_MIN && n <= COL_WIDTH_MAX) return n;
  } catch {
    // 存不进去就用缺省宽度
  }
  return COL_WIDTH_DEFAULT;
}

/** 快访侧栏宽度：同上，sessionStorage 记忆。 */
const SIDEBAR_WIDTH_KEY = 'weave:pickerSidebarWidth';
const SIDEBAR_WIDTH_MIN = 96;
const SIDEBAR_WIDTH_MAX = 320;
const SIDEBAR_WIDTH_DEFAULT = 176;

function loadSidebarWidth(): number {
  try {
    const n = Number(sessionStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(n) && n >= SIDEBAR_WIDTH_MIN && n <= SIDEBAR_WIDTH_MAX) return n;
  } catch {
    // 存不进去就用缺省宽度
  }
  return SIDEBAR_WIDTH_DEFAULT;
}

function loadQuickAccess(): string[] {
  try {
    const raw = localStorage.getItem(QUICK_ACCESS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((p): p is string => typeof p === 'string' && !!p) : [];
  } catch {
    return [];
  }
}

/** 长按 = 移动端右键等价手势（§11 触屏右键等价手势）：按住 500ms 触发一次，
 *  触发后轻微震动反馈；移动超过阈值算滚动、取消。纯工厂（非 hook），行内即用。 */
function makeLongPress(onLongPress: (x: number, y: number) => void, enabled: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    start.current = null;
  }, []);

  return {
    onTouchStart: (e: React.TouchEvent): void => {
      if (!enabled) return;
      const t0 = e.touches[0];
      if (!t0) return;
      start.current = { x: t0.clientX, y: t0.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        if (start.current) {
          onLongPress(start.current.x, start.current.y);
          start.current = null;
          navigator.vibrate?.(10);
        }
      }, 500);
    },
    onTouchMove: (e: React.TouchEvent): void => {
      const t0 = e.touches[0];
      if (!start.current || !t0) return;
      if (Math.abs(t0.clientX - start.current.x) + Math.abs(t0.clientY - start.current.y) > 12) clear();
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
  };
}

/** 右键菜单锚点（视口坐标）。 */
interface QuickMenu {
  x: number;
  y: number;
  /** 待添加进快访的路径（添加菜单）；null = 快访自定义项的移除菜单。 */
  addPath?: string;
  removePath?: string;
}

/** 粘贴来的路径多为资源管理器「复制为路径」形（整体带引号、Windows 带尾分隔符）。 */
export function cleanPath(raw: string): string {
  const p = raw.trim().replace(/^"(.*)"$/s, '$1');
  if (/^[a-zA-Z]:[\\/]$/.test(p)) return p;
  return p.replace(/[\\/]+$/, '').trim();
}

/** A node in the lazily-loaded directory tree. Roots are synthesized entries
 * (label comes from `kind`); children are plain subdirectories. */
interface TreeNode {
  path: string;
  name: string;
  rootKind?: BrowseRoot['kind'];
}

/**
 * Cross-platform in-browser folder picker: quick-access roots on the left,
 * a lazy-loading checkbox tree on the right. Checking a node selects exactly
 * that folder (no cascade), mirroring a native multi-select dialog without
 * ever spawning one — slow network folders only delay their own expand.
 */
export function DirectoryPickerModal({
  open,
  onClose,
  onConfirm,
  existingPaths = [],
}: DirectoryPickerModalProps) {
  const [roots, setRoots] = useState<BrowseRoot[]>([]);
  const [childrenByPath, setChildrenByPath] = useState<Map<string, BrowseChild[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string[]>([]);
  /** 顶部完整路径行：树里勾选时显示该文件夹，也可直接粘贴一个路径加入选择。 */
  const [pathInput, setPathInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 用户自加的快访项（树右键添加、右键移除；内置根不可移除）。 */
  const [quickAccess, setQuickAccess] = useState<string[]>([]);
  const [quickMenu, setQuickMenu] = useState<QuickMenu | null>(null);
  /** 分栏视图（Finder column view）：colPaths[0] = 侧边栏选中的目录（null = 未选），
   *  其后每列是上一列中点开的子目录；列 i 展示 colPaths[i] 的子目录。 */
  const [colPaths, setColPaths] = useState<(string | null)[]>([null]);
  /** 分栏列宽（拖分隔条调）；最后一列弹性撑满剩余空间，不参与定宽。 */
  const [colWidth, setColWidth] = useState(COL_WIDTH_DEFAULT);
  /** 快访侧栏宽度（拖分隔条调）。 */
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH_DEFAULT);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    setQuickAccess(loadQuickAccess());
    setColPaths([null]);
    setColWidth(loadColWidth());
    setSidebarWidth(loadSidebarWidth());
  }, [open]);

  useEffect(() => {
    if (!open || roots.length > 0) return;
    api
      .listFsRoots()
      .then((r) => {
        const order = new Map(ROOT_ORDER.map((k, i) => [k, i]));
        setRoots([...r].sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99)));
      })
      .catch((e) => setError(String(e)));
  }, [open, roots.length]);

  const loadChildren = useCallback(async (dirPath: string) => {
    setLoadingPaths((s) => new Set(s).add(dirPath));
    setError(null);
    try {
      const children = await api.listFsChildren(dirPath);
      setChildrenByPath((m) => new Map(m).set(dirPath, children));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPaths((s) => {
        const next = new Set(s);
        next.delete(dirPath);
        return next;
      });
    }
  }, []);

  const toggleExpand = useCallback(
    (dirPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
          if (!childrenByPath.has(dirPath) && !loadingPaths.has(dirPath)) {
            void loadChildren(dirPath);
          }
        }
        return next;
      });
    },
    [childrenByPath, loadingPaths, loadChildren],
  );

  const toggleCheck = useCallback(
    (dirPath: string) => {
      const on = !selected.includes(dirPath);
      const next = on ? [...selected, dirPath] : selected.filter((p) => p !== dirPath);
      setSelected(next);
      setPathInput(next.length > 0 ? next[next.length - 1]! : '');
    },
    [selected],
  );

  /** 分栏导航：colIndex = -1 表示从侧边栏选位置（重置成第一列），否则点第 i
   *  列的目录 = 截断其后的列、在其右开下一列；列数过 COLS_MAX 时最左列滚出。 */
  const enterColumn = useCallback((dirPath: string, colIndex: number) => {
    setColPaths((prev) => {
      let next = prev.slice(0, colIndex + 1);
      next.push(dirPath);
      if (next.length > COLS_MAX) next = next.slice(next.length - COLS_MAX);
      return next;
    });
    if (!childrenByPath.has(dirPath) && !loadingPaths.has(dirPath)) {
      void loadChildren(dirPath);
    }
  }, [childrenByPath, loadingPaths, loadChildren]);

  const existing = useMemo(() => new Set(existingPaths), [existingPaths]);

  /** 顶行提交：粘贴的路径（资源管理器带引号形也认）加进选择，已添加的忽略。 */
  const commitPath = useCallback(() => {
    const p = cleanPath(pathInput);
    setPathInput(p);
    if (!p || selected.includes(p) || existing.has(p)) return;
    setSelected([...selected, p]);
  }, [pathInput, selected, existing]);

  const addQuickAccess = useCallback((dirPath: string) => {
    setQuickAccess((prev) => {
      if (prev.includes(dirPath)) return prev;
      const next = [...prev, dirPath];
      try {
        localStorage.setItem(QUICK_ACCESS_KEY, JSON.stringify(next));
      } catch {
        // 存不进去就只活这一局（隐私模式等），不弹错
      }
      return next;
    });
  }, []);

  const removeQuickAccess = useCallback((dirPath: string) => {
    setQuickAccess((prev) => {
      const next = prev.filter((p) => p !== dirPath);
      try {
        localStorage.setItem(QUICK_ACCESS_KEY, JSON.stringify(next));
      } catch {
        // 同上
      }
      return next;
    });
  }, []);

  /** 分栏键盘导航焦点：cursor = { 列，行 }（列 0 = 侧栏位置列表，≥1 = 分栏列；
   *  colPaths 在 ≥lg 时列 0 独立于侧栏焦点，这里统一按「列内容物数组」寻址）。 */
  const [kb, setKb] = useState<{ col: number; row: number } | null>(null);

  // 方向键导航（文件选择器同款）：↑↓ 列内移动焦点，→ 进目录，← 退回上级，
  // Enter 勾选/取消勾选焦点行。焦点行高亮，操作只落在分栏视图（≥lg）。
  const columnItemsOf = useCallback(
    (col: number): Array<{ path: string; name: string }> => {
      if (col === 0) {
        const labelOf = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
        return [
          ...roots.map((r) => ({ path: r.path, name: r.kind === 'drive' || r.kind === 'root' ? r.path : labelOf(r.path) })),
          ...quickAccess.map((p) => ({ path: p, name: labelOf(p) })),
        ];
      }
      const dir = colPaths[col];
      if (!dir) return [];
      return (childrenByPath.get(dir) ?? []).map((c) => ({ path: c.path, name: c.name }));
    },
    [roots, quickAccess, colPaths, childrenByPath],
  );

  const onPickerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (window.matchMedia('(min-width: 1024px)').matches === false) return;
      // 输入框里编辑文本/路径时不劫持方向键
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
      if (target?.closest('[data-quick-menu]')) return;
      const items = columnItemsOf(kb?.col ?? 0);
      if (items.length === 0 && e.key !== 'ArrowRight') return;
      const col = kb?.col ?? 0;
      const row = kb?.row ?? -1;
      const move = (r: number): void => setKb({ col, row: Math.max(0, Math.min(items.length - 1, r)) });
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          move(row + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          move(row - 1);
          break;
        case 'ArrowRight': {
          e.preventDefault();
          const item = items[Math.max(0, row)];
          if (item) enterColumn(item.path, col - 1), setKb({ col: col + 1, row: 0 });
          break;
        }
        case 'ArrowLeft':
          e.preventDefault();
          if (col > 0) setKb({ col: col - 1, row: 0 });
          break;
        case 'Enter': {
          e.preventDefault();
          const item = items[row];
          if (item) toggleCheck(item.path);
          break;
        }
      }
    },
    [kb, columnItemsOf, enterColumn, toggleCheck],
  );

  // 分栏拖宽：按住分隔条拖动调列宽，松手落 sessionStorage（触屏不接管）。
  const startColResize = useCallback((e: React.PointerEvent) => {
    if (window.matchMedia('(pointer: coarse)').matches) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = colWidth;
    const move = (ev: PointerEvent): void => {
      const w = Math.max(COL_WIDTH_MIN, Math.min(COL_WIDTH_MAX, startW + ev.clientX - startX));
      setColWidth(w);
    };
    const up = (ev: PointerEvent): void => {
      const w = Math.max(COL_WIDTH_MIN, Math.min(COL_WIDTH_MAX, startW + ev.clientX - startX));
      setColWidth(w);
      try {
        sessionStorage.setItem(COL_WIDTH_KEY, String(w));
      } catch {
        // 存不进去就只活这一局
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [colWidth]);

  // 快访侧栏拖宽：同上。
  const startSidebarResize = useCallback((e: React.PointerEvent) => {
    if (window.matchMedia('(pointer: coarse)').matches) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const move = (ev: PointerEvent): void => {
      const w = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, startW + ev.clientX - startX));
      setSidebarWidth(w);
    };
    const up = (ev: PointerEvent): void => {
      const w = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, startW + ev.clientX - startX));
      setSidebarWidth(w);
      try {
        sessionStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
      } catch {
        // 同上
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [sidebarWidth]);

  // 右键菜单：点外面 / 再一次右键 / 滚动 / 缩放都收。
  useEffect(() => {
    if (!quickMenu) return;
    const dismiss = (e: Event): void => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-quick-menu]')) return;
      setQuickMenu(null);
    };
    const close = (): void => setQuickMenu(null);
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('contextmenu', dismiss, true);
    window.addEventListener('wheel', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('contextmenu', dismiss, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('resize', close);
    };
  }, [quickMenu]);

  /** Finder column view：第 i 列展示 colPaths[i] 目录的子目录（colPaths[0] 为
   *  null 时该列是提示列）。行上：左半点击 = 进下级列，右端勾选框 = 选中。 */
  function renderColumn(colIndex: number, colPath: string | null): ReactNode {
    if (colPath === null) {
      return (
        <div className="h-full flex items-center justify-center text-neutral-600 text-11 px-3 text-center">
          {t('picker.columnHint')}
        </div>
      );
    }
    const children = childrenByPath.get(colPath);
    const isLoading = loadingPaths.has(colPath);
    return (
      <div className="w-full min-w-full p-1.5 space-y-0.5">
        {(isLoading || !children) && (
          <div className="flex items-center gap-1.5 text-neutral-500 py-1 px-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="text-11">{t('common.loading')}</span>
          </div>
        )}
        {children?.length === 0 && (
          <div className="text-neutral-600 py-1 px-2 text-11">{t('common.empty')}</div>
        )}
        {children?.map((c, ci) => {
          const isChecked = selected.includes(c.path);
          const isExisting = existing.has(c.path);
          const selectable = !isExisting;
          const active = colPaths[colIndex + 1] === c.path;
          const focused = kb?.col === colIndex + 1 && kb.row === ci;
          return (
            <div
              key={c.path}
              className={cn(
                'group flex items-center gap-1 pr-1.5 rounded hover:bg-edge/[0.04]',
                active && 'bg-edge/[0.08]',
                focused && 'ring-1 ring-blue-400',
              )}
              onContextMenu={(e) => {
                if (window.matchMedia('(pointer: coarse)').matches) return;
                e.preventDefault();
                e.stopPropagation();
                setQuickMenu({ x: e.clientX, y: e.clientY, addPath: c.path });
              }}
              {...longPressProps((_x, _y) => {
                const el = document.querySelector(`[data-node-path="${CSS.escape(c.path)}"]`);
                const r = el?.getBoundingClientRect();
                setQuickMenu({ x: r ? r.left + 24 : 48, y: r ? r.bottom + 4 : 120, addPath: c.path });
              })}
              data-node-path={c.path}
            >
              <button
                onClick={() => enterColumn(c.path, colIndex)}
                className={cn(
                  'flex-1 min-w-0 flex items-center gap-1.5 text-left py-1 truncate',
                  selectable ? 'text-neutral-200' : 'text-neutral-500',
                )}
                title={c.path}
              >
                <ChevronRight className="h-3 w-3 shrink-0 text-neutral-500" />
                <span className="text-xs truncate">{c.name}</span>
              </button>
              <Tooltip
                label={isExisting ? t('picker.alreadyAdded') : isChecked ? t('picker.unselect') : t('picker.selectFolder')}
              >
                <button
                  onClick={() => toggleCheck(c.path)}
                  disabled={!selectable}
                  className={cn(
                    'shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors',
                    isChecked
                      ? 'bg-blue-500 border-blue-500 text-white'
                      : 'border-neutral-600 text-transparent group-hover:border-neutral-400',
                    !selectable && 'opacity-30 cursor-not-allowed',
                  )}
                >
                  <Check className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>
    );
  }

  // 移动端长按树行/分栏行 = 右键（加入快速访问）。
  const longPressProps = useCallback(
    (fire: (x: number, y: number) => void) =>
      makeLongPress(fire, window.matchMedia('(pointer: coarse)').matches),
    [],
  );

  function renderNodes(nodes: TreeNode[], depth: number): ReactNode[] {
    const rows: ReactNode[] = [];
    for (const node of nodes) {
      const isExpanded = expanded.has(node.path);
      const isChecked = selected.includes(node.path);
      const isExisting = existing.has(node.path);
      // 资源位置 = 市场副本所在目录（已登记资源的父目录）：它是导航锚点，
      // 把它自己当来源再导入一遍等于把已有副本再拷一份，清单里同一资源出现两次。
      const isAnchor = node.rootKind === 'library-parent';
      const selectable = !isExisting && !isAnchor;
      const meta = node.rootKind ? ROOT_LABELS[node.rootKind] : null;
      const children = childrenByPath.get(node.path);
      const isLoading = loadingPaths.has(node.path);
      rows.push(
        <div
          key={node.path}
          className="group flex items-center gap-1 pr-2 rounded hover:bg-edge/[0.04] touch-manipulation"
          style={{ paddingLeft: depth * 14 + 6 }}
          onContextMenu={(e) => {
            // 桌面右键开「加入快速访问」；触屏走长按（等价手势，见 §11）
            if (window.matchMedia('(pointer: coarse)').matches) return;
            e.preventDefault();
            e.stopPropagation();
            setQuickMenu({ x: e.clientX, y: e.clientY, addPath: node.path });
          }}
          {...longPressProps(() => {
            const el = document.querySelector(`[data-node-path="${CSS.escape(node.path)}"]`);
            const r = el?.getBoundingClientRect();
            setQuickMenu({ x: r ? r.left + 24 : 48, y: r ? r.bottom + 4 : 120, addPath: node.path });
          })}
          data-node-path={node.path}
        >
          <Tooltip label={isExpanded ? t('common.collapse') : t('common.expand')}>
            <button
              onClick={() => toggleExpand(node.path)}
              className="shrink-0 p-0.5 max-lg:p-2 text-neutral-500 hover:text-neutral-200"
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
          <button
            onClick={() => toggleExpand(node.path)}
            className={cn(
              'flex-1 min-w-0 flex items-center gap-1.5 text-left py-1 max-lg:py-2.5 truncate',
              selectable ? 'text-neutral-200' : 'text-neutral-500',
            )}
            title={node.path}
          >
            {meta ? (
              <meta.icon className="h-3.5 w-3.5 shrink-0 text-blue-400" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
            )}
            {/* Drives share one rootKind label ("磁盘"), so the row must show
                the path itself (C:\, D:\ …) or multiple disks look identical. */}
            <span className="truncate text-xs">
              {node.rootKind === 'drive' ? node.name : (meta ? t(meta.labelKey) : node.name)}
            </span>
            {isExisting && (
              <span className="shrink-0 text-10 text-neutral-600">{t('picker.alreadyAdded')}</span>
            )}
          </button>
          <Tooltip
            label={
              isAnchor
                ? t('picker.anchorTip')
                : isChecked
                  ? t('picker.unselect')
                  : t('picker.selectFolder')
            }
          >
            <button
              onClick={() => toggleCheck(node.path)}
              disabled={!selectable}
              className={cn(
                'shrink-0 w-4 h-4 max-lg:w-6 max-lg:h-6 rounded border flex items-center justify-center transition-colors',
                isChecked
                  ? 'bg-blue-500 border-blue-500 text-white'
                  : 'border-neutral-600 text-transparent group-hover:border-neutral-400 max-lg:border-neutral-500',
                !selectable && 'opacity-30 cursor-not-allowed',
              )}
            >
              <Check className="h-3 w-3 max-lg:h-4 max-lg:w-4" />
            </button>
          </Tooltip>
        </div>,
      );
      if (isExpanded) {
        if (isLoading || !children) {
          rows.push(
            <div
              key={`${node.path}__loading`}
              className="flex items-center gap-1.5 text-neutral-500 py-1"
              style={{ paddingLeft: (depth + 1) * 14 + 24 }}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="text-11">{t('common.loading')}</span>
            </div>,
          );
        } else if (children.length > 0) {
          rows.push(...renderNodes(children, depth + 1));
        } else {
          rows.push(
            <div
              key={`${node.path}__empty`}
              className="text-neutral-600 py-1"
              style={{ paddingLeft: (depth + 1) * 14 + 24 }}
            >
              <span className="text-11">{t('common.empty')}</span>
            </div>,
          );
        }
      }
    }
    return rows;
  }

  const rootNodes: TreeNode[] = roots.map((r) => ({
    path: r.path,
    name: r.path,
    rootKind: r.kind,
  }));

  // 移动端返回键/侧滑 = 关闭弹窗
  useBackPop(open, () => {
    onClose();
    return true;
  });

  if (!open) return null;

  // Portal to document.body: the panel <aside> uses .frosted (backdrop-filter),
  // which becomes the containing block for fixed descendants — without the
  // portal the modal would be clipped to the right panel instead of the page.
  return createPortal(
    // z-[65]：常从资源市场弹层（z-[60]）内唤起，必须盖过它；tooltip（z-[70]）仍在其上。
    // stopPropagation：portal 的合成事件沿 React 父链冒泡——本组件作为 MarketModal
    // 的子组件挂树，不拦的话选择器里任何一击都会冒到市场根 onClick={onClose}，
    // 把整个市场连同本弹层一起关掉（「点一下就全消失」的根因）。
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center p-3 lg:p-6 max-lg:p-0"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-[720px] max-w-full h-[560px] max-h-full rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col max-lg:h-[100dvh] max-lg:max-h-none max-lg:max-w-none max-lg:rounded-none max-lg:border-0">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted max-lg:px-3">
          <Folder className="h-4 w-4 text-blue-400" />
          <span className="text-sm font-semibold text-neutral-200">{t('picker.title')}</span>
          <span className="text-11 text-neutral-500 max-lg:hidden">{t('picker.subtitle')}</span>
          <Tooltip label={t('common.close')} side="top" className="ml-auto">
            <button
              onClick={onClose}
              className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 max-lg:p-2"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </header>

        {/* 完整绝对路径行：树里勾选后在这里显示（树内的名字会被截断），也可直接
            粘贴一个路径加入选择，不必逐层展开。 */}
        <div className="shrink-0 flex items-center gap-1.5 px-4 py-2 border-b border-edge/[0.06] max-lg:px-3">
          <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitPath();
            }}
            placeholder={t('picker.pathPlaceholder')}
            spellCheck={false}
            className="flex-1 min-w-0 bg-neutral-900 rounded px-2 py-1 text-xs font-mono text-neutral-200"
          />
          <Tooltip label={t('picker.addPathTip')}>
            <button
              onClick={commitPath}
              disabled={!pathInput.trim()}
              className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-40 max-lg:px-3 max-lg:py-2"
            >
              {t('picker.add')}
            </button>
          </Tooltip>
        </div>

        <div
          className="flex-1 flex flex-col min-h-0 overflow-hidden"
          onKeyDown={onPickerKeyDown}
          tabIndex={0}
        >
          {/* <lg：左栏那排快访收成一条横向滑动条——两栏并排在手机上树只剩一半宽。
              pill 不换行不收缩（gap 恒定 6px），缩放下交错 = 容器被 flex 压缩，
              这里 w-max 锁住自然宽度让 overflow-x 接管。 */}
          <div className="lg:hidden shrink-0 flex items-center gap-1.5 overflow-x-auto border-b border-edge/[0.06] px-2 py-1.5 overscroll-contain">
            <div className="flex items-center gap-1.5 w-max max-w-none">
              {roots.map((r) => {
                const meta = ROOT_LABELS[r.kind];
                return (
                  <Tooltip key={r.path} label={r.path} side="top">
                    <button
                      onClick={() => toggleExpand(r.path)}
                      className="flex-none inline-flex items-center gap-1 rounded-full bg-edge/[0.06] px-2.5 py-1.5 text-11 text-neutral-300 touch-manipulation whitespace-nowrap"
                    >
                    {r.kind === 'drive' || r.kind === 'root' ? (
                      <HardDrive className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                    ) : (
                      <meta.icon className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                    )}
                    <span className="whitespace-nowrap">
                      {r.kind === 'drive' || r.kind === 'root' ? r.path : t(meta.labelKey)}
                    </span>
                    </button>
                  </Tooltip>
                );
              })}
              {roots.length === 0 && <SkeletonRows rows={1} className="p-0" />}
            </div>
          </div>

          <div className="flex-1 flex min-h-0">
            {/* 快访单列：内置根在前，用户自加的目录（树里右键添加）在后——
                自定义项右键可移除，内置根不可移除。 */}
            <aside
              className="hidden lg:block shrink-0 border-r border-edge/[0.06] overflow-y-auto overscroll-contain p-2 space-y-0.5 frosted"
              style={{ width: cssPx(sidebarWidth) }}
            >
              <p className="px-2 pb-1 text-10 font-medium uppercase tracking-wide text-neutral-500">
                {t('picker.quickAccess')}
              </p>
              {roots.map((r, ri) => {
                const meta = ROOT_LABELS[r.kind];
                // 磁盘行只显示盘符（C:\、D:\…）——「磁盘」字样三个盘重复三遍是噪声；
                // 其余根只显示名（完整路径悬停可见，主目录的长路径不再顶宽行）。
                const label = r.kind === 'drive' || r.kind === 'root' ? r.path : t(meta.labelKey);
                const active = colPaths[0] === r.path;
                const focused = kb?.col === 0 && kb.row === ri;
                return (
                  <Tooltip key={r.path} label={r.path} className="w-full">
                    <button
                      onClick={() => enterColumn(r.path, -1)}
                      className={cn(
                        'w-full flex items-center gap-1.5 px-2 py-1 rounded text-left hover:bg-edge/[0.06]',
                        active && 'bg-edge/[0.08]',
                        focused && 'ring-1 ring-blue-400',
                      )}
                    >
                      {r.kind === 'drive' || r.kind === 'root' ? (
                        <HardDrive className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                      ) : (
                        <meta.icon className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                      )}
                      <span className="text-xs text-neutral-300 truncate">{label}</span>
                    </button>
                  </Tooltip>
                );
              })}
              {quickAccess.map((p, qi) => (
                <Tooltip key={p} label={p} className="w-full">
                  <button
                    onClick={() => enterColumn(p, -1)}
                    className={cn(
                      'w-full flex items-center gap-1.5 px-2 py-1 rounded text-left hover:bg-edge/[0.06]',
                      colPaths[0] === p && 'bg-edge/[0.08]',
                      kb?.col === 0 && kb.row === roots.length + qi && 'ring-1 ring-blue-400',
                    )}
                    onContextMenu={(e) => {
                      if (window.matchMedia('(pointer: coarse)').matches) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setQuickMenu({ x: e.clientX, y: e.clientY, removePath: p });
                    }}
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                    <span className="text-xs text-neutral-300 truncate">
                      {p.split(/[\\/]/).filter(Boolean).pop() ?? p}
                    </span>
                  </button>
                </Tooltip>
              ))}
              {roots.length === 0 && <SkeletonRows rows={8} className="p-0" />}
            </aside>
            <div
              onPointerDown={startSidebarResize}
              className="hidden lg:block relative w-1.5 shrink-0 cursor-col-resize group/sep"
            >
              <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-edge/[0.12]" />
              <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-blue-500/50 opacity-0 group-hover/sep:opacity-100" />
            </div>

            {/* ≥lg：分栏视图（Finder column view），向右逐级深入、横向滚动；
                <lg：树形钻取单栏（手机文件选择器形态），窄屏没有横向上页横滚。 */}
            <main className="flex-1 min-w-0 overflow-y-auto overscroll-contain p-1.5 lg:p-0 max-lg:overflow-x-hidden">
              <div className="hidden lg:flex h-full items-stretch overflow-x-auto overflow-y-auto overscroll-contain">
                {colPaths.map((colPath, i) => {
                  const isLast = i === colPaths.length - 1;
                  return (
                    <div key={`${i}:${colPath ?? 'pos'}`} className="flex h-full items-stretch shrink-0">
                      <div
                        className="h-full overflow-y-auto overscroll-contain"
                        style={isLast ? { flex: '1 1 0', minWidth: 0 } : { width: cssPx(colWidth), flexShrink: 0 }}
                      >
                        {renderColumn(i, colPath)}
                      </div>
                      {!isLast && (
                        <div
                          onPointerDown={startColResize}
                          className="relative w-1.5 shrink-0 cursor-col-resize group/sep"
                        >
                          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-edge/[0.12]" />
                          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-blue-500/50 opacity-0 group-hover/sep:opacity-100" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="lg:hidden">
                {rootNodes.length > 0 ? (
                  renderNodes(rootNodes, 0)
                ) : (
                  <div className="flex items-center justify-center h-full text-neutral-500 text-xs">
                    {error ?? t('common.loading')}
                  </div>
                )}
              </div>
            </main>
          </div>
        </div>

        <footer className="shrink-0 border-t border-edge/[0.06] px-4 py-2.5 flex items-center gap-3 frosted max-lg:flex-wrap max-lg:gap-2 max-lg:px-3 max-lg:pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          {/* <lg：已选标签独占一行，计数与两个按钮换到下一行 */}
          <div className="flex-1 min-w-0 flex flex-wrap gap-1 max-h-12 overflow-y-auto max-lg:basis-full max-lg:max-h-24">
            {selected.length === 0 && (
              <span className="text-11 text-neutral-500">{t('picker.noneSelected')}</span>
            )}
            {selected.map((p) => (
              <Tooltip key={p} label={t('picker.clickRemove')}>
                <button
                  onClick={() => toggleCheck(p)}
                  className="inline-flex items-center gap-1 rounded-full bg-blue-900/40 text-blue-200 pl-2 pr-1 py-0.5 text-11 hover:bg-blue-900/60 max-lg:py-1.5"
                >
                  <Folder className="h-3 w-3" />
                  <span className="max-w-[220px] truncate max-lg:max-w-[180px]">{p}</span>
                  <X className="h-3 w-3" />
                </button>
              </Tooltip>
            ))}
          </div>
          {error && <span className="text-11 text-red-400 max-w-[200px] truncate">{error}</span>}
          <span className="text-11 text-neutral-500 shrink-0 max-lg:mr-auto">
            {t('picker.selectedCount', { count: selected.length })}
          </span>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 max-lg:flex-1 max-lg:py-2"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => {
              onConfirm(selected);
              setSelected([]);
              setPathInput('');
            }}
            disabled={selected.length === 0}
            className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed max-lg:flex-1 max-lg:py-2"
          >
            {selected.length > 0
              ? t('picker.addCount', { count: selected.length })
              : t('picker.add')}
          </button>
        </footer>

        {/* 右键菜单：树行「加入快速访问」／快访自定义项「移除」。 */}
        {quickMenu && (
          <div
            data-quick-menu
            className="fixed z-[66] w-44 rounded-lg border border-edge/[0.1] bg-neutral-900 py-1 shadow-mac"
            style={{
              left: cssPx(Math.max(8, Math.min(quickMenu.x, window.innerWidth - 176 - 8))),
              top: cssPx(Math.max(8, Math.min(quickMenu.y, window.innerHeight - 96))),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {quickMenu.addPath !== undefined && (
              <button
                type="button"
                onClick={() => {
                  addQuickAccess(quickMenu.addPath!);
                  setQuickMenu(null);
                }}
                className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-11 text-neutral-200 hover:bg-edge/[0.06]"
              >
                <FolderPlus className="h-3 w-3 text-neutral-500" />
                {quickAccess.includes(quickMenu.addPath)
                  ? t('picker.quickAlready')
                  : t('picker.quickAdd')}
              </button>
            )}
            {quickMenu.removePath !== undefined && (
              <button
                type="button"
                onClick={() => {
                  removeQuickAccess(quickMenu.removePath!);
                  setQuickMenu(null);
                }}
                className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-11 text-neutral-200 hover:bg-edge/[0.06]"
              >
                <ListX className="h-3 w-3 text-neutral-500" />
                {t('picker.quickRemove')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
