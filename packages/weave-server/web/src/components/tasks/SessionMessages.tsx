import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Send, X } from 'lucide-react';
import { api, type MessagingCapability, type SessionMessageRow } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { formatTime, sessionLabel } from '@/lib/hook-payload';
import type { HookFrame } from './session-status-store';

/** 消息状态徽标（queued/injected 在途 = 冷色，succeeded = 绿，failed/timeout = 红）。 */
const STATUS_BADGE: Record<SessionMessageRow['status'], string> = {
  queued: 'bg-amber-900/40 text-amber-300',
  injected: 'bg-sky-900/40 text-sky-300',
  running: 'bg-sky-900/40 text-sky-300',
  succeeded: 'bg-emerald-900/40 text-emerald-300',
  failed: 'bg-red-900/40 text-red-300',
  timeout: 'bg-red-900/40 text-red-300',
};
const STATUS_KEY: Record<
  SessionMessageRow['status'],
  | 'tasks.msgStatusQueued'
  | 'tasks.msgStatusInjected'
  | 'tasks.msgStatusRunning'
  | 'tasks.msgStatusSucceeded'
  | 'tasks.msgStatusFailed'
  | 'tasks.msgStatusTimeout'
> = {
  queued: 'tasks.msgStatusQueued',
  injected: 'tasks.msgStatusInjected',
  running: 'tasks.msgStatusRunning',
  succeeded: 'tasks.msgStatusSucceeded',
  failed: 'tasks.msgStatusFailed',
  timeout: 'tasks.msgStatusTimeout',
};
const FROM_KEY: Record<
  SessionMessageRow['fromKind'],
  'tasks.msgFromDashboard' | 'tasks.msgFromSession' | 'tasks.msgFromCli'
> = {
  dashboard: 'tasks.msgFromDashboard',
  session: 'tasks.msgFromSession',
  cli: 'tasks.msgFromCli',
};
const MODE_KEY: Record<
  SessionMessageRow['mode'],
  'tasks.msgModeAuto' | 'tasks.msgModeInject' | 'tasks.msgModeHeadless'
> = {
  auto: 'tasks.msgModeAuto',
  inject: 'tasks.msgModeInject',
  headless: 'tasks.msgModeHeadless',
};

/**
 * 会话消息线程弹窗（session-orchestration 批 1）：双向时间线（该会话收到的
 * 靠右、它自己发出的靠左）+ 投递Composer。模式选项按能力矩阵门控（表驱动，
 * web 不写死 harness）；线程刷新挂 App 转发的 weave:hook 帧（kind=message.*、
 * sessionId 定向），不新开轮询。
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
  // 缺省 inject：开着的会话下一拍注入，未开的入队、随其下次 SessionStart 加载
  // （inject 不支持的面回 auto——选项本身按能力门控，auto 恒在）。
  const [mode, setMode] = useState<'auto' | 'inject' | 'headless'>(
    capability.inject ? 'inject' : 'auto',
  );
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
        await api.sendSessionMessage(sessionId, { text, mode });
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

        {/* 线程主体：该会话收到的靠右（含控制台与其他会话的投递），它发出的靠左 */}
        <div ref={threadRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {messages === null ? (
            <p className="flex items-center justify-center gap-1.5 pt-6 text-xs text-neutral-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('hooks.loading')}
            </p>
          ) : messages.length === 0 ? (
            <p className="pt-6 text-center text-xs text-neutral-600">
              {t('tasks.messagesEmpty')}
            </p>
          ) : (
            messages.map((m) => {
              const outgoing = m.fromSessionId === sessionId;
              return (
                <div key={m.id} className={outgoing ? 'flex' : 'flex justify-end'}>
                  <div
                    className={`max-w-[85%] rounded-lg border px-2 py-1.5 ${
                      outgoing
                        ? 'border-white/[0.06] bg-white/[0.02]'
                        : 'border-blue-500/20 bg-blue-500/[0.06]'
                    }`}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <Badge className="shrink-0 bg-neutral-800 text-neutral-400">
                        {outgoing
                          ? t('tasks.msgFromSelf')
                          : m.fromKind === 'session' && m.fromSessionId
                            ? t('tasks.msgFromSessionId', {
                                id: sessionLabel(null, m.fromSessionId),
                              })
                            : t(FROM_KEY[m.fromKind])}
                      </Badge>
                      <Badge className={cn('shrink-0', STATUS_BADGE[m.status])}>
                        {t(STATUS_KEY[m.status])}
                      </Badge>
                      <span className="shrink-0 text-[10px] text-neutral-600">
                        {t(MODE_KEY[m.mode])} · {formatTime(m.createdAt)}
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
                  </div>
                </div>
              );
            })
          )}
        </div>

        {error && (
          <p className="mt-1 shrink-0 rounded border border-red-500/30 bg-red-950/30 px-2 py-1 text-[11px] text-red-300">
            {error}
          </p>
        )}

        {/* Composer：模式选项按能力矩阵门控（表驱动，不写死 harness）。
            <lg 纵排——输入框满宽在上、模式+发送一行在下（横排会被选择器挤窄），
            桌面横排原样。 */}
        <div className="mt-2 flex shrink-0 flex-col gap-2 lg:flex-row lg:items-end">
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
            className="min-w-0 w-full resize-none rounded border border-white/[0.1] bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 focus:outline-none focus:border-blue-500/40 lg:w-auto lg:flex-1"
          />
          <div className="flex gap-1.5 lg:shrink-0 lg:flex-col lg:gap-1">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
              className="min-w-0 flex-1 rounded border border-white/[0.08] bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-200 lg:flex-none"
            >
              <option value="auto">{t('tasks.msgModeAutoHint')}</option>
              {capability.inject && (
                <option value="inject">{t('tasks.msgModeInjectHint')}</option>
              )}
              {capability.headless && (
                <option value="headless">{t('tasks.msgModeHeadlessHint')}</option>
              )}
            </select>
            <button
              type="button"
              disabled={!draft.trim() || fb.stateOf(`sendMsg:${sessionId}`) === 'loading'}
              onClick={send}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded bg-blue-600/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40 lg:flex-none"
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
      </div>
    </div>,
    document.body,
  );
}
