import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type BrowseChild, type BrowseRoot } from '@/lib/api';
import { cn } from '@/lib/utils';
import { cssPx } from '@/lib/font-scale';
import { useBackPop } from '@/lib/back-pop';
import { useT } from '@/i18n/I18nProvider';
import { useMediaQuery } from '@/lib/use-media-query';
import { FileColumnsBrowser, MobileFadePanels, useColumnWidths } from '@/components/FileColumnsBrowser';
import { Tooltip } from '@/components/ui/tooltip';
import type { MessageKey } from '@/i18n/dict';
import {
  Check,
  ChevronLeft,
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

/** 用户自加的快速访问项（行右键添加）：纯前端偏好，localStorage 记忆。 */
const QUICK_ACCESS_KEY = 'weave:pickerQuickAccess';

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
 *  触发后轻微震动反馈；移动超过阈值算滚动、取消。纯闭包工厂（绝不用 hook——
 *  行循环里每行一份，hook 数会随行数漂移，React #310 白屏就是这么来的）。 */
function makeLongPress(onLongPress: (x: number, y: number) => void, enabled: boolean) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startPos: { x: number; y: number } | null = null;
  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    startPos = null;
  };
  return {
    onTouchStart: (e: React.TouchEvent): void => {
      if (!enabled) return;
      const t0 = e.touches[0];
      if (!t0) return;
      startPos = { x: t0.clientX, y: t0.clientY };
      timer = setTimeout(() => {
        timer = null;
        if (startPos) {
          onLongPress(startPos.x, startPos.y);
          startPos = null;
          navigator.vibrate?.(10);
        }
      }, 500);
    },
    onTouchMove: (e: React.TouchEvent): void => {
      const t0 = e.touches[0];
      if (!startPos || !t0) return;
      if (Math.abs(t0.clientX - startPos.x) + Math.abs(t0.clientY - startPos.y) > 12) clear();
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

const nameOf = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * Cross-platform in-browser folder picker: quick-access roots on the left,
 * the file-browser three-column state machine in the main area (聚焦渲染、
 * 点击进入 — same as FileBrowserModal). Folders only, multi-select via
 * checkboxes. Directory listings are fetched live per navigation — no cache.
 */
export function DirectoryPickerModal({
  open,
  onClose,
  onConfirm,
  existingPaths = [],
}: DirectoryPickerModalProps) {
  const [roots, setRoots] = useState<BrowseRoot[]>([]);
  /** 当前浏览目录；null = 快访根选择态（中栏列根）。 */
  const [curDir, setCurDir] = useState<string | null>(null);
  /** curDir（或根选择态下无）的子目录——实时查询，每次导航现拉、不缓存。 */
  const [entries, setEntries] = useState<BrowseChild[]>([]);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  /** 聚焦目录的子目录（右栏只读预览）——同样实时查。 */
  const [subEntries, setSubEntries] = useState<BrowseChild[] | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  /** 顶部完整路径行：树里勾选时显示该文件夹，也可直接粘贴一个路径加入选择。 */
  const [pathInput, setPathInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 用户自加的快访项（行右键添加、右键移除；内置根不可移除）。 */
  const [quickAccess, setQuickAccess] = useState<string[]>([]);
  const [quickMenu, setQuickMenu] = useState<QuickMenu | null>(null);
  /** 中栏|预览列两道分栏宽（文件浏览器同款 hook，会话级记忆）。 */
  const { leftW, setLeftW, previewW, setPreviewW } = useColumnWidths('weave:picker-columns');
  /** 键盘导航接管标记（悬停不许抢回选中）。 */
  const kbdNav = useRef(false);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const t = useT();

  useEffect(() => {
    if (!open) return;
    setQuickAccess(loadQuickAccess());
    setCurDir(null);
    setFocused(null);
    setSelected([]);
    setPathInput('');
    setError(null);
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

  /** 目录列表实时查询：每次导航现拉，不落任何缓存。 */
  useEffect(() => {
    if (!open || curDir === null) {
      setEntries([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .listFsChildren(curDir)
      .then((children) => {
        if (alive) setEntries(children);
      })
      .catch((e) => {
        if (alive) {
          setEntries([]);
          setError(String(e));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, curDir]);

  /** 聚焦目录的子目录（右栏预览）：同样实时查。 */
  useEffect(() => {
    if (!open || focused === null) {
      setSubEntries(null);
      return;
    }
    let alive = true;
    setSubLoading(true);
    api
      .listFsChildren(focused)
      .then((children) => {
        if (alive) setSubEntries(children);
      })
      .catch(() => {
        if (alive) setSubEntries([]);
      })
      .finally(() => {
        if (alive) setSubLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, focused]);

  const toggleCheck = useCallback((dirPath: string) => {
    kbdNav.current = true;
    setSelected((prev) => {
      const on = !prev.includes(dirPath);
      const next = on ? [...prev, dirPath] : prev.filter((p) => p !== dirPath);
      setPathInput(next.length > 0 ? next[next.length - 1]! : '');
      return next;
    });
  }, []);

  const goUp = useCallback(() => {
    kbdNav.current = false;
    setFocused(null);
    if (curDir === null) return;
    // 退到根 = 回快访根选择态（中栏列根），再退才轮到关弹窗
    const slash = Math.max(curDir.lastIndexOf('\\'), curDir.lastIndexOf('/'));
    setCurDir(slash > 2 ? curDir.slice(0, slash) : null);
  }, [curDir]);

  /** 顶行提交：粘贴的路径（资源管理器带引号形也认）加进选择，已添加的忽略。 */
  const commitPath = useCallback(() => {
    const p = cleanPath(pathInput);
    setPathInput(p);
    if (!p || selected.includes(p) || existingPaths.includes(p)) return;
    setSelected([...selected, p]);
  }, [pathInput, selected, existingPaths]);

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

  // 移动端长按 = 右键（加入快速访问）。
  const coarse = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const longPressProps = useCallback(
    (fire: (x: number, y: number) => void) => makeLongPress(fire, coarse),
    [coarse],
  );

  const openQuickMenuFor = useCallback(
    (dirPath: string, x: number, y: number): void => {
      if (coarse) return;
      setQuickMenu({ x, y, addPath: dirPath });
    },
    [coarse],
  );

  /** 中栏行（目录行）：单击 = 聚焦（右栏渲染子目录）；双击/→ = 进入；
   *  勾选框 = 选中。进入与聚焦是两件事（文件浏览器同一套状态机）。 */
  const enterDir = useCallback((dirPath: string) => {
    kbdNav.current = false;
    setFocused(null);
    setCurDir(dirPath);
  }, []);

  // 方向键导航（文件浏览器同款）：↑↓ 移动聚焦，→ 进入，← 退上级，
  // Enter/空格 勾选。挂 document 捕获阶段：焦点在哪儿都还能用键盘。
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (inInput) return;
    // 中栏清单：根选择态列根，浏览态列子目录
    const list: { path: string; name: string }[] =
      curDir === null
        ? [
            ...roots.map((r) => ({ path: r.path, name: nameOf(r.path) })),
            ...quickAccess.map((p) => ({ path: p, name: nameOf(p) })),
          ]
        : entries.map((c) => ({ path: c.path, name: c.name }));
    const at = focused ? list.findIndex((x) => x.path === focused) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      kbdNav.current = true;
      const next = list.length === 0 ? null : list[Math.max(0, Math.min(list.length - 1, (at < 0 ? (e.key === 'ArrowDown' ? -1 : 0) : at) + (e.key === 'ArrowDown' ? 1 : -1)))];
      setFocused(next?.path ?? null);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (focused) enterDir(focused);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goUp();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (focused) {
        if (curDir === null) enterDir(focused);
        else toggleCheck(focused);
      }
      return;
    }
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => keyHandler.current(e);
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  // 移动端返回键/侧滑 = 关闭弹窗
  useBackPop(open, () => {
    onClose();
    return true;
  });

  const existing = useMemo(() => new Set(existingPaths), [existingPaths]);

  /** 中栏目录行（勾选框在行尾）：浏览态与根选择态共用，勾选只在浏览态有。 */
  const dirList = (items: { path: string; name: string }[], checkable: boolean) => (
    <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
      {loading && checkable && items.length === 0 && (
        <li className="flex items-center gap-2 px-3 py-6 text-11 text-neutral-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('common.loading')}
        </li>
      )}
      {!loading && items.length === 0 && (
        <li className="px-3 py-6 text-11 text-neutral-500">{error ?? t('common.empty')}</li>
      )}
      {items.map((item) => {
        const isChecked = selected.includes(item.path);
        const isExisting = existing.has(item.path);
        const isFocused = focused === item.path;
        return (
          <li key={item.path}>
            <div
              className={cn(
                'group flex w-full items-center gap-2 px-2.5 py-1 text-left transition-colors select-none',
                isFocused ? 'bg-blue-500/15' : 'hover:bg-edge/[0.04]',
              )}
              onMouseEnter={() => {
                // 键盘刚走过的行不许被「指针刚好停在那儿」抢回去
                if (isDesktop && !kbdNav.current) setFocused(item.path);
              }}
              onDoubleClick={() => enterDir(item.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openQuickMenuFor(item.path, e.clientX, e.clientY);
              }}
              {...longPressProps((x, y) => openQuickMenuFor(item.path, x, y))}
              data-node-path={item.path}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => {
                  if (curDir === null) {
                    enterDir(item.path);
                  } else {
                    kbdNav.current = false;
                    setFocused(item.path);
                  }
                }}
                title={item.path}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-xs',
                    isExisting ? 'text-neutral-500' : 'text-neutral-200',
                  )}
                >
                  {item.name}
                </span>
                {isExisting && (
                  <span className="shrink-0 text-10 text-neutral-600">
                    {t('picker.alreadyAdded')}
                  </span>
                )}
              </button>
              {checkable && (
                <Tooltip
                  label={
                    isExisting
                      ? t('picker.alreadyAdded')
                      : isChecked
                        ? t('picker.unselect')
                        : t('picker.selectFolder')
                  }
                >
                  <button
                    type="button"
                    onClick={() => !isExisting && toggleCheck(item.path)}
                    disabled={isExisting}
                    className={cn(
                      'shrink-0 w-4 h-4 max-lg:w-6 max-lg:h-6 rounded border flex items-center justify-center transition-colors',
                      isChecked
                        ? 'bg-blue-500 border-blue-500 text-white'
                        : 'border-neutral-600 text-transparent group-hover:border-neutral-400',
                      isExisting && 'opacity-30 cursor-not-allowed',
                    )}
                  >
                    <Check className="h-3 w-3 max-lg:h-4 max-lg:w-4" />
                  </button>
                </Tooltip>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );

  /** 快访列表（桌面左栏可点换目录；移动端左窄条提示层）。 */
  const quickAccessList = (
    <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
      {roots.length === 0 && <SkeletonRowsFallback />}
      {roots.map((r) => {
        const meta = ROOT_LABELS[r.kind];
        const label = r.kind === 'drive' || r.kind === 'root' ? r.path : t(meta.labelKey);
        return (
          <li key={r.path}>
            <button
              type="button"
              onClick={() => {
                kbdNav.current = false;
                setFocused(null);
                setCurDir(r.path);
              }}
              className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left hover:bg-edge/[0.06]"
              title={r.path}
            >
              {r.kind === 'drive' || r.kind === 'root' ? (
                <HardDrive className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              ) : (
                <meta.icon className="h-3.5 w-3.5 shrink-0 text-blue-400" />
              )}
              <span className="text-xs text-neutral-300 truncate">{label}</span>
            </button>
          </li>
        );
      })}
      {quickAccess.map((p) => (
        <li key={p}>
          <button
            type="button"
            onClick={() => {
              kbdNav.current = false;
              setFocused(null);
              setCurDir(p);
            }}
            className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left hover:bg-edge/[0.06]"
            title={p}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (coarse) return;
              setQuickMenu({ x: e.clientX, y: e.clientY, removePath: p });
            }}
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
            <span className="text-xs text-neutral-300 truncate">{nameOf(p)}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  /** 右栏：聚焦目录的子目录清单（只读预览——聚焦渲染，进入才是中栏换目录）。 */
  const previewCol = focused ? (
    <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
      {subLoading && subEntries === null ? (
        <li className="flex items-center gap-2 px-2.5 py-3 text-11 text-neutral-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('common.loading')}
        </li>
      ) : subEntries !== null && subEntries.length > 0 ? (
        subEntries.map((c) => (
          <li
            key={c.path}
            className="flex items-center gap-2 px-2.5 py-0.5 text-11 text-neutral-400"
          >
            <Folder className="h-3 w-3 shrink-0 text-blue-400/70" />
            <span className="min-w-0 flex-1 truncate font-mono">{c.name}/</span>
          </li>
        ))
      ) : (
        <li className="px-2.5 py-3 text-11 text-neutral-600">{t('common.empty')}</li>
      )}
    </ul>
  ) : (
    <div className="flex h-full items-center justify-center px-3 text-center text-11 text-neutral-600">
      {t('picker.columnHint')}
    </div>
  );

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
      <div className="relative w-[720px] max-w-full h-[560px] max-h-full rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col max-lg:h-[100dvh] max-lg:max-h-none max-lg:max-w-none max-lg:w-full max-lg:rounded-none max-lg:border-0">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted max-lg:px-3">
          <Tooltip label={t('picker.up')} side="top">
            <button
              type="button"
              aria-label={t('picker.up')}
              onClick={goUp}
              disabled={curDir === null}
              className="rounded p-1 text-neutral-400 transition-colors hover:text-neutral-100 disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </Tooltip>
          <Folder className="h-4 w-4 shrink-0 text-blue-400" />
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

        {/* 体：快访侧栏 | 当前目录 | 聚焦预览。桌面三栏（文件浏览器同款状态机：
            聚焦渲染、点击进入），中栏可操作；<lg 三栏窄排，左右渐隐提示层，
            根选择态中栏列根（与文件浏览器的「项目列表=中栏」同构）。 */}
        <div className="flex-1 flex min-h-0">
          {isDesktop ? (
            <div className="flex min-h-0 min-w-0 flex-1">
              <div className="flex h-full min-w-0 shrink-0 flex-col border-r border-edge/[0.18]">
                <p className="px-2.5 pt-2 pb-1 text-10 font-medium uppercase tracking-wide text-neutral-500">
                  {t('picker.quickAccess')}
                </p>
                {quickAccessList}
              </div>
              <FileColumnsBrowser
                parentCol={
                  curDir === null ? null : (
                    <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
                      <li className="px-2.5 py-1">
                        <button
                          type="button"
                          onClick={() => {
                            kbdNav.current = false;
                            setFocused(null);
                            setCurDir(null);
                          }}
                          className="flex w-full items-center gap-1 px-1 py-0.5 text-left text-11 text-neutral-400 hover:text-neutral-200"
                        >
                          <ChevronLeft className="h-3 w-3 shrink-0" />
                          <span className="truncate">{t('picker.quickAccess')}</span>
                        </button>
                      </li>
                      <li className="px-2.5 pb-1">
                        <span className="block truncate font-mono text-11 text-neutral-400" title={curDir}>
                          {curDir}
                        </span>
                      </li>
                    </ul>
                  )
                }
                parentRootLabel={t('picker.quickAccess')}
                middleCol={dirList(
                  curDir === null
                    ? [
                        ...roots.map((r) => ({ path: r.path, name: nameOf(r.path) })),
                        ...quickAccess.map((p) => ({ path: p, name: nameOf(p) })),
                      ]
                    : entries.map((c) => ({ path: c.path, name: c.name })),
                  curDir !== null,
                )}
                previewCol={
                  <div className="pointer-events-none flex min-h-0 flex-1 flex-col opacity-40">
                    {previewCol}
                  </div>
                }
                leftW={leftW}
                onLeftResize={(d) => setLeftW(leftW + d)}
                previewW={previewW}
                onPreviewResize={(d) => setPreviewW(previewW - d)}
              />
            </div>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* 快访横滑条：与改版前同位（浏览区上方），横向滚动一行摆下全部根。 */}
              <div className="flex shrink-0 gap-1 overflow-x-auto overscroll-x-contain border-b border-edge/[0.06] px-2 py-1.5">
                {roots.map((r) => {
                  const meta = ROOT_LABELS[r.kind];
                  const Icon = meta.icon;
                  const isDrive = r.kind === 'drive' || r.kind === 'root';
                  return (
                    <button
                      key={r.path}
                      type="button"
                      onClick={() => {
                        kbdNav.current = false;
                        setFocused(null);
                        setCurDir(r.path);
                      }}
                      className="flex shrink-0 items-center gap-1 rounded-full bg-neutral-800/70 px-2.5 py-1 text-11 text-neutral-300"
                    >
                      {isDrive ? (
                        <HardDrive className="h-3 w-3 shrink-0 text-neutral-400" />
                      ) : (
                        <Icon className="h-3 w-3 shrink-0 text-blue-400" />
                      )}
                      <span className="whitespace-nowrap">{isDrive ? r.path : t(meta.labelKey)}</span>
                    </button>
                  );
                })}
                {quickAccess.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      kbdNav.current = false;
                      setFocused(null);
                      setCurDir(p);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setQuickMenu({ x: e.clientX, y: e.clientY, removePath: p });
                    }}
                    className="flex shrink-0 items-center gap-1 rounded-full bg-neutral-800/70 px-2.5 py-1 text-11 text-neutral-300"
                  >
                    <Folder className="h-3 w-3 shrink-0 text-blue-400" />
                    <span className="whitespace-nowrap">{nameOf(p)}</span>
                  </button>
                ))}
              </div>
              <MobileFadePanels hasLeft={false}>
                <div className="hidden" />
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {dirList(curDir === null
                    ? [
                        ...roots.map((r) => ({ path: r.path, name: nameOf(r.path) })),
                        ...quickAccess.map((p) => ({ path: p, name: nameOf(p) })),
                      ]
                    : entries.map((c) => ({ path: c.path, name: c.name })), curDir !== null)}
                </div>
                <div className="pointer-events-none flex min-h-0 flex-1 flex-col opacity-40">
                  {previewCol}
                </div>
              </MobileFadePanels>
            </div>
          )}
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

        {/* 右键菜单：行「加入快速访问」／快访自定义项「移除」。 */}
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

/** 快访根未回来时的骨架（就地一行，不引 SkeletonRows 的整段 API）。 */
function SkeletonRowsFallback() {
  return (
    <li className="flex items-center gap-2 px-2.5 py-2 text-11 text-neutral-600">
      <Loader2 className="h-3 w-3 animate-spin" />
    </li>
  );
}
