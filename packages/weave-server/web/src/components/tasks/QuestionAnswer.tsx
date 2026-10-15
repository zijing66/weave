import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, X } from 'lucide-react';
import type { AnswerPick, PendingQuestion, PendingQuestionEntry } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

/**
 * 阻塞问答作答弹窗：会话被 AskUserQuestion / 计划确认 / 权限确认挂起时的远程
 * 作答面。选项行 = 终端模态框的数字键（web 只传下标与文本，键序由服务端按
 * harness 规格拼装并白名单校验）；问题/选项文案保留原文——弹窗里显示的就是
 * 终端里那个模态框将发生的事。
 *
 * 两种形态由面自己决定（`submit` 收尾屏在场 = 整 call 一次提交）：
 * - **表单形态**（`questions ≥ 2 || 任一问多选`，宿主模态框就是多 tab + 收尾屏）：
 *   逐问单选/多选，底部按收尾屏的选项（宿主原文「Submit answers」「Cancel」）
 *   一次性提交整 call。
 * - **单击即答**（单问单选，宿主自己也按数字即提交）：点行立即作答。
 *
 * 宿主自有尾行（规格带 `input`/`chat`）：`input` = 「Other」自定义输入行，
 * 文本框（选中该行才随文本一起发；多选走位键由规格给）；`chat` = 「Chat about
 * this」，按下即结束整个提问回聊天。两者都是**终端里真有的行**，不是我们发明的。
 */
export function QuestionAnswer({
  label,
  entry,
  busy,
  onAnswer,
  onClose,
}: {
  /** 会话显示名（标题回退 id 短前缀）。 */
  label: string;
  /** 待答面（questions 随刷新更新；空 questions 的条目不会进来）。 */
  entry: PendingQuestionEntry;
  /** 整 call 作答在途（按钮转 loading，防连点重复键序）。 */
  busy: boolean;
  onAnswer: (answers: AnswerPick[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  /** 表单形态下每问的勾选下标（键 = 问题键）。 */
  const [picks, setPicks] = useState<Record<string, number[]>>({});
  /** 自定义输入行的草稿（键 = 问题键）。 */
  const [texts, setTexts] = useState<Record<string, string>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 收尾屏不是「第 n 个问题」，是整 call 的落定动作——单独渲染成底部按钮。
  const submitStep = entry.questions.find((q) => q.submit) ?? null;
  const questions = entry.questions.filter((q) => q !== submitStep);

  const toggle = (q: PendingQuestion, i: number): void => {
    if (busy) return;
    setPicks((prev) => {
      const sel = prev[q.key] ?? [];
      // 单选数字在宿主里自带推进，故选中即替换；多选只勾选、不推进。
      if (!q.multiSelect) return { ...prev, [q.key]: [i] };
      return { ...prev, [q.key]: sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i] };
    });
  };
  /** 输入行：点进去/打字即选中（幂等，不 toggle——多选里焦点进来不该反选掉）。 */
  const select = (q: PendingQuestion, i: number): void => {
    if (busy || !submitStep || (picks[q.key] ?? []).includes(i)) return;
    setPicks((prev) => ({
      ...prev,
      [q.key]: q.multiSelect ? [...(prev[q.key] ?? []), i] : [i],
    }));
  };

  /** 已作答的问（未作答的由服务端补 Tab 走过去）。 */
  const answered = (): AnswerPick[] =>
    questions
      .filter((q) => (picks[q.key] ?? []).length > 0)
      .map((q) => ({ questionKey: q.key, options: picks[q.key] ?? [], text: texts[q.key] }));
  /** 未答完：无选项的 OPAQUE 面没有可答的行，不算未答。 */
  const unanswered = submitStep
    ? questions.filter((q) => {
        if (q.options.length === 0) return false;
        const sel = picks[q.key] ?? [];
        if (sel.length === 0) return true;
        const input = q.options.findIndex((o) => o.input);
        return input >= 0 && sel.includes(input) && !(texts[q.key] ?? '').trim();
      })
    : [];
  /** 作答：`answers` 里同键后者覆盖前者（服务端按问题键取），故追加的 pick 生效。 */
  const answer = (questionKey: string, options: number[], text?: string): void => {
    if (busy) return;
    onAnswer([...answered(), { questionKey, options, text }]);
  };

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
          {questions.map((q) => {
            const sel = picks[q.key] ?? [];
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
                {/* 无选项（OPAQUE 兜底）：看得见阻塞、没有远程作答 */}
                {q.options.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {q.options.map((opt, i) => {
                      const chosen = sel.includes(i);
                      const draft = texts[q.key] ?? '';
                      const index = (
                        <span
                          className={cn(
                            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-semibold leading-none',
                            chosen
                              ? 'border-blue-400/40 bg-blue-500/15 text-blue-200'
                              : 'border-white/15 bg-neutral-950 text-neutral-300',
                          )}
                        >
                          {i + 1}
                        </span>
                      );
                      // 自定义输入行（宿主「Other」）：文本框；表单形态下选中该行才随文本一起发。
                      if (opt.input) {
                        return (
                          <li key={i}>
                            <div
                              onClick={() => select(q, i)}
                              className={cn(
                                'flex items-center gap-2 rounded-lg border px-2.5 py-1.5',
                                chosen
                                  ? 'border-blue-400/50 bg-blue-500/10'
                                  : 'border-white/[0.06] bg-white/[0.02]',
                              )}
                            >
                              {submitStep ? (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggle(q, i);
                                  }}
                                  aria-label={opt.label}
                                  className="shrink-0 disabled:opacity-50"
                                >
                                  {index}
                                </button>
                              ) : (
                                index
                              )}
                              <input
                                value={draft}
                                disabled={busy}
                                placeholder={opt.description ?? opt.label}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setTexts((prev) => ({ ...prev, [q.key]: v }));
                                  if (submitStep) select(q, i);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key !== 'Enter' || busy) return;
                                  e.preventDefault();
                                  // 单击即答形态：输入行自带发送键（规格给收尾键）
                                  if (!submitStep && draft.trim()) answer(q.key, [i], draft);
                                }}
                                className="min-w-0 flex-1 rounded border border-white/[0.08] bg-neutral-950 px-1.5 py-0.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-white/20 focus:outline-none disabled:opacity-50"
                              />
                              {!submitStep && (
                                <button
                                  type="button"
                                  disabled={busy || !draft.trim()}
                                  onClick={() => answer(q.key, [i], draft)}
                                  className="shrink-0 rounded bg-blue-700/80 px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-blue-600 disabled:opacity-40"
                                >
                                  {t('tasks.answerSend')}
                                </button>
                              )}
                              {busy && (
                                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-300" />
                              )}
                            </div>
                          </li>
                        );
                      }
                      return (
                        <li key={i}>
                          <button
                            type="button"
                            disabled={busy}
                            // 单击即答形态整行即提交；表单形态只有 chat 行走位
                            // （按下即结束整 call，服务端拼到该键即断），其余是勾选。
                            onClick={() =>
                              submitStep && !opt.chat ? toggle(q, i) : answer(q.key, [i])
                            }
                            className={cn(
                              'flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors disabled:opacity-50',
                              chosen
                                ? 'border-blue-400/50 bg-blue-500/10'
                                : 'border-white/[0.06] bg-white/[0.02] hover:border-blue-400/40 hover:bg-blue-500/10',
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
                            {(chosen || busy) && (
                              <span className="mt-0.5 flex shrink-0 items-center gap-1">
                                {chosen && !opt.chat && (
                                  <Check className="h-3 w-3 text-blue-300" />
                                )}
                                {busy && (
                                  <Loader2 className="h-3 w-3 animate-spin text-blue-300" />
                                )}
                              </span>
                            )}
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
        {/* 收尾屏（宿主原文按钮：提交答案 / 取消）——不是问题 tab，是整 call 的动作。 */}
        {submitStep && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2">
            {unanswered.length > 0 && (
              <span className="min-w-0 flex-1 text-[10px] leading-relaxed text-amber-300/80">
                {t('tasks.answerIncomplete', { n: unanswered.length })}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {submitStep.options.map((opt, i) => (
                <button
                  key={i}
                  type="button"
                  // 首行 = 「Submit answers」（未答完禁用）；其余 = 取消一类收尾动作。
                  disabled={busy || (i === 0 && unanswered.length > 0)}
                  onClick={() => answer(submitStep.key, [i])}
                  className={cn(
                    'flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40',
                    i === 0
                      ? 'bg-blue-700/80 text-white hover:bg-blue-600'
                      : 'border border-white/[0.08] bg-white/[0.02] text-neutral-300 hover:bg-white/[0.08]',
                  )}
                >
                  {opt.label}
                  {busy && i === 0 && <Loader2 className="h-3 w-3 animate-spin" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
