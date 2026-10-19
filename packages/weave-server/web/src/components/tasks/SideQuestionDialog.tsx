import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, MessageCircleQuestion, X } from 'lucide-react';
import { api, type SideQuestionRow } from '@/lib/api';
import { subscribeHook } from '@/lib/sse';
import { usePullLoad } from '@/lib/pull-load';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

/** 一页多少条（历史很短，10 条够一次翻到底）。 */
const PAGE = 10;

const stamp = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 旁路会话（claude = `/btw`）：问一句不打扰主回合的话，回答只落在这里。
 *
 * 为什么得有这扇弹窗：宿主的侧问开着 `skipTranscript`——问题与回答**都不落
 * 任何文件**，宿主面板的历史也只在它自己的内存里。所以 weave 发出去的问句由
 * 自己记（服务端 `side_questions`），回答由之后那条采集事件认领回来。
 *
 * 发送恒走层② 终端击键（旁路只活在 TUI 里），服务端只收「用户的原文」——
 * 命令文法归 harness 能力面。
 */
export function SideQuestionDialog({
  sessionId,
  label,
  onClose,
}: {
  sessionId: string;
  /** 会话显示名（标题回退 id 短前缀）。 */
  label: string;
  onClose: () => void;
}) {
  const t = useT();
  const fb = useActionFeedback();
  /** 已加载的行（**倒序**：与接口同序，渲染时反转成对话序）。 */
  const [rows, setRows] = useState<SideQuestionRow[] | null>(null);
  const [headDone, setHeadDone] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [draft, setDraft] = useState('');
  const threadRef = useRef<HTMLDivElement | null>(null);

  /** 合并一页（按 id 去重、新页覆盖旧页——同一条的 status 会从 pending 变 answered）。 */
  const merge = useCallback((page: SideQuestionRow[]): void => {
    setRows((prev) => {
      const byId = new Map<number, SideQuestionRow>();
      for (const r of prev ?? []) byId.set(r.id, r);
      for (const r of page) byId.set(r.id, r);
      return [...byId.values()].sort((a, b) => b.id - a.id);
    });
  }, []);

  /** 最新一页（打开时与收到认领帧时都走它）。 */
  const reload = useCallback(async (): Promise<void> => {
    const page = await api.listSideQuestions(sessionId, { limit: PAGE });
    merge(page);
    setHeadDone(page.length < PAGE);
  }, [sessionId, merge]);

  useEffect(() => {
    let alive = true;
    reload().catch(() => {
      // 首屏失败：留空表（发送仍可用），错误在发送路径上报
      if (alive) setRows([]);
    });
    return () => {
      alive = false;
    };
  }, [reload]);

  // 认领 = 一次转场（旁路回答到账）：重拉最新一页即可，不做增量协议
  useEffect(
    () =>
      subscribeHook(
        (frame) => {
          if (frame.sessionId === sessionId) void reload().catch(() => {});
        },
        ['sideQuestion.answered'],
      ),
    [sessionId, reload],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 取更早一页（拉动触发；贴顶不动不取）。 */
  const loadEarlier = async (): Promise<void> => {
    const oldest = rows?.[rows.length - 1];
    if (!oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await api.listSideQuestions(sessionId, { beforeId: oldest.id, limit: PAGE });
      merge(page);
      setHeadDone(page.length < PAGE);
    } catch {
      // 翻了没翻到不算错（下次拉动再试）
    } finally {
      setLoadingEarlier(false);
    }
  };
  const pull = usePullLoad({
    axis: 'top',
    getEdge: () => (threadRef.current?.scrollTop ?? 1) <= 1,
    onFire: () => void loadEarlier(),
    enabled: rows !== null && !headDone && !loadingEarlier,
  });

  const thread = rows === null ? null : [...rows].reverse();
  const tailKey = thread && thread.length > 0 ? String(thread[thread.length - 1]!.id) : undefined;
  const lastTail = useRef<string | undefined>(undefined);
  // 新行（刚发出去 / 刚认领到）贴底；翻更早时不动视线
  useLayoutEffect(() => {
    if (tailKey === undefined || tailKey === lastTail.current) return;
    lastTail.current = tailKey;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tailKey]);

  const busy = fb.stateOf('sideAsk') === 'loading';
  const send = (): void => {
    const question = draft.trim();
    if (!question || busy) return;
    void fb.run(
      'sideAsk',
      async () => {
        const { sideQuestion } = await api.askSideQuestion(sessionId, question);
        merge([sideQuestion]);
        setDraft('');
      },
      { fail: (e) => t('tasks.sideFailed', { error: errorText(e) }) },
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[50] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          'relative flex w-full flex-col overflow-hidden rounded-xl border border-edge/[0.08] bg-neutral-900 p-3 shadow-mac',
          // <lg 整屏单列（与作答弹窗同口径：移动端没有拖窗口这回事）
          'max-h-[calc(100dvh_-_2rem)] lg:h-[32rem] lg:w-[36rem] max-lg:h-[90dvh]',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-2">
          <p className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-neutral-200">
            <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-violet-400" />
            {t('tasks.sideTitle')} · {label}
          </p>
          <button
            type="button"
            title={t('tasks.messagesClose')}
            aria-label={t('tasks.messagesClose')}
            onClick={onClose}
            className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="pb-2 text-[11px] leading-relaxed text-neutral-500">{t('tasks.sideHint')}</p>

        <div
          ref={threadRef}
          onScroll={pull.syncEdge}
          onWheel={(e) => pull.wheel(e.deltaY, e.deltaMode)}
          onTouchStart={(e) => pull.touchStart(e.touches[0]?.clientY ?? 0)}
          onTouchMove={(e) => pull.touchMove(e.touches[0]?.clientY ?? 0)}
          onTouchEnd={pull.touchEnd}
          onTouchCancel={pull.touchEnd}
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-lg border border-edge/[0.06] bg-edge/[0.02] p-2"
        >
          {pull.px > 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 top-0 flex justify-center text-[10px] text-neutral-500"
              style={{ transform: `translateY(${pull.px}px)` }}
            >
              {loadingEarlier ? t('tasks.sideLoading') : t('tasks.sidePullOlder')}
            </div>
          )}
          {thread === null ? (
            <p className="py-6 text-center text-[11px] text-neutral-500">{t('tasks.sideLoading')}</p>
          ) : thread.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-neutral-500">{t('tasks.sideEmpty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {thread.map((row) => (
                <li key={row.id} className="flex flex-col gap-1">
                  <div className="flex items-start gap-1.5">
                    <span className="mt-1 shrink-0 text-[10px] text-neutral-600">
                      {stamp(row.askedAt)}
                    </span>
                    <p className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded-lg bg-edge/[0.04] px-2 py-1 text-xs text-neutral-200">
                      {row.question}
                    </p>
                  </div>
                  {row.status === 'answered' ? (
                    <p className="whitespace-pre-wrap break-words rounded-lg border border-violet-400/20 bg-violet-500/[0.06] px-2 py-1 text-xs leading-relaxed text-neutral-300">
                      {row.answer}
                    </p>
                  ) : (
                    <p
                      className={cn(
                        'flex items-center gap-1 px-2 text-[11px]',
                        row.status === 'pending' ? 'text-neutral-500' : 'text-amber-300/80',
                      )}
                    >
                      {row.status === 'pending' && <Loader2 className="h-3 w-3 animate-spin" />}
                      {row.status === 'pending' ? t('tasks.sidePending') : t('tasks.sideTimeout')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-2 flex shrink-0 items-center gap-2">
          <input
            value={draft}
            disabled={busy}
            placeholder={t('tasks.sidePlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              send();
            }}
            className="min-w-0 flex-1 rounded border border-edge/[0.08] bg-neutral-950 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-edge/20 focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={send}
            className="flex shrink-0 items-center gap-1 rounded bg-violet-700/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-violet-600 disabled:opacity-40"
          >
            {t('tasks.answerSend')}
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
