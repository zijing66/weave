import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles } from 'lucide-react';
import { useT } from '@/i18n/I18nProvider';
import { useBackPop } from '@/lib/back-pop';
import { HARNESS_UI, HARNESS_ORDER } from '@/lib/harness-meta';
import { HarnessIcon } from './tasks/HarnessIcon';
import type { Harness } from '@weavecode/core/harness';

/**
 * 首接项目的 harness 勾选弹窗（添加项目 / 首启引导共用）：选好清单后由父层
 * 走 POST /projects/:id/init 的静默子进程 init（与「立即同步」同一链路，
 * 不再开终端敲命令）。至少勾一个才能确认。
 */
export function InitHarnessDialog({
  projectName,
  onConfirm,
  onClose,
}: {
  projectName: string;
  onConfirm: (harnesses: Harness[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [picked, setPicked] = useState<Harness[]>(['claude']);
  useBackPop(true, () => {
    onClose();
    return true;
  });

  const toggle = (h: Harness): void =>
    setPicked((cur) => (cur.includes(h) ? cur.filter((x) => x !== h) : [...cur, h]));

  return createPortal(
    <div className="fixed inset-0 z-[65] flex items-center justify-center p-3 lg:p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-[380px] max-w-full rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted">
          <Sparkles className="h-4 w-4 text-mac-accent" />
          <span className="min-w-0 truncate text-sm font-semibold text-neutral-200">
            {t('project.initHarnessTitle', { name: projectName })}
          </span>
        </header>
        <div className="px-4 py-3">
          <p className="text-xs leading-relaxed text-neutral-400">{t('project.initHarnessDesc')}</p>
          <ul className="space-y-1 pt-2.5">
            {HARNESS_ORDER.map((h) => {
              const ui = HARNESS_UI[h];
              const on = picked.includes(h);
              return (
                <li key={h}>
                  <button
                    type="button"
                    onClick={() => toggle(h)}
                    className={
                      on
                        ? 'flex w-full items-center gap-2 rounded-lg border border-mac-accent/40 bg-mac-accent/[0.08] px-2.5 py-2 text-left'
                        : 'flex w-full items-center gap-2 rounded-lg border border-edge/[0.06] bg-edge/[0.02] px-2.5 py-2 text-left transition-colors hover:border-edge/[0.16]'
                    }
                  >
                    <HarnessIcon harness={h} />
                    <span className="min-w-0 flex-1 text-xs text-neutral-200">{ui.label}</span>
                    <span
                      className={
                        on
                          ? 'size-3.5 shrink-0 rounded-full bg-mac-accent'
                          : 'size-3.5 shrink-0 rounded-full border border-edge/[0.2]'
                      }
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <footer className="shrink-0 border-t border-edge/[0.06] px-4 py-2.5 flex items-center justify-end gap-2 frosted">
          <button
            onClick={onClose}
            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            {t('common.cancel')}
          </button>
          <button
            disabled={picked.length === 0}
            onClick={() => {
              onConfirm(picked);
              onClose();
            }}
            className="rounded-lg bg-mac-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {t('project.initHarnessConfirm')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
