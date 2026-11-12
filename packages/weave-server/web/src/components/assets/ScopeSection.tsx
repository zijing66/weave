import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toggleIn } from '@/lib/repo-groups';

/**
 * 资源管理两级折叠的外层（批：项目/用户 → 类别）：一个范围段折叠条，内容 =
 * 各类别块（类别块自己的折叠在各 Grid/ToolkitSection 内）。折叠集记「折叠起来的」，
 * 默认展开——与 ToolkitSection/SkillGrid 的折叠口径一致。
 */
export function ScopeSection({
  label,
  count,
  defaultCollapsed = false,
  children,
}: {
  label: string;
  /** 段内条目数（折叠时也能读到的总结 tag）。 */
  count: number;
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className="rounded-2xl border border-edge/[0.08] bg-neutral-900/60 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((prev) => !prev);
          }
        }}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-edge/[0.03] cursor-pointer"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        )}
        <span className={cn('text-xs font-semibold text-neutral-200')}>{label}</span>
        <span className="ml-auto rounded-full bg-neutral-800/60 text-neutral-400 px-1.5 py-0.5 text-10 font-medium tabular-nums">
          {count}
        </span>
      </div>
      {!collapsed && <div className="space-y-4 px-3 pb-3 pt-1">{children}</div>}
    </div>
  );
}

/** 类别级折叠块（第二级：Skills / MCP / Plugins），同一折叠语言。count 缺席 =
 * 该类别的行数由内部组件自持（如 ToolkitSection），折叠条不摆总结 tag。 */
export function CategorySection({
  label,
  count,
  defaultCollapsed = false,
  children,
}: {
  label: string;
  count?: number;
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((prev) => !prev);
          }
        }}
        className="w-full flex items-center gap-1.5 text-left cursor-pointer group"
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3 shrink-0 text-neutral-600 group-hover:text-neutral-400" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 text-neutral-600 group-hover:text-neutral-400" />
        )}
        <span className="text-11 font-semibold text-neutral-500 uppercase tracking-wide group-hover:text-neutral-300">
          {label}
        </span>
        {count !== undefined && (
          <span className="rounded-full bg-neutral-800/60 text-neutral-500 px-1.5 py-0.5 text-10 font-medium tabular-nums">
            {count}
          </span>
        )}
      </div>
      {!collapsed && children}
    </div>
  );
}

export { toggleIn };
