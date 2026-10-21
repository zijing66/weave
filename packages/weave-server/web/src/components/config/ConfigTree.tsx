import { ChevronDown, ChevronRight, Lock } from 'lucide-react';
import type { ConfigTreeNode } from '@/lib/config-form';
import { textOf } from '@/lib/config-form';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import { ConfigValueRow, TREE_INDENT, type RowEdit } from './ConfigValueRow';

export interface ConfigTreeHandlers {
  /** 这个节点展不展开（默认展开哪些由调用方定）。 */
  isOpen: (node: ConfigTreeNode) => boolean;
  onToggle: (path: string) => void;
  hasValue: (path: string) => boolean;
  isManaged: (path: string) => boolean;
  valueOf: (path: string) => unknown;
  onChange: (path: string, edit: RowEdit) => void;
}

function countSet(node: ConfigTreeNode, hasValue: (path: string) => boolean): number {
  if (node.children.length === 0) return hasValue(node.path) ? 1 : 0;
  return node.children.reduce((sum, child) => sum + countSet(child, hasValue), 0);
}

/**
 * 配置树：JSON 的嵌套结构原样摆出来——对象可展开，叶子右边直接出控件，
 * 文件里存在但词表没收的键只读列在后面（那个键只能去原始 JSON 视图改）。
 */
export function ConfigTree({
  nodes,
  depth = 0,
  handlers,
}: {
  nodes: readonly ConfigTreeNode[];
  depth?: number;
  handlers: ConfigTreeHandlers;
}) {
  const t = useT();
  return (
    <div>
      {nodes.map((node) => {
        if (node.children.length > 0) {
          const open = handlers.isOpen(node);
          const setCount = countSet(node, handlers.hasValue);
          return (
            <div key={node.path}>
              <button
                onClick={() => handlers.onToggle(node.path)}
                style={{ paddingLeft: depth * TREE_INDENT }}
                className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-neutral-800/40"
                title={node.path}
              >
                {open ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-neutral-500" />
                )}
                <span className={cn('font-mono text-[11px]', setCount > 0 ? 'text-neutral-200' : 'text-neutral-400')}>
                  {node.segment}
                </span>
                <span className="text-[10px] text-neutral-600">
                  {setCount}/{node.children.length}
                </span>
                {node.spec?.group && (
                  <span className="truncate text-[10px] text-neutral-700">{node.spec.group}</span>
                )}
                {handlers.isManaged(node.path) && (
                  <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1 text-[10px] text-amber-300">
                    <Lock className="h-2.5 w-2.5" />
                    {t('cfg.managed')}
                  </span>
                )}
              </button>
              {open && <ConfigTree nodes={node.children} depth={depth + 1} handlers={handlers} />}
            </div>
          );
        }
        if (!node.spec) {
          return (
            <div
              key={node.path}
              style={{ paddingLeft: depth * TREE_INDENT }}
              className="flex items-start gap-2 rounded-md px-1.5 py-1"
              title={t('cfg.extraHint')}
            >
              <span className="w-[38%] shrink-0 truncate font-mono text-[11px] leading-6 text-neutral-500">
                {node.segment}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-6 text-neutral-600">
                {textOf(handlers.valueOf(node.path))}
              </span>
              <span className="shrink-0 rounded bg-neutral-800 px-1 py-0.5 text-[10px] text-neutral-500">
                {t('cfg.extra')}
              </span>
            </div>
          );
        }
        return (
          <ConfigValueRow
            key={node.path}
            spec={node.spec}
            label={node.segment}
            depth={depth}
            value={handlers.valueOf(node.path)}
            managed={handlers.isManaged(node.path)}
            onChange={(edit) => handlers.onChange(node.path, edit)}
          />
        );
      })}
    </div>
  );
}
