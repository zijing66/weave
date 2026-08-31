import { type ProjectRow } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Circle, Globe } from 'lucide-react';

export function ProjectList({
  projects,
  selectedId,
  globalActive,
  onSelect,
  onSelectGlobal,
}: {
  projects: ProjectRow[];
  selectedId?: number;
  /** Whether the global-config pseudo-project is currently active. */
  globalActive: boolean;
  onSelect: (p: ProjectRow) => void;
  onSelectGlobal: () => void;
}) {
  return (
    <div className="flex flex-col">
      {/* 全局配置 */}
      <p className="px-4 pt-2 pb-1 text-[11px] text-neutral-500 uppercase tracking-wide">全局配置</p>
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
            <span className="block truncate text-sm">全局配置</span>
            <span className="block text-[11px] text-neutral-500">机器级 harness 默认模板</span>
          </span>
        </button>
      </div>

      {/* 项目 */}
      <p className="px-4 pt-3 pb-1 text-[11px] text-neutral-500 uppercase tracking-wide">项目</p>
      {projects.length === 0 && <p className="p-3 text-xs text-neutral-500">No projects registered</p>}
      <ul className="p-2 space-y-1">
        {projects.map((p) => (
          <li key={p.id}>
            <button
              onClick={() => onSelect(p)}
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
    </div>
  );
}
