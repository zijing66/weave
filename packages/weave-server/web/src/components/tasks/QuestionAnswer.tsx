import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, X } from 'lucide-react';
import type {
  AnswerPick,
  PendingQuestion,
  PendingQuestionEntry,
  PendingQuestionOption,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';

/**
 * 阻塞问答作答弹窗：会话被 AskUserQuestion / 计划确认 / 权限确认挂起时的远程
 * 作答面。选项行 = 终端模态框的数字键（web 只传下标与文本，键序由服务端按
 * harness 规格拼装并白名单校验）；问题/选项文案保留原文——弹窗里显示的就是
 * 终端里那个模态框将发生的事。
 *
 * 三种形态都由面自己决定：
 * - **表单形态**（`questions ≥ 2 || 任一问多选`，宿主模态框就是多 tab + 收尾屏）：
 *   逐问单选/多选，底部按收尾屏的选项（宿主原文「Submit answers」「Cancel」）
 *   一次性提交整 call。
 * - **单击即答**（单问单选，宿主自己也按数字即提交）：点行立即作答。
 * - **预览形态**（`previewMode`，宿主换的左右分栏）：左选项 / 右预览 + `Notes:` 行，
 *   点选项只挪高亮（右栏随之切换，描述在这一形态里宿主不渲染、这里也不渲染），
 *   提交走收尾屏或底部的发送键。备注行是宿主 `n` 那行——填了备注才随选项一起发，
 *   只填备注不选选项也合法（宿主自己答成 `(notes only)`）。
 *
 * 弹窗尺寸：形态各有缺省（预览形态宽得多），桌面可拖右下角调整、按形态各记一份；
 * `<lg` 整屏单列（拖角不出现，移动端没有拖窗口这回事）。
 */

/** 弹窗尺寸（桌面拖角调整用；h = 0 = 高度随内容，上限由 max-h 兜）。 */
type PanelSize = { w: number; h: number };

const SIZE_DEFAULTS: Record<'plain' | 'preview', PanelSize> = {
  plain: { w: 448, h: 0 },
  preview: { w: 880, h: 560 },
};
const SIZE_MIN = { w: 320, h: 220 };

/** 上限 = 外层 p-4 之内（与 panel 的 `max-h-[calc(100dvh_-_2rem)]` 同源，否则拖出来的值被裁掉）。 */
const clampSize = (w: number, h: number): PanelSize => ({
  w: Math.min(Math.max(Math.round(w), SIZE_MIN.w), Math.max(SIZE_MIN.w + 40, innerWidth - 32)),
  h: h > 0 ? Math.min(Math.max(Math.round(h), SIZE_MIN.h), Math.max(SIZE_MIN.h + 40, innerHeight - 32)) : 0,
});

function loadSize(mode: 'plain' | 'preview'): PanelSize {
  try {
    const raw = JSON.parse(localStorage.getItem(`weave:answer-size:${mode}`) ?? 'null') as
      | PanelSize
      | null;
    if (!raw || typeof raw.w !== 'number' || typeof raw.h !== 'number') return SIZE_DEFAULTS[mode];
    return clampSize(raw.w, raw.h);
  } catch {
    return SIZE_DEFAULTS[mode];
  }
}

/**
 * 预览形态一问的作答下标：高亮选项 + （**填了备注才**带上备注行）；只填备注不选选项
 * 也合法（宿主自己答成 `(notes only)`）。null = 选项与备注都空 = 还没答。
 */
export function previewPickOf(
  options: PendingQuestionOption[],
  picked: number[],
  text: string,
): number[] | null {
  const chosen = picked.filter((i) => !options[i]?.input);
  const notes = options.findIndex((o) => o.input);
  const note = text.trim();
  if (chosen.length === 0) return note && notes >= 0 ? [notes] : null;
  return note && notes >= 0 ? [...chosen, notes] : chosen;
}

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
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  /** 表单形态下每问的勾选下标（键 = 问题键）。 */
  const [picks, setPicks] = useState<Record<string, number[]>>({});
  /** 自定义输入行的草稿（键 = 问题键）。 */
  const [texts, setTexts] = useState<Record<string, string>>({});
  /** 预览形态右栏展示的选项下标（悬停/点选过的；缺省 = 选中项或第一项）。 */
  const [previewed, setPreviewed] = useState<Record<string, number>>({});

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
  const anyPreview = questions.some((q) => q.previewMode);
  /** 一问的预览形态且整 call 只有它：右栏就该吃掉弹窗余下的高度（可拖高才不白拖）。 */
  const soloPreview = questions.length === 1 && questions[0]!.previewMode === true;

  const sizeMode: 'plain' | 'preview' = anyPreview ? 'preview' : 'plain';
  const [size, setSize] = useState<PanelSize>(() => loadSize(sizeMode));
  useEffect(() => setSize(loadSize(sizeMode)), [sizeMode]);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const grip = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const onGripDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const box = panelRef.current?.getBoundingClientRect();
    grip.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h || Math.round(box?.height ?? 0) };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onGripMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const g = grip.current;
    if (!g) return;
    setSize(clampSize(g.w + (e.clientX - g.x), g.h + (e.clientY - g.y)));
  };
  const onGripUp = (): void => {
    if (!grip.current) return;
    grip.current = null;
    setSize((s) => {
      localStorage.setItem(`weave:answer-size:${sizeMode}`, JSON.stringify(s));
      return s;
    });
  };

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

  /** 预览形态的一问作答 = 高亮选项（+ 填了备注才带上备注行）；只填备注也合法。 */
  const previewPick = (q: PendingQuestion): number[] | null =>
    previewPickOf(q.options, picks[q.key] ?? [], texts[q.key] ?? '');
  const pickOf = (q: PendingQuestion): number[] =>
    q.previewMode ? (previewPick(q) ?? []) : (picks[q.key] ?? []);

  /** 已作答的问（未作答的由服务端补 Tab 走过去）。 */
  const answered = (): AnswerPick[] =>
    questions
      .filter((q) => (q.previewMode ? previewPick(q) !== null : (picks[q.key] ?? []).length > 0))
      .map((q) => ({ questionKey: q.key, options: pickOf(q), text: texts[q.key] }));
  /** 未答完：无选项的 OPAQUE 面没有可答的行，不算未答。 */
  const unanswered = submitStep
    ? questions.filter((q) => {
        if (q.options.length === 0) return false;
        if (q.previewMode) return previewPick(q) === null;
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

  /** 预览形态的右栏行（左栏选项，尾行 none）。 */
  const previewOption = (q: PendingQuestion, i: number) => {
    const opt = q.options[i];
    return opt && !opt.input && !opt.chat ? opt : null;
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        style={isDesktop ? { width: size.w, height: size.h || undefined } : undefined}
        className={cn(
          'relative flex w-full flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-neutral-900 p-3 shadow-mac',
          // <lg 整屏单列（触屏没有拖窗口这回事）；桌面缺省宽 448 / 预览形态 880，高度可拖
          isDesktop ? 'max-h-[calc(100dvh_-_2rem)]' : 'h-[90dvh]',
        )}
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
          {anyPreview ? t('tasks.answerPickerHintPreview') : t('tasks.answerPickerHint')}
        </p>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {questions.map((q) => {
            const sel = picks[q.key] ?? [];
            const draft = texts[q.key] ?? '';
            const notesIdx = q.previewMode ? q.options.findIndex((o) => o.input) : -1;
            const chatIdx = q.previewMode ? q.options.findIndex((o) => o.chat) : -1;
            const notesOpt = notesIdx >= 0 ? q.options[notesIdx] : undefined;
            const previewIdx = previewed[q.key] ?? sel[0] ?? 0;
            return (
              <div
                key={q.key}
                className={cn(
                  'rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5',
                  soloPreview && 'flex min-h-0 flex-1 flex-col',
                )}
              >
                {q.header && (
                  <span className="mb-1 inline-block rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">
                    {q.header}
                  </span>
                )}
                <p className="text-xs leading-relaxed text-neutral-200">{q.question}</p>
                {/* 预览形态：左选项 / 右预览 + 备注行（宿主那一形态的真实布局） */}
                {q.previewMode && (
                  <>
                    <div
                      className={cn(
                        'mt-2 flex flex-col gap-2 lg:flex-row',
                        soloPreview && 'lg:min-h-0 lg:flex-1',
                      )}
                    >
                      <ul className="flex flex-col gap-1 lg:w-2/5 lg:shrink-0">
                        {q.options.map((opt, i) => {
                          if (!previewOption(q, i)) return null;
                          const active = previewIdx === i;
                          const chosen = sel.includes(i);
                          return (
                            <li key={i}>
                              <button
                                type="button"
                                disabled={busy}
                                onMouseEnter={() => setPreviewed((p) => ({ ...p, [q.key]: i }))}
                                onFocus={() => setPreviewed((p) => ({ ...p, [q.key]: i }))}
                                // 数字键在这一形态里只挪高亮，故点选项也只挪（提交另按）
                                onClick={() => toggle(q, i)}
                                className={cn(
                                  'flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors disabled:opacity-50',
                                  chosen
                                    ? 'border-blue-400/50 bg-blue-500/10'
                                    : active
                                      ? 'border-white/15 bg-white/[0.04]'
                                      : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]',
                                )}
                              >
                                <span className="w-2.5 shrink-0 text-neutral-500">
                                  {active ? '›' : ''}
                                </span>
                                <span className="shrink-0 text-[11px] text-neutral-500">
                                  {i + 1}.
                                </span>
                                <span
                                  className={cn(
                                    'min-w-0 flex-1 truncate text-xs',
                                    chosen ? 'text-blue-200' : 'text-neutral-200',
                                  )}
                                >
                                  {opt.label}
                                </span>
                                {chosen && <Check className="h-3 w-3 shrink-0 text-blue-300" />}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="flex min-w-0 flex-1 flex-col gap-1.5 lg:min-h-0">
                        <pre
                          className={cn(
                            'overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.06] bg-neutral-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-neutral-300',
                            // 单独一问的预览形态：右栏吃掉余下高度（拖高才不白拖）
                            soloPreview ? 'h-40 lg:min-h-0 lg:flex-1' : 'h-40 lg:h-60',
                          )}
                        >
                          {q.options[previewIdx]?.preview ?? ''}
                        </pre>
                        {notesOpt && (
                          <div className="flex items-center gap-1.5">
                            {/* 宿主这一行不编号、文案原文「Notes:」，未聚焦时提示按 n */}
                            <span className="shrink-0 text-[11px] text-neutral-400">
                              {notesOpt.label}
                            </span>
                            <input
                              value={draft}
                              disabled={busy}
                              placeholder={notesOpt.description ?? notesOpt.label}
                              onChange={(e) => {
                                const v = e.target.value;
                                setTexts((prev) => ({ ...prev, [q.key]: v }));
                              }}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter' || busy) return;
                                e.preventDefault();
                                // 单击即答形态：备注框的回车就是宿主的提交（表单形态走收尾屏）
                                const pick = previewPick(q);
                                if (!submitStep && pick) answer(q.key, pick, draft);
                              }}
                              className="min-w-0 flex-1 rounded border border-white/[0.08] bg-neutral-950 px-1.5 py-0.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-white/20 focus:outline-none disabled:opacity-50"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                    {chatIdx >= 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => answer(q.key, [chatIdx])}
                        className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-200 disabled:opacity-50"
                      >
                        <span className="w-2.5 shrink-0">·</span>
                        <span>{q.options[chatIdx]!.label}</span>
                        {busy && <Loader2 className="h-3 w-3 animate-spin text-blue-300" />}
                      </button>
                    )}
                    {/* 单击即答形态（整 call 只有这一问）没有收尾屏：提交靠这一键 */}
                    {!submitStep && (
                      <div className="mt-2 flex items-center justify-end gap-2 border-t border-white/[0.06] pt-2">
                        <button
                          type="button"
                          disabled={busy || previewPick(q) === null}
                          onClick={() => {
                            const pick = previewPick(q);
                            if (pick) answer(q.key, pick, draft);
                          }}
                          className="flex items-center gap-1 rounded bg-blue-700/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-600 disabled:opacity-40"
                        >
                          {t('tasks.answerSend')}
                          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                        </button>
                      </div>
                    )}
                  </>
                )}
                {/* 旧形态：无选项（OPAQUE 兜底）＝看得见阻塞、没有远程作答 */}
                {!q.previewMode && q.options.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {q.options.map((opt, i) => {
                      const chosen = sel.includes(i);
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
        {/* 拖角调大小（桌面专属：触屏整屏，没有拖窗口这回事） */}
        {isDesktop && (
          <div
            role="separator"
            title={t('app.resizeDialog')}
            aria-label={t('app.resizeDialog')}
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none"
          >
            <span className="pointer-events-none absolute bottom-1 right-1 h-2 w-2 rounded-br border-b border-r border-white/20" />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
