import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/i18n/I18nProvider';
import { harnessUiOf } from '@/lib/harness-meta';
import type { ProjectHarness } from '@/lib/api';
import { HarnessIcon } from './HarnessIcon';

/**
 * 新建会话的 harness 选择：贴在「新建会话」按钮下方的卡片弹层（同项目列表的
 * 终端弹层那套——锚在按钮上、点外面/滚动/Esc 收）。**项目选中的 harness 全列**，
 * 起不了的（无 resume 裸 bin / 宿主版本低于闸）置灰并在行内说明原因——只有一个
 * 也照样展开，选哪个恒由用户点。
 */
export function HarnessPicker({
  harnesses,
  x,
  y,
  anchor,
  onPick,
  onClose,
}: {
  harnesses: ProjectHarness[];
  x: number;
  y: number;
  /** 打开它的那枚按钮：它自己那一击归它的 onClick 做开合切换，这里不抢。 */
  anchor: HTMLElement;
  onPick: (harness: ProjectHarness['id']) => void;
  onClose: () => void;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: Event): void => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchor.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onDown, { capture: true, passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      style={{
        left: Math.min(x, window.innerWidth - 272),
        top: Math.min(y, window.innerHeight - 168),
      }}
      className="fixed z-50 w-64 rounded-lg border border-edge/[0.08] bg-neutral-900 p-1 shadow-mac"
    >
      <p className="px-2 pb-1 pt-0.5 text-10 text-neutral-500">{t('tasks.harnessPickTitle')}</p>
      <ul className="space-y-1 pb-1">
        {harnesses.map((harness) => {
          const ui = harnessUiOf(harness.id);
          const why = !harness.canStartSession
            ? harness.minVersion
              ? t('tasks.harnessVersionLow', {
                  version: harness.version ?? '?',
                  min: harness.minVersion,
                })
              : t('tasks.harnessNoStart')
            : null;
          return (
            <li key={harness.id}>
              <button
                type="button"
                disabled={!harness.canStartSession}
                title={why ?? ui.label}
                onClick={() => onPick(harness.id)}
                className={
                  harness.canStartSession
                    ? 'flex w-full items-center gap-2 rounded-lg border border-edge/[0.06] bg-edge/[0.02] px-2.5 py-2 text-left transition-colors hover:border-edge/[0.16] hover:bg-edge/[0.06]'
                    : 'flex w-full cursor-not-allowed items-center gap-2 rounded-lg border border-edge/[0.04] bg-transparent px-2.5 py-2 text-left opacity-45'
                }
              >
                <HarnessIcon harness={harness.id} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-neutral-200">{ui.label}</span>
                  {why && <span className="mt-0.5 block text-10 leading-tight text-neutral-500">{why}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}
