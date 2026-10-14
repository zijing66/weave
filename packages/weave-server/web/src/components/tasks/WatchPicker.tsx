import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import type { SessionWatchRow, WatchOn } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

/** 可选触发类型（顺序即展示序）；标签/说明全走 i18n 表。 */
const KINDS: WatchOn[] = ['idle', 'turnEnd', 'messageFailed'];
const KIND_LABEL: Record<WatchOn, 'tasks.watchKindIdle' | 'tasks.watchKindTurnEnd' | 'tasks.watchKindMessageFailed'> = {
  idle: 'tasks.watchKindIdle',
  turnEnd: 'tasks.watchKindTurnEnd',
  messageFailed: 'tasks.watchKindMessageFailed',
};
const KIND_HINT: Record<
  WatchOn,
  'tasks.watchKindIdleHint' | 'tasks.watchKindTurnEndHint' | 'tasks.watchKindMessageFailedHint'
> = {
  idle: 'tasks.watchKindIdleHint',
  turnEnd: 'tasks.watchKindTurnEndHint',
  messageFailed: 'tasks.watchKindMessageFailedHint',
};

/**
 * 会话提醒订阅弹窗：选触发类型集 → 订阅**下一条**命中的消息（one-shot，
 * 命中即提醒并失效）。触发后 dashboard 侧出 toast + 浏览器通知（切走标签页
 * 也看得见）；已订阅时同一弹窗可取消。
 */
export function WatchPicker({
  label,
  current,
  busy,
  onSubscribe,
  onUnwatch,
  onClose,
}: {
  /** 会话显示名（标题回退 id 短前缀）。 */
  label: string;
  /** 已订阅的行；null = 未订阅。 */
  current: SessionWatchRow | null;
  /** 提交在途：禁二次点击。 */
  busy?: boolean;
  /** times：次数（null = 持久化，不自动失效）。 */
  onSubscribe: (on: WatchOn[], times: number | null) => void;
  onUnwatch: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<Set<WatchOn>>(
    () => new Set(current?.onEvents.length ? current.onEvents : ['idle']),
  );
  const [times, setTimes] = useState<number>(() => current?.remaining ?? 1);
  const [persistent, setPersistent] = useState<boolean>(
    () => current != null && current.remaining === null,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (kind: WatchOn): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-white/[0.08] bg-neutral-900 p-3 shadow-mac"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-2">
          <p className="min-w-0 truncate text-xs font-medium text-neutral-200">
            {t('tasks.watchPickerTitle')} · {label}
          </p>
          <button
            type="button"
            title={t('tasks.messagesClose')}
            aria-label={t('tasks.messagesClose')}
            onClick={onClose}
            className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="pb-2 text-[11px] leading-relaxed text-neutral-500">
          {t('tasks.watchPickerHint')}
        </p>
        <ul className="space-y-1">
          {KINDS.map((kind) => {
            const on = selected.has(kind);
            return (
              <li key={kind}>
                <button
                  type="button"
                  onClick={() => toggle(kind)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
                    on
                      ? 'border-amber-400/40 bg-amber-500/10'
                      : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.16] hover:bg-white/[0.06]',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                      on ? 'border-amber-400 bg-amber-500 text-neutral-950' : 'border-white/20',
                    )}
                  >
                    {on && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-neutral-200">{t(KIND_LABEL[kind])}</span>
                    <span className="mt-0.5 block text-[10px] text-neutral-500">
                      {t(KIND_HINT[kind])}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {/* 提醒次数：数字 = 命中该次数后失效（所有已选类型共用一个计数）；
            勾了「持久化」= 不自动失效。 */}
        <div className="mt-3 flex items-center gap-2 border-t border-white/[0.06] pt-2.5">
          <span className="text-[11px] text-neutral-400">{t('tasks.watchTimes')}</span>
          <input
            type="number"
            min={1}
            max={100}
            value={times}
            disabled={persistent}
            onChange={(e) => setTimes(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
            className="w-16 rounded border border-white/[0.1] bg-neutral-950 px-1.5 py-0.5 text-[11px] text-neutral-100 focus:border-blue-500/40 focus:outline-none disabled:opacity-40"
          />
          <label className="flex cursor-pointer items-center gap-1 text-[11px] text-neutral-300">
            <input
              type="checkbox"
              checked={persistent}
              onChange={(e) => setPersistent(e.target.checked)}
              className="h-3 w-3 accent-blue-500"
            />
            {t('tasks.watchPersistent')}
          </label>
        </div>
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={() =>
              onSubscribe(
                KINDS.filter((k) => selected.has(k)),
                persistent ? null : times,
              )
            }
            className="flex-1 rounded bg-blue-600/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
          >
            {t('tasks.watchSubscribe')}
          </button>
          {current && (
            <button
              type="button"
              disabled={busy}
              onClick={onUnwatch}
              className="rounded border border-white/[0.08] px-2.5 py-1 text-[11px] text-neutral-300 transition-colors hover:border-red-400/40 hover:text-red-300 disabled:opacity-40"
            >
              {t('tasks.watchUnwatch')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
