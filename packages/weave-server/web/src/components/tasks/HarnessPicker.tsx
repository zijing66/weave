import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Harness } from '@weavecode/core/harness';
import { useT } from '@/i18n/I18nProvider';
import { harnessUiOf } from '@/lib/harness-meta';
import { HarnessIcon } from './HarnessIcon';

/**
 * 新建会话的 harness 选择弹窗（结构同 TerminalPicker）：只在项目有多个能起交互
 * 会话的已接入 harness 时现形——1 个直接起、0 个按钮置灰，都不弹。
 */
export function HarnessPicker({
  harnesses,
  onPick,
  onClose,
}: {
  harnesses: Harness[];
  onPick: (harness: Harness) => void;
  onClose: () => void;
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
        className="w-full max-w-xs rounded-xl border border-white/[0.08] bg-neutral-900 p-3 shadow-mac"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-2">
          <p className="text-xs font-medium text-neutral-200">{t('tasks.harnessPickTitle')}</p>
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
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {harnesses.map((harness) => (
            <li key={harness}>
              <button
                type="button"
                onClick={() => onPick(harness)}
                className="flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-white/[0.16] hover:bg-white/[0.06]"
              >
                <HarnessIcon harness={harness} />
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">
                  {harnessUiOf(harness).label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
