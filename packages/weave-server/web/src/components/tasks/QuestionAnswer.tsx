import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
import type { PendingQuestionEntry } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

/**
 * 阻塞问答作答弹窗：会话被 AskUserQuestion / 计划确认 / 权限确认挂起时的远程
 * 作答面。选项按钮 = 终端模态框的数字快捷键（web 只传下标，键序由服务端
 * harness 规格拼装并白名单校验）；问题/选项文案保留原文——弹窗里显示的就是
 * 终端里那个模态框将发生的事。多选问题每次作答提交一个选项（键序白名单的
 * 口径，v1 诚实展示）。
 *
 * 宿主自有尾行（规格带 `input`/`chat`）：`input` = 「Other」自定义输入行，
 * 文本框 + 发送（键序 = 选中该行 + 文本 + CR）；`chat` = 「Chat about this」，
 * 按数字即结束整个提问回聊天。两者都是**终端里真有的行**，不是我们发明的。
 */
export function QuestionAnswer({
  label,
  entry,
  busyKey,
  onAnswer,
  onClose,
}: {
  /** 会话显示名（标题回退 id 短前缀）。 */
  label: string;
  /** 待答面（questions 随刷新更新；空 questions 的条目不会进来）。 */
  entry: PendingQuestionEntry;
  /** 正在作答的问题键（该问题的选项按钮转 loading，防连点重复键序）。 */
  busyKey: string | null;
  onAnswer: (questionKey: string, optionIndex: number, text?: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  /** 自定义输入行的草稿（键 = `问题键#下标`）。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

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
        className="flex max-h-[80dvh] w-full max-w-md flex-col rounded-xl border border-white/[0.08] bg-neutral-900 p-3 shadow-mac"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-2">
          <p className="min-w-0 truncate text-xs font-medium text-neutral-200">
            {t('tasks.answerPickerTitle')} · {label}
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
          {t('tasks.answerPickerHint')}
        </p>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {entry.questions.map((q) => {
            const busy = busyKey === q.key;
            return (
              <div
                key={q.key}
                className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5"
              >
                {q.header && (
                  <span className="mb-1 inline-block rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">
                    {q.header}
                  </span>
                )}
                <p className="text-xs leading-relaxed text-neutral-200">{q.question}</p>
                {q.multiSelect && (
                  <p className="mt-1 text-[10px] text-amber-300/80">
                    {t('tasks.answerMultiHint')}
                  </p>
                )}
                {/* 无选项（OPAQUE 兜底）：看得见阻塞、没有远程作答 */}
                {q.options.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {q.options.map((opt, i) => {
                      const draftKey = `${q.key}#${i}`;
                      const draft = drafts[draftKey] ?? '';
                      const index = (
                        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-white/15 bg-neutral-950 text-[10px] font-semibold leading-none text-neutral-300">
                          {i + 1}
                        </span>
                      );
                      // 自定义输入行（宿主「Other」）：文本框 + 发送。
                      if (opt.input) {
                        return (
                          <li key={i}>
                            <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5">
                              {index}
                              <input
                                value={draft}
                                disabled={busy}
                                placeholder={opt.description ?? opt.label}
                                onChange={(e) =>
                                  setDrafts((prev) => ({ ...prev, [draftKey]: e.target.value }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key !== 'Enter' || busy) return;
                                  e.preventDefault();
                                  if (draft.trim()) onAnswer(q.key, i, draft);
                                }}
                                className="min-w-0 flex-1 rounded border border-white/[0.08] bg-neutral-950 px-1.5 py-0.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-white/20 focus:outline-none disabled:opacity-50"
                              />
                              <button
                                type="button"
                                disabled={busy || !draft.trim()}
                                onClick={() => onAnswer(q.key, i, draft)}
                                className="shrink-0 rounded bg-blue-700/80 px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-blue-600 disabled:opacity-40"
                              >
                                {t('tasks.answerSend')}
                              </button>
                              {busy && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-300" />}
                            </div>
                          </li>
                        );
                      }
                      return (
                        <li key={i}>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onAnswer(q.key, i)}
                            className={cn(
                              'flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors disabled:opacity-50',
                              'border-white/[0.06] bg-white/[0.02] hover:border-blue-400/40 hover:bg-blue-500/10',
                            )}
                          >
                            {index}
                            <span className="min-w-0 flex-1">
                              <span className="block text-xs text-neutral-200">{opt.label}</span>
                              {opt.description && (
                                <span className="mt-0.5 block text-[10px] leading-relaxed text-neutral-500">
                                  {opt.description}
                                </span>
                              )}
                            </span>
                            {busy && <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-blue-300" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
