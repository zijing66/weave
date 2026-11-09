import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import {
  api,
  type ExtensionBindingRow,
  type ExtensionExecutionRow,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { useBackPop } from '@/lib/back-pop';
import { subscribeHook, type HookFrame } from '@/lib/sse';
import { Tooltip } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { formatStamp } from '@/lib/hook-payload';
import { cn } from '@/lib/utils';
import { scopedBindingsOf, sourceKey, STAGE_STYLE, triggerKey } from './binding-model';

const PAGE_SIZE = 50;

/**
 * 会话扩展执行日志（批 3）：该会话生效的绑定（项目级 + 会话级叠加展示）+
 * 逐拍执行记录（stage 着色，source/detail 展开「谁判的、依据」）。刷新挂 SSE
 * 总线的 `extension.execution` 帧订阅（sessionId 定向，500ms 防抖合拍）——
 * 不轮询、不新开 EventSource。形态复用既有事件/日志弹窗（SessionEdits 同款）。
 */
export function SessionExtensionExecutionsDialog({
  sessionId,
  projectId,
  open,
  onClose,
}: {
  sessionId: string;
  projectId: number;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [bindings, setBindings] = useState<ExtensionBindingRow[] | null>(null);
  const [rows, setRows] = useState<ExtensionExecutionRow[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 展开着的执行行（source/detail 默认收起——多数行不需要）。 */
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const loadHead = useCallback(async (): Promise<void> => {
    try {
      const [bs, page] = await Promise.all([
        api.listExtensionBindings(projectId),
        api.listExtensionExecutions({ sessionId, limit: PAGE_SIZE }),
      ]);
      setBindings(bs);
      setRows(page.executions);
      setNextBefore(page.nextBefore);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    if (!open) return;
    setRows(null);
    setBindings(null);
    void loadHead();
  }, [open, loadHead]);

  // SSE：`extension.execution` 帧驱动（sessionId 定向；不轮询）。
  useEffect(() => {
    if (!open) return;
    let timer: number | null = null;
    const off = subscribeHook((frame: HookFrame) => {
      if (frame.kind !== 'extension.execution') return;
      if ((frame as { sessionId?: string | null }).sessionId !== sessionId) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void loadHead();
      }, 500);
    }, ['extension.execution']);
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [open, sessionId, loadHead]);

  // 移动端返回键/侧滑 = 关闭弹窗
  useBackPop(open, () => {
    onClose();
    return true;
  });

  const loadMore = async (): Promise<void> => {
    if (nextBefore == null) return;
    try {
      const page = await api.listExtensionExecutions({
        sessionId,
        limit: PAGE_SIZE,
        before: nextBefore,
      });
      setRows((prev) => [...(prev ?? []), ...page.executions]);
      setNextBefore(page.nextBefore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!open) return null;

  const scoped = bindings ? scopedBindingsOf(bindings, sessionId) : null;
  const bindingById = new Map((bindings ?? []).map((b) => [b.id, b]));
  const hasBindings =
    scoped != null && (scoped.project.length > 0 || scoped.session.length > 0);

  const toggle = (id: number): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 lg:p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      {/* max-h-[86%] 不用 86dvh：根 zoom 下视口单位被二次放大（见 index.css #root 注） */}
      <div className="relative w-[760px] max-w-full max-h-[86%] rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted">
          <span className="text-sm font-semibold text-neutral-200">{t('ext.execTitle')}</span>
          <span className="text-11 text-neutral-500">{t('ext.execHint')}</span>
          <Tooltip label={t('common.close')} className="ml-auto">
            <button
              onClick={onClose}
              className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </header>

        <div className="flex-1 min-h-0 overflow-auto">
          {/* 生效绑定（叠加：项目级在前、会话级在后） */}
          <section className="border-b border-edge/[0.06] px-4 py-3">
            <h4 className="mb-2 text-11 font-semibold text-neutral-400">
              {t('ext.execBindingsTitle')}
            </h4>
            {scoped === null ? (
              <p className="flex items-center gap-1.5 text-11 text-neutral-500">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('ext.loading')}
              </p>
            ) : !hasBindings ? (
              <p className="text-11 text-neutral-500">{t('ext.execEmpty')}</p>
            ) : (
              <div className="space-y-1.5">
                {scoped.project.map((b) => (
                  <BindingRow key={`p-${b.id}`} binding={b} scope="project" />
                ))}
                {scoped.session.map((b) => (
                  <BindingRow key={`s-${b.id}`} binding={b} scope="session" />
                ))}
              </div>
            )}
          </section>

          {/* 执行日志 */}
          <section className="px-4 py-3">
            <h4 className="mb-2 text-11 font-semibold text-neutral-400">
              {t('ext.execLogTitle')}
            </h4>
            {error && <p className="text-11 text-red-300">{error}</p>}
            {rows === null && !error ? (
              <p className="flex items-center gap-1.5 text-11 text-neutral-500">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('ext.loading')}
              </p>
            ) : (rows ?? []).length === 0 ? (
              <p className="text-11 text-neutral-500">{t('ext.execLogEmpty')}</p>
            ) : (
              <div className="space-y-1">
                {(rows ?? []).map((row) => {
                  const style = STAGE_STYLE[row.stage];
                  const openRow = expanded.has(row.id);
                  const who = sourceKey(row.source);
                  const binding = bindingById.get(row.bindingId);
                  return (
                    <div key={row.id} className="rounded-md border border-edge/[0.05] bg-edge/[0.015]">
                      <button
                        type="button"
                        onClick={() => toggle(row.id)}
                        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-edge/[0.04]"
                      >
                        {openRow ? (
                          <ChevronDown className="h-3 w-3 shrink-0 text-neutral-600" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0 text-neutral-600" />
                        )}
                        <Badge className={cn('shrink-0', style.badge)}>
                          {t(style.key as Parameters<typeof t>[0])}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-11 text-neutral-300">
                          {binding?.name ?? `#${row.bindingId}`}
                        </span>
                        {row.endpointKind && (
                          <span className="shrink-0 text-10 text-neutral-500">
                            {row.endpointKind === 'session'
                              ? t('ext.endpointSession')
                              : t('ext.endpointWebhook')}
                            {row.endpointTarget ? ` → ${row.endpointTarget}` : ''}
                          </span>
                        )}
                        <Badge variant={row.trigger === 'dry-run' ? 'warning' : 'default'} className="shrink-0">
                          {t(triggerKey(row.trigger) as Parameters<typeof t>[0])}
                        </Badge>
                        <span className="shrink-0 text-10 text-neutral-600">
                          {formatStamp(row.at)}
                        </span>
                      </button>
                      {openRow && (
                        <div className="space-y-0.5 px-3 pb-2 text-10 leading-5 text-neutral-500">
                          {who && (
                            <p>
                              {t('ext.execWhoDetail', {
                                source: t(who as Parameters<typeof t>[0]),
                                detail: row.detail ?? '—',
                              })}
                            </p>
                          )}
                          {row.error && (
                            <p className="text-red-300/80">
                              {t('ext.execErrorDetail', { error: row.error })}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {nextBefore != null && (rows ?? []).length > 0 && (
              <button
                type="button"
                onClick={() => void loadMore()}
                className="mt-2 w-full rounded-md border border-edge/[0.08] py-1.5 text-11 text-neutral-400 transition-colors hover:bg-neutral-800"
              >
                {t('ext.execLoadMore', { n: PAGE_SIZE })}
              </button>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 生效绑定一行（作用域徽标：项目级 / 会话级）。 */
function BindingRow({
  binding,
  scope,
}: {
  binding: ExtensionBindingRow;
  scope: 'project' | 'session';
}) {
  const t = useT();
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border px-2.5 py-1.5',
        binding.enabled ? 'border-edge/[0.06]' : 'border-edge/[0.04] opacity-60',
      )}
    >
      <span className="min-w-0 flex-1 truncate text-11 text-neutral-200">{binding.name}</span>
      <Badge variant={scope === 'project' ? 'skill' : 'command'}>
        {scope === 'project' ? t('ext.scopeProject') : t('ext.scopeSession')}
      </Badge>
      <Badge variant="helper">{t('ext.endpointsCount', { n: binding.endpoints.length })}</Badge>
    </div>
  );
}
