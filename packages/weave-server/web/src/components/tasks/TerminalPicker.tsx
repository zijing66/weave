import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { TerminalTarget } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';

/** 弹窗壳（标题栏 + 蒙版 + 面板）：观感一致靠共用一份，不靠两处对齐。 */
function PickerShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
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
                  <span className="shrink-0 rounded bg-amber-900/40 px-1 text-10 text-amber-300">
                    {t('tasks.terminalTargetFull', { n: target.paneCount })}
                  </span>
                )}
                {target.active && (
                  <span className="shrink-0 rounded bg-emerald-900/40 px-1 text-10 text-emerald-300">
                    {t('tasks.terminalTargetActive')}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-10 text-neutral-500">
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
