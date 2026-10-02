import type { NodeProps } from '@xyflow/react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { EVENT_TYPE_STYLES, formatTime } from '@/lib/hook-payload';
import { useT } from '@/i18n/I18nProvider';
import { Check, Loader2, X, Zap } from 'lucide-react';
import type { ChainNode } from './build-session-chain';

/** 事件节点：类型徽标 + 工具名 + 时间。 */
export function EventNode({ data }: NodeProps<ChainNode>) {
  if (!data.event || !data.detail) return null;
  return (
    <div className="w-56 rounded-lg border border-white/[0.08] bg-neutral-900/70 px-2.5 py-2 shadow-sm">
      <div className="flex items-center gap-1.5">
        <Badge className={cn('shrink-0', EVENT_TYPE_STYLES[data.event.eventType])}>
          {data.event.eventType}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">
          {data.detail.toolName ?? '—'}
        </span>
        <span className="shrink-0 text-[10px] text-neutral-500">
          {formatTime(data.event.createdAt)}
        </span>
      </div>
    </div>
  );
}

/** 规则节点：只读（名称 + handler 类型 + 命中次数）。 */
export function RuleNode({ data }: NodeProps<ChainNode>) {
  const t = useT();
  if (!data.rule) return null;
  return (
    <div className="w-52 rounded-lg border border-blue-500/40 bg-blue-950/40 px-2.5 py-2 shadow-sm">
      <div className="flex items-center gap-1.5">
        <Zap className="h-3 w-3 shrink-0 text-blue-400" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-blue-200">
          {data.rule.name}
        </span>
        <Badge className="shrink-0 bg-blue-900/50 text-blue-300">
          {t('tasks.hitCount', { n: data.hits ?? 0 })}
        </Badge>
      </div>
      <p className="mt-0.5 text-[10px] text-neutral-500">{data.rule.handler.type}</p>
    </div>
  );
}

/** 处理器节点：类型 + 经此的规则数。 */
export function HandlerNode({ data }: NodeProps<ChainNode>) {
  return (
    <div className="w-40 rounded-lg border border-purple-500/40 bg-purple-950/40 px-2.5 py-2 shadow-sm">
      <p className="text-xs font-medium text-purple-200">{data.handlerType}</p>
      <p className="mt-0.5 text-[10px] text-neutral-500">{data.ruleCount ?? 0} 规则</p>
    </div>
  );
}

/** 派发结果节点：按 status 渲染徽标/spinner/绿勾/红叉；injected 态带波纹。 */
export function DispatchNode({ data }: NodeProps<ChainNode>) {
  if (!data.dispatch) return null;
  const status = data.dispatch.status;
  return (
    <div
      className={cn(
        'w-52 rounded-lg border border-white/[0.08] bg-neutral-900/70 px-2.5 py-2 shadow-sm',
        data.ripple && 'weave-ripple',
      )}
    >
      <div className="flex items-center gap-1.5">
        {status === 'running' ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-orange-400" />
        ) : status === 'succeeded' || status === 'injected' ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        ) : status === 'failed' || status === 'timeout' ? (
          <X className="h-3.5 w-3.5 shrink-0 text-red-400" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-500" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">
          {data.ruleName ?? `#${data.dispatch.ruleId.slice(0, 8)}`}
        </span>
        <Badge className="shrink-0 bg-neutral-800 text-neutral-400">{status}</Badge>
      </div>
      <p className="mt-0.5 truncate text-[10px] text-neutral-500">
        {formatTime(data.dispatch.startedAt)}
      </p>
    </div>
  );
}

export const taskNodeTypes = {
  event: EventNode,
  rule: RuleNode,
  handler: HandlerNode,
  dispatch: DispatchNode,
};
