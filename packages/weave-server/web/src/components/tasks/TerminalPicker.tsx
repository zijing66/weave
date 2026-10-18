import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { TerminalPane, TerminalTarget } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

/** 两种终端弹窗共用的壳（标题栏 + 蒙版 + 面板）：观感一致靠共用一份，不靠两处对齐。 */
function PickerShell({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-edge/[0.08] bg-neutral-900 p-3 shadow-mac"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-2">
          <p className="text-xs font-medium text-neutral-200">{title}</p>
          <button
            type="button"
            title={t('tasks.terminalPickCancel')}
            aria-label={t('tasks.terminalPickCancel')}
            onClick={onClose}
            className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {children}
        {footer}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 会话终端选择弹窗：项目开着多个终端时，问用户把 `claude --resume <id>`
 * 附加到哪个终端。列表由服务端按最近活跃从上往下排好（实例活跃度 →
 * 聚焦 tab → 新建 tab）；只有一个终端时调用方不弹此窗，直接开。
 * 已长满的目标照列但置灰（让用户看见「这个终端满了」，而不是莫名其妙少一项）。
 */
export function TerminalPicker({
  targets,
  busy,
  onPick,
  onClose,
}: {
  targets: TerminalTarget[];
  /** 选定后请求在途：禁二次点击（防重复 spawn）。 */
  busy?: boolean;
  onPick: (targetId: string) => void;
  onClose: () => void;
}) {
  const t = useT();

  return (
    <PickerShell title={t('tasks.terminalPickTitle')} onClose={onClose}>
      <ul className="max-h-72 space-y-1 overflow-y-auto">
        {targets.map((target) => (
          <li key={target.id}>
            <button
              type="button"
              disabled={busy || target.full}
              onClick={() => onPick(target.id)}
              title={target.full ? t('tasks.terminalTargetFullTip') : undefined}
              className="w-full rounded-lg border border-edge/[0.06] bg-edge/[0.02] px-2.5 py-2 text-left transition-colors hover:border-edge/[0.16] hover:bg-edge/[0.06] disabled:opacity-50"
            >
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">
                  {target.title ??
                    t('tasks.terminalTargetFallback', { w: target.windowId, t: target.tabId })}
                </span>
                {target.full && (
                  <span className="shrink-0 rounded bg-amber-900/40 px-1 text-[10px] text-amber-300">
                    {t('tasks.terminalTargetFull', { n: target.paneCount })}
                  </span>
                )}
                {target.active && (
                  <span className="shrink-0 rounded bg-emerald-900/40 px-1 text-[10px] text-emerald-300">
                    {t('tasks.terminalTargetActive')}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-[10px] text-neutral-500">
                {t('tasks.terminalTargetDetail', {
                  match: target.matchCount,
                  total: target.paneCount,
                })}
                {' · '}
                {t('tasks.terminalTargetFallback', { w: target.windowId, t: target.tabId })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </PickerShell>
  );
}

/**
 * 项目关终端的多选弹窗：卡面与 TerminalPicker 同一套壳，但点卡片是**勾选**
 * （蓝框高亮）而不是立刻执行——底部「关闭 n 个」才真动手，随即关窗、行内按钮
 * 接手转圈（同开终端口径）。选几个关几个，不提供「全关」：那正是这个弹窗要
 * 拿掉的误触面。
 */
export function TerminalClosePicker({
  panes,
  onConfirm,
  onClose,
}: {
  panes: TerminalPane[];
  onConfirm: (paneIds: string[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (id: string): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <PickerShell
      title={t('tasks.closeTerminalPickTitle')}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={picked.size === 0}
            onClick={() => onConfirm([...picked])}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-500 disabled:opacity-50"
          >
            {t('tasks.closeTerminalConfirmLabel', { n: picked.size })}
          </button>
        </div>
      }
    >
      <ul className="max-h-72 space-y-1 overflow-y-auto">
        {panes.map((pane) => {
          const on = picked.has(pane.id);
          return (
            <li key={pane.id}>
              <button
                type="button"
                onClick={() => toggle(pane.id)}
                className={cn(
                  'w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
                  on
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-edge/[0.06] bg-edge/[0.02] hover:border-edge/[0.16] hover:bg-edge/[0.06]',
                )}
              >
                <span className="block truncate text-xs text-neutral-200">
                  {pane.title ?? t('tasks.closePaneFallback')}
                </span>
                {pane.cwd && (
                  <span className="mt-0.5 block truncate text-[10px] text-neutral-500">
                    {pane.cwd}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </PickerShell>
  );
}
