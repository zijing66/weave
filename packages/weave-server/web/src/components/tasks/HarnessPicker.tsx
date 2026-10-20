import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Harness } from '@weavecode/core/harness';
import { useT } from '@/i18n/I18nProvider';
import { harnessUiOf } from '@/lib/harness-meta';
import { HarnessIcon } from './HarnessIcon';

/**
 * 新建会话的 harness 选择：贴在「新建会话」按钮下方的卡片弹层（同项目列表的
 * 终端弹层那套——锚在按钮上、点外面/滚动/Esc 收）。只在项目有多个能起交互会话
 * 的已接入 harness 时现形：1 个直接起、0 个按钮置灰，都不弹。
 */
export function HarnessPicker({
  harnesses,
  x,
  y,
  anchor,
  onPick,
  onClose,
}: {
  harnesses: Harness[];
  x: number;
  y: number;
  /** 打开它的那枚按钮：它自己那一击归它的 onClick 做开合切换，这里不抢。 */
  anchor: HTMLElement;
  onPick: (harness: Harness) => void;
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
        left: Math.min(x, window.innerWidth - 248),
        top: Math.min(y, window.innerHeight - 168),
      }}
      className="fixed z-50 w-60 rounded-lg border border-edge/[0.08] bg-neutral-900 p-1 shadow-mac"
    >
      <p className="px-2 pb-1 pt-0.5 text-[10px] text-neutral-500">{t('tasks.harnessPickTitle')}</p>
      <ul className="space-y-1 pb-1">
        {harnesses.map((harness) => (
          <li key={harness}>
            <button
              type="button"
              onClick={() => onPick(harness)}
              className="flex w-full items-center gap-2 rounded-lg border border-edge/[0.06] bg-edge/[0.02] px-2.5 py-2 text-left transition-colors hover:border-edge/[0.16] hover:bg-edge/[0.06]"
            >
              <HarnessIcon harness={harness} />
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">
                {harnessUiOf(harness).label}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}
