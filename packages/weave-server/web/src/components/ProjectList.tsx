import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type ProjectRow } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import { Circle, FolderOpen, Globe, Terminal } from 'lucide-react';

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
}: ProjectListProps) {
  const t = useT();
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
        {projects.map((p) => (
          <li key={p.id}>
            <button
              onClick={() => onSelect(p)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, project: p });
              }}
              className={cn(
                'w-full flex items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-200',
                !globalActive && selectedId === p.id ? 'bg-neutral-800/80' : 'hover:bg-neutral-800/50',
              )}
            >
              <Circle
                className={cn(
                  'h-2 w-2 mt-1.5 shrink-0',
                  !globalActive && selectedId === p.id ? 'text-emerald-400' : 'text-neutral-500',
                )}
              />
              <span className="min-w-0">
                <span className="block truncate text-sm">{p.name}</span>
                <span className="block text-[11px] text-neutral-500">{p.path}</span>
              </span>
            </button>
          </li>
        ))}
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
