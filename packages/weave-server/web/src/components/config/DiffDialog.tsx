import { useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { collapseDiff, countChanges, diffLines } from '@/lib/text-diff';
import { DiffRows } from '@/components/ui/diff-rows';
import { useT } from '@/i18n/I18nProvider';

/**
 * 配置差异弹窗：切换快照 / 漂移确认前把两侧逐行摆出来。
 * 只读——确认动作由调用方在这层之外给按钮（这里只负责「看清楚再决定」）。
 */
export function DiffDialog({
  open,
  title,
  beforeLabel,
  afterLabel,
  before,
  after,
  footer,
  onClose,
}: {
  open: boolean;
  title: string;
  beforeLabel: string;
  afterLabel: string;
  before: string;
  after: string;
  footer: ReactNode;
  onClose: () => void;
}) {
  const t = useT();
  const { rows, added, removed } = useMemo(() => {
    const lines = diffLines(before, after);
    const counts = countChanges(lines);
    return { rows: collapseDiff(lines, 3), ...counts };
  }, [before, after]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 lg:p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-[860px] max-w-full max-h-[86dvh] rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted">
          <span className="text-sm font-semibold text-neutral-200">{title}</span>
          <span className="text-[11px] text-neutral-500">
            <span className="text-emerald-400">+{added}</span> / <span className="text-red-400">-{removed}</span>
          </span>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
            title={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="shrink-0 flex items-center gap-3 px-4 py-1.5 border-b border-edge/[0.06] text-[11px] text-neutral-500">
          <span className="text-red-400">− {beforeLabel}</span>
          <span className="text-emerald-400">+ {afterLabel}</span>
        </div>

        <div className="flex-1 min-h-0 overflow-auto font-mono text-[11px] leading-5">
          {rows.length === 0 ? (
            <p className="p-4 text-neutral-500">{t('cfg.diffNoChanges')}</p>
          ) : (
            <DiffRows rows={rows} />
          )}
        </div>

        <footer className="shrink-0 border-t border-edge/[0.06] px-4 py-2.5 flex items-center justify-end gap-2 frosted">
          {footer}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
