import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, RotateCcw, X } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/Toast';
import type { RewindPickerOption, RewindPickerView } from '@weavecode/harness';
import { api } from '@/lib/api';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

type Phase =
  | { kind: 'opening' }
  /** 列表屏；`preparing` = 正在进确认屏读宿主的选项。 */
  | { kind: 'ready'; view: RewindPickerView; preparing: boolean }
  /** 确认屏：选项是宿主自己渲染的那几项，原样摆出来。 */
  | { kind: 'options'; view: RewindPickerView; prompt: string; options: RewindPickerOption[] }
  | { kind: 'error'; message: string };

/**
 * `/rewind` 选择器：宿主把回退做成一扇只能**读屏 + 打键**的模态界面，故这里
 * 先请服务端把面板打开、读回当前一屏的条目；选中一条后再进确认屏，
 * **把宿主真正给的那几项原样摆出来**（同一条列表头上，消息有没有挂文件改动
 * 会决定有没有代码档，weave 不自己编档位）。选完由服务端按屏上文案驱动提交。
 *
 * 落点不可逆（回退会 fork 对话），所以只提供「选条目 + 选选项 + 确认」，
 * 关掉这扇窗会顺手把宿主面板 Esc 掉（除非已经提交成功）。
 */
export function RewindPicker({
  sessionId,
  onClose,
  onDone,
}: {
  sessionId: string;
  onClose: () => void;
  /** 回退完成：`prompt` = 被回退到的那条消息原文；`cleared` = TUI 输入框里的回填
   *  已被清掉（此时原文只在这一点上，调用方可以放心填回 web 输入框）。 */
  onDone: (prompt: string, cleared: boolean) => void;
}) {
  const t = useT();
  const fb = useActionFeedback();
  const { show } = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' });
  const [picked, setPicked] = useState<number | null>(null);
  const [option, setOption] = useState<string | null>(null);
  /** 已提交成功：卸载时不再补 Esc（面板已被宿主自己关掉）。 */
  const settled = useRef(false);

  useEffect(() => {
    let alive = true;
    api.rewindOpen(sessionId).then(
      (view) => {
        if (alive) setPhase({ kind: 'ready', view, preparing: false });
      },
      (e: unknown) => {
        if (alive) setPhase({ kind: 'error', message: errorText(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [sessionId]);

  /** 关窗：撤掉宿主面板（已提交则不用管）。 */
  const close = useCallback((): void => {
    if (!settled.current) void api.rewindCancel(sessionId).catch(() => {});
    onClose();
  }, [onClose, sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const view = phase.kind === 'ready' || phase.kind === 'options' ? phase.view : null;
  const busy =
    phase.kind === 'opening' ||
    (phase.kind === 'ready' && phase.preparing) ||
    fb.stateOf('rewindCommit') === 'loading';

  /** 选中一条 → 进确认屏，读回宿主给的选项。 */
  const pick = (index: number): void => {
    if (busy || !view) return;
    setPhase({ kind: 'ready', view, preparing: true });
    setPicked(index);
    setOption(null);
    api.rewindPrepare(sessionId, index).then(
      (res) => {
        setPhase({ kind: 'options', view, ...res });
        setOption(res.options.find((o) => o.selected && !o.cancel)?.label ?? null);
      },
      (e: unknown) => setPhase({ kind: 'error', message: errorText(e) }),
    );
  };

  const commit = (): void => {
    if (!option || busy) return;
    void fb.run(
      'rewindCommit',
      async () => {
        const res = await api.rewindCommit(sessionId, option);
        settled.current = true;
        show('success', res.cleared ? t('tasks.rewindDoneCleared') : t('tasks.rewindDone'));
        // 回退那一刻转录零写入，气泡的「已回退」标记要等下一条消息落盘才读得到
        show('info', t('tasks.rewindNotice'));
        onDone(res.prompt, res.cleared);
      },
      { fail: (e) => t('tasks.rewindFailed', { error: errorText(e) }) },
    );
  };

  const picks = phase.kind === 'options' ? phase.options.filter((o) => !o.cancel) : [];

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={close}
    >
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-edge/[0.08] bg-neutral-900 p-3 shadow-mac"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-1">
          <p className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-neutral-200">
            <RotateCcw className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            {t('tasks.rewindTitle')}
          </p>
          <Tooltip label={t('tasks.messagesClose')} side="top">
            <button
              type="button"
              aria-label={t('tasks.messagesClose')}
              onClick={close}
              className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
        <p className="pb-2 text-11 leading-relaxed text-neutral-500">{t('tasks.rewindHint')}</p>

        {phase.kind === 'opening' && (
          <p className="flex items-center justify-center gap-1.5 py-8 text-11 text-neutral-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('tasks.rewindOpening')}
          </p>
        )}

        {phase.kind === 'error' && (
          <p className="rounded border border-amber-500/20 bg-amber-950/20 px-2 py-2 text-11 leading-relaxed text-amber-300">
            {phase.message}
          </p>
        )}

        {view && (
          <>
            {view.moreAbove > 0 && (
              <p className="pb-1 text-10 text-neutral-600">
                {t('tasks.rewindMoreAbove', { n: view.moreAbove })}
              </p>
            )}
            <ul className="max-h-64 min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-lg border border-edge/[0.06] bg-edge/[0.02] p-1">
              {view.items.map((item) => {
                const selectable = item.text !== null;
                const on = picked === item.index;
                return (
                  <li key={item.index}>
                    <button
                      type="button"
                      disabled={!selectable || busy || phase.kind === 'options'}
                      aria-pressed={on}
                      onClick={() => pick(item.index)}
                      className={cn(
                        'flex w-full items-baseline gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors',
                        on ? 'bg-amber-500/[0.12] text-neutral-100' : 'text-neutral-300',
                        selectable && !on && 'hover:bg-edge/[0.06]',
                        !selectable && 'cursor-default text-neutral-600',
                      )}
                    >
                      <span className="shrink-0 text-10 text-neutral-600">{item.index + 1}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {item.text ?? t('tasks.rewindCurrent')}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {view.moreBelow > 0 && (
              <p className="pt-1 text-10 text-neutral-600">
                {t('tasks.rewindMoreBelow', { n: view.moreBelow })}
              </p>
            )}

            {phase.kind === 'ready' && phase.preparing && (
              <p className="flex items-center gap-1.5 pt-2 text-11 text-neutral-500">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('tasks.rewindPreparing')}
              </p>
            )}

            {phase.kind === 'options' && (
              <>
                <p className="pt-2 text-10 leading-relaxed text-neutral-500">
                  {t('tasks.rewindOption')}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {picks.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      disabled={busy}
                      aria-pressed={option === o.label}
                      onClick={() => setOption(o.label)}
                      className={cn(
                        'rounded border px-2 py-0.5 text-11 transition-colors disabled:opacity-40',
                        option === o.label
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                          : 'border-edge/[0.1] text-neutral-300 hover:border-edge/20',
                      )}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={close}
                className="rounded border border-edge/[0.1] px-2 py-1 text-11 text-neutral-400 transition-colors hover:border-edge/20 hover:text-neutral-200"
              >
                {t('tasks.convCancel')}
              </button>
              <button
                type="button"
                disabled={phase.kind !== 'options' || !option || busy}
                onClick={commit}
                className="inline-flex items-center gap-1 rounded bg-amber-700/80 px-2.5 py-1 text-11 font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-40"
              >
                {t('tasks.rewindConfirm')}
                {fb.stateOf('rewindCommit') === 'loading' && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
              </button>
            </div>
          </>
        )}

        {phase.kind === 'error' && (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={close}
              className="rounded border border-edge/[0.1] px-2 py-1 text-11 text-neutral-300 transition-colors hover:border-edge/20"
            >
              {t('tasks.messagesClose')}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
