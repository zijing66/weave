import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type BrowseChild, type BrowseRoot } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  HardDrive,
  Home,
  Library,
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
  const [error, setError] = useState<string | null>(null);
  const t = useT();

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

  const toggleCheck = useCallback((dirPath: string) => {
    setSelected((prev) =>
      prev.includes(dirPath) ? prev.filter((p) => p !== dirPath) : [...prev, dirPath],
    );
  }, []);

  const existing = useMemo(() => new Set(existingPaths), [existingPaths]);

  function renderNodes(nodes: TreeNode[], depth: number): ReactNode[] {
    const rows: ReactNode[] = [];
    for (const node of nodes) {
      const isExpanded = expanded.has(node.path);
      const isChecked = selected.includes(node.path);
      const isExisting = existing.has(node.path);
      const meta = node.rootKind ? ROOT_LABELS[node.rootKind] : null;
      const children = childrenByPath.get(node.path);
      const isLoading = loadingPaths.has(node.path);
      rows.push(
        <div
          key={node.path}
          className="group flex items-center gap-1 pr-2 rounded hover:bg-white/[0.04]"
          style={{ paddingLeft: depth * 14 + 6 }}
        >
          <button
            onClick={() => toggleExpand(node.path)}
            className="shrink-0 p-0.5 text-neutral-500 hover:text-neutral-200"
            title={isExpanded ? t('common.collapse') : t('common.expand')}
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            onClick={() => toggleExpand(node.path)}
            className={cn(
              'flex-1 min-w-0 flex items-center gap-1.5 text-left py-1 truncate',
              isExisting ? 'text-neutral-500' : 'text-neutral-200',
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
              <span className="shrink-0 text-[10px] text-neutral-600">{t('picker.alreadyAdded')}</span>
            )}
          </button>
          <button
            onClick={() => toggleCheck(node.path)}
            disabled={isExisting}
            className={cn(
              'shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors',
              isChecked
                ? 'bg-blue-500 border-blue-500 text-white'
                : 'border-neutral-600 text-transparent group-hover:border-neutral-400',
              isExisting && 'opacity-30 cursor-not-allowed',
            )}
            title={isChecked ? t('picker.unselect') : t('picker.selectFolder')}
          >
            <Check className="h-3 w-3" />
          </button>
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
              <span className="text-[11px]">{t('common.loading')}</span>
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
              <span className="text-[11px]">{t('common.empty')}</span>
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

  if (!open) return null;

  // Portal to document.body: the panel <aside> uses .frosted (backdrop-filter),
  // which becomes the containing block for fixed descendants — without the
  // portal the modal would be clipped to the right panel instead of the page.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[720px] max-w-full h-[560px] max-h-full rounded-2xl border border-white/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-white/[0.06] frosted">
          <Folder className="h-4 w-4 text-blue-400" />
          <span className="text-sm font-semibold text-neutral-200">{t('picker.title')}</span>
          <span className="text-[11px] text-neutral-500">{t('picker.subtitle')}</span>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
            title={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 flex overflow-hidden">
          <aside className="w-44 shrink-0 border-r border-white/[0.06] overflow-y-auto p-2 space-y-0.5 frosted">
            <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
              {t('picker.quickAccess')}
            </p>
            {roots.map((r) => {
              const meta = ROOT_LABELS[r.kind];
              return (
                <button
                  key={r.path}
                  onClick={() => toggleExpand(r.path)}
                  className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-left hover:bg-white/[0.06]"
                  title={r.path}
                >
                  {r.kind === 'drive' || r.kind === 'root' ? (
                    <HardDrive className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                  ) : (
                    <meta.icon className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                  )}
                  <span className="text-xs text-neutral-300 truncate">
                    {t(meta.labelKey)}
                    {r.kind === 'home' || r.kind === 'drive' ? (
                      <span className="ml-1 text-neutral-500">{r.path}</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
            {roots.length === 0 && (
              <p className="px-2 py-2 text-[11px] text-neutral-500">{t('common.loading')}</p>
            )}
          </aside>

          <main className="flex-1 overflow-y-auto p-1.5">
            {rootNodes.length > 0 ? (
              renderNodes(rootNodes, 0)
            ) : (
              <div className="flex items-center justify-center h-full text-neutral-500 text-xs">
                {error ?? t('common.loading')}
              </div>
            )}
          </main>
        </div>

        <footer className="shrink-0 border-t border-white/[0.06] px-4 py-2.5 flex items-center gap-3 frosted">
          <div className="flex-1 min-w-0 flex flex-wrap gap-1 max-h-12 overflow-y-auto">
            {selected.length === 0 && (
              <span className="text-[11px] text-neutral-500">{t('picker.noneSelected')}</span>
            )}
            {selected.map((p) => (
              <button
                key={p}
                onClick={() => toggleCheck(p)}
                className="inline-flex items-center gap-1 rounded-full bg-blue-900/40 text-blue-200 pl-2 pr-1 py-0.5 text-[11px] hover:bg-blue-900/60"
                title={t('picker.clickRemove')}
              >
                <Folder className="h-3 w-3" />
                <span className="max-w-[220px] truncate">{p}</span>
                <X className="h-3 w-3" />
              </button>
            ))}
          </div>
          {error && <span className="text-[11px] text-red-400 max-w-[200px] truncate">{error}</span>}
          <span className="text-[11px] text-neutral-500 shrink-0">
            {t('picker.selectedCount', { count: selected.length })}
          </span>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => {
              onConfirm(selected);
              setSelected([]);
            }}
            disabled={selected.length === 0}
            className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {selected.length > 0
              ? t('picker.addCount', { count: selected.length })
              : t('picker.add')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
