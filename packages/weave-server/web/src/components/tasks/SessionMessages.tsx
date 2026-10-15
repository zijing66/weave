import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, RotateCcw, Send, X } from 'lucide-react';
import { api, type MessagingCapability, type SessionMessageRow } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { formatTime } from '@/lib/hook-payload';
import type { HookFrame } from './session-status-store';

/** 终态驻留窗口（mirror 服务端 VISIBLE_TTL_MS）：settledAt 过窗即从线程隐藏。 */
const SETTLED_VISIBLE_MS = 60_000;

/** 驻留判定：暂停闸成因 / failed·timeout 常驻（可重发/告警），其余终态看窗口。 */
const settledVisible = (m: SessionMessageRow): boolean => {
  if (m.stalled === true) return true;
  if (m.status === 'failed' || m.status === 'timeout') return true;
  if (!m.settledAt) return true;
  return Date.now() - Date.parse(m.settledAt) < SETTLED_VISIBLE_MS;
};

/** prompt 通道实际落法的展示键（socket 直投 / 中继 / 终端 send-text）。 */
const VIA_KEY: Record<
  NonNullable<SessionMessageRow['via']>,
  'tasks.msgViaSocket' | 'tasks.msgViaRelay' | 'tasks.msgViaTerminal'
> = {
  socket: 'tasks.msgViaSocket',
  relay: 'tasks.msgViaRelay',
  terminal: 'tasks.msgViaTerminal',
};

/** 消息状态徽标（在途 = 冷色，终态 = 绿/红）。 */
const STATUS_BADGE: Record<SessionMessageRow['status'], string> = {
  pending: 'bg-amber-900/40 text-amber-300',
  delivering: 'bg-sky-900/40 text-sky-300',
  running: 'bg-sky-900/40 text-sky-300',
  injected: 'bg-sky-900/40 text-sky-300',
  delivered: 'bg-emerald-900/40 text-emerald-300',
  succeeded: 'bg-emerald-900/40 text-emerald-300',
  failed: 'bg-red-900/40 text-red-300',
  timeout: 'bg-red-900/40 text-red-300',
};
const STATUS_KEY: Record<
  SessionMessageRow['status'],
  | 'tasks.msgStatusQueued'
  | 'tasks.msgStatusDelivering'
  | 'tasks.msgStatusRunning'
  | 'tasks.msgStatusInjected'
  | 'tasks.msgStatusDelivered'
  | 'tasks.msgStatusSucceeded'
  | 'tasks.msgStatusFailed'
  | 'tasks.msgStatusTimeout'
> = {
  pending: 'tasks.msgStatusQueued',
  delivering: 'tasks.msgStatusDelivering',
  running: 'tasks.msgStatusRunning',
  injected: 'tasks.msgStatusInjected',
  delivered: 'tasks.msgStatusDelivered',
  succeeded: 'tasks.msgStatusSucceeded',
  failed: 'tasks.msgStatusFailed',
  timeout: 'tasks.msgStatusTimeout',
};

/**
 * 会话消息弹窗（消息域重塑批 ③）：该会话的在途投递视图 + Composer。
 * 投递无模式选择——服务端恒走 prompt 通道全自动（原生 SendMessage 中继 →
 * 终端 send-text 降级 → 未开会话积压队列），故 web 不展示也不传 mode。
 * 终态短时驻留（60s）展示 via/回执；未回执超窗或投递失败会暂停该会话队列，
 * 成因行常驻并给「重发」按钮（解闸动作）。
 * 刷新挂 App 转发的 weave:hook 帧（kind=message.*、sessionId 定向），不新开轮询。
 */
export function SessionMessages({
  sessionId,
  label,
  capability,
  onClose,
}: {
  sessionId: string;
  /** 会话显示名（title 回退 sessionId 前 8 位，调用方已解好）。 */
  label: string;
  /** 该会话 harness 的能力行（TasksPanel 从能力矩阵按 harness 取）。 */
  capability: MessagingCapability;
  onClose: () => void;
}) {
  const t = useT();
  const fb = useActionFeedback();
  const [messages, setMessages] = useState<SessionMessageRow[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setMessages(await api.listSessionMessages(sessionId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // SSE：message.* 帧定向刷新本线程（created 入列 / delivered·finished 状态翻转）
  useEffect(() => {
    let timer: number | null = null;
    const onHook = (e: Event): void => {
      const f = (e as CustomEvent<HookFrame>).detail ?? {};
      if (!f.kind?.startsWith('message.') || f.sessionId !== sessionId) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, 500);
    };
    window.addEventListener('weave:hook', onHook);
    return () => {
      window.removeEventListener('weave:hook', onHook);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refresh, sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 驻留窗口到点自动隐藏（服务端同口径过滤；这里只管两次重拉之间的本地
  // 一次性重渲染——到最近一条过期时刻触发，不是数据轮询）。
  const [, forceRerender] = useReducer((v: number) => v + 1, 0);
  useEffect(() => {
    if (!messages) return;
    const now = Date.now();
    const upcoming = messages
      .filter((m) => m.settledAt && settledVisible(m))
      .map((m) => Date.parse(m.settledAt!) + SETTLED_VISIBLE_MS)
      .filter((t) => t > now);
    if (upcoming.length === 0) return;
    const timer = window.setTimeout(forceRerender, Math.min(...upcoming) - now);
    return () => window.clearTimeout(timer);
  }, [messages]);

  // 新消息进线程后贴底（用户没往上翻历史时不抢滚动位置）
  const atBottom = (): boolean => {
    const el = threadRef.current;
    return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
  };
  const prevCount = useRef(0);
  useEffect(() => {
    if (!messages || messages.length <= prevCount.current) return;
    if (prevCount.current === 0 || atBottom()) {
      const el = threadRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    prevCount.current = messages.length;
  }, [messages]);

  const send = (): void => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void fb.run(
      `sendMsg:${sessionId}`,
      async () => {
        await api.sendSessionMessage(sessionId, { text });
        await refresh();
      },
      { fail: (e) => t('tasks.msgSendFailed', { error: errorText(e) }) },
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[70dvh] max-lg:h-[88dvh] w-full max-w-lg flex-col rounded-xl border border-white/[0.08] bg-neutral-900 p-3 shadow-mac"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-2">
          <p className="min-w-0 truncate text-xs font-medium text-neutral-200">
            {t('tasks.messagesTitle')} · {label}
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

        {/* 在途视图：每行都是投给本会话的消息（终态短时驻留展示 via/回执，
            过窗隐藏；历史在会话自己的转录里） */}
        <div ref={threadRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {messages === null ? (
            <p className="flex items-center justify-center gap-1.5 pt-6 text-xs text-neutral-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('hooks.loading')}
            </p>
          ) : messages.filter(settledVisible).length === 0 ? (
            <p className="pt-6 text-center text-xs text-neutral-600">
              {t('tasks.messagesEmpty')}
            </p>
          ) : (
            messages.filter(settledVisible).map((m) => (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-lg border border-blue-500/20 bg-blue-500/[0.06] px-2 py-1.5">
                  <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <Badge
                      title={m.status === 'delivered' ? t('tasks.msgDeliveredHint') : undefined}
                      className={cn('shrink-0', STATUS_BADGE[m.status])}
                    >
                      {t(STATUS_KEY[m.status])}
                    </Badge>
                    {m.via && (
                      <span className="shrink-0 text-[10px] text-neutral-500">
                        {t(VIA_KEY[m.via])}
                      </span>
                    )}
                    {m.acked === true && (
                      <span className="shrink-0 text-[10px] text-emerald-400">
                        {t('tasks.msgAcked')}
                      </span>
                    )}
                    {m.stalled === true && (
                      <span className="shrink-0 text-[10px] text-amber-400">
                        {t('tasks.msgStalled')}
                      </span>
                    )}
                    <span className="shrink-0 text-[10px] text-neutral-600">
                      {formatTime(m.at)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-xs text-neutral-200">
                    {m.text}
                  </p>
                  {m.error && (
                    <p className="mt-1 break-words text-[11px] text-red-400">{m.error}</p>
                  )}
                  {m.output && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[10px] text-neutral-500">
                        {t('tasks.msgOutput')}
                      </summary>
                      <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-neutral-950 px-1.5 py-1 text-[10px] text-neutral-400">
                        {m.output}
                      </pre>
                    </details>
                  )}
                  {(m.status === 'failed' || m.stalled === true) && (
                    <button
                      type="button"
                      disabled={fb.stateOf(`resend:${m.id}`) === 'loading'}
                      onClick={() =>
                        void fb.run(
                          `resend:${m.id}`,
                          async () => {
                            await api.resendSessionMessage(sessionId, m.id);
                            await refresh();
                          },
                          { fail: (e) => t('tasks.msgResendFailed', { error: errorText(e) }) },
                        )
                      }
                      className="mt-1 inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-950/30 px-1.5 py-0.5 text-[10px] text-amber-300 transition-colors hover:border-amber-500/50 disabled:opacity-40"
                    >
                      <FeedbackIcon
                        state={fb.stateOf(`resend:${m.id}`)}
                        className="h-3 w-3"
                        icon={<RotateCcw className="h-3 w-3" />}
                      />
                      {t('tasks.msgResend')}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {error && (
          <p className="mt-1 shrink-0 rounded border border-red-500/30 bg-red-950/30 px-2 py-1 text-[11px] text-red-300">
            {error}
          </p>
        )}

        {/* Composer：无模式选择（服务端恒 prompt 通道全自动）；层①② 皆无的
            harness 才置灰，理由取能力矩阵 unsupportedReasons.prompt。 */}
        <div className="mt-2 flex shrink-0 items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={t('tasks.messagesPlaceholder')}
            rows={2}
            className="min-w-0 flex-1 resize-none rounded border border-white/[0.1] bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 focus:outline-none focus:border-blue-500/40"
          />
          <button
            type="button"
            disabled={
              !capability.prompt ||
              !draft.trim() ||
              fb.stateOf(`sendMsg:${sessionId}`) === 'loading'
            }
            title={
              capability.prompt
                ? undefined
                : (capability.unsupportedReasons?.prompt ?? t('tasks.msgUnsupported'))
            }
            onClick={send}
            className="inline-flex shrink-0 items-center justify-center gap-1 rounded bg-blue-600/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40"
          >
            <FeedbackIcon
              state={fb.stateOf(`sendMsg:${sessionId}`)}
              className="h-3 w-3"
              icon={<Send className="h-3 w-3" />}
            />
            {t('tasks.messagesSend')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
