import { createPortal } from 'react-dom';
import { TriangleAlert, X } from 'lucide-react';
import { useT } from '@/i18n/I18nProvider';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  /** 确认键文案（动作词，如「归档项目」）。 */
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * 应用内确认弹窗：破坏性动作的替代 window.confirm（原生框样式不可控、阻塞主线程）。
 * 沿 SettingsModal 弹窗范式；确认键走红色警示样式，与「取消」并排。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const t = useT();
  if (!open) return null;

  // Portal 到 body：侧栏 .frosted（backdrop-filter）会成为 fixed 后代的
  // containing block，留在组件树里会被裁剪在侧栏内。
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 lg:p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[380px] max-w-full rounded-2xl border border-white/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-white/[0.06] frosted">
          <TriangleAlert className="h-4 w-4 text-amber-400" />
          <span className="text-sm font-semibold text-neutral-200">{title}</span>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
            title={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="px-4 py-4">
          <p className="text-xs leading-relaxed text-neutral-400">{message}</p>
        </div>
        <footer className="shrink-0 border-t border-white/[0.06] px-4 py-2.5 flex items-center justify-end gap-2 frosted">
          <button
            onClick={onClose}
            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-500"
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
