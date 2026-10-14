import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import { Bot, Send, Square, Trash2, X } from 'lucide-react';
import { aiStatus, streamChat, type AiChatMessage, type AiStatus } from '@/lib/ai';
import { errorText } from '@/lib/action-feedback';
import { useToast } from '@/components/Toast';
import { registerInvalidator } from '@/lib/sse';
import { useT } from '@/i18n/I18nProvider';

/**
 * 右下角 AI 助手浮层：**配置齐（地址 + 模型 + key）才出现按钮**，点开是与 weave
 * 资料对话的流式弹窗。系统上下文（功能文档 + 内置技能）由服务端注入，前端只发
 * 会话历史——密钥与资料都不经浏览器。
 *
 * 反馈口径：失败走 toast（不静默）；发送中按钮变「停止」（AbortController）——
 * 这是长动作而非一次性动作，故不用 useActionFeedback 的三态。
 */
/**
 * 助手回答的 Markdown 预览（**只认简单文本格式**）：标题 / 粗斜体 / 行内与围栏代码 /
 * 列表 / 引用 / 链接。刻意不挂 GFM 与代码高亮插件——窄气泡里表格、HTML、任务列表都
 * 读不动，简单格式反而清爽。
 *
 * **字号整体适配气泡**：不用仓内的 `prose`（typography 插件最小档是 prose-sm = 14px，
 * 比对话框正文 12px 大一圈，视觉上明显不配），改为手写紧凑样式——正文锁 `text-xs`、
 * 代码 11px、标题只比正文大半档，行内元素逐项收边距。链接强制新开页签：点一下不能
 * 把 dashboard 导航走。
 */
function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div
      className={
        'text-xs leading-relaxed text-neutral-200 ' +
        '[&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 ' +
        '[&_strong]:font-semibold [&_strong]:text-neutral-100 [&_em]:italic ' +
        '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 ' +
        '[&_code]:rounded [&_code]:bg-neutral-950/60 [&_code]:px-1 [&_code]:py-px [&_code]:text-[11px] [&_code]:text-neutral-300 ' +
        '[&_pre]:my-1.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:border-white/[0.06] [&_pre]:bg-neutral-950/60 [&_pre]:p-2 ' +
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[11px] ' +
        '[&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-[13px] [&_h1]:font-semibold ' +
        '[&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-xs [&_h2]:font-semibold ' +
        '[&_h3]:mt-1.5 [&_h3]:mb-1 [&_h3]:text-xs [&_h3]:font-medium ' +
        '[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-neutral-700 [&_blockquote]:pl-2 [&_blockquote]:text-neutral-400 ' +
        '[&_a]:text-blue-400 [&_a]:underline ' +
        '[&_hr]:my-2 [&_hr]:border-white/[0.08]'
      }
    >
      <ReactMarkdown
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function AiAssistant() {
  const t = useT();
  const { show } = useToast();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(() => {
    aiStatus()
      .then(setStatus)
      .catch(() => {
        // 探不到状态（daemon 未起）→ 不显示按钮，不打扰
      });
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);
  // 设置保存后重探（服务端推 invalidate('settings') 帧）
  useEffect(() => registerInvalidator('settings', refreshStatus), [refreshStatus]);
  // 新内容自动贴底
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, streaming, open]);

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (text === '' || busy) return;
    const history: AiChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    setStreaming('');
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let answer = '';
    try {
      await streamChat(history, {
        signal: controller.signal,
        onDelta: (delta) => {
          answer += delta;
          setStreaming(answer);
        },
      });
      // 空回答也给个明确交代：否则气泡是空的、看着像还在加载
      setMessages([
        ...history,
        { role: 'assistant', content: answer !== '' ? answer : t('ai.emptyAnswer') },
      ]);
      setStreaming('');
    } catch (e) {
      setStreaming('');
      if ((e as { name?: string }).name === 'AbortError') {
        // 停止生成：已生成的部分留档，不丢
        if (answer !== '') setMessages([...history, { role: 'assistant', content: answer }]);
      } else {
        show('error', t('ai.failed', { error: errorText(e) }));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, [busy, input, messages, show, t]);

  if (status?.configured !== true) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={open ? t('ai.close') : t('ai.open')}
        className="fixed bottom-4 right-4 z-50 grid h-11 w-11 place-items-center rounded-full border border-white/[0.08] bg-neutral-900/90 text-neutral-300 shadow-mac backdrop-blur transition-colors hover:bg-neutral-800 hover:text-neutral-100"
      >
        <Bot className="h-5 w-5" />
      </button>
      {open &&
        createPortal(
          <div className="fixed bottom-20 right-4 z-[55] flex h-[520px] max-h-[70dvh] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-neutral-900 shadow-mac">
            <header className="h-11 shrink-0 flex items-center gap-2 border-b border-white/[0.06] px-4 frosted">
              <Bot className="h-4 w-4 text-violet-400" />
              <span className="text-sm font-semibold text-neutral-200">{t('ai.title')}</span>
              <button
                type="button"
                onClick={() => setMessages([])}
                title={t('ai.clear')}
                className="ml-auto rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title={t('ai.close')}
                className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {messages.length === 0 && streaming === '' && (
                <div className="text-[11px] leading-relaxed text-neutral-500">
                  {t('ai.empty')}
                  <div className="mt-1 text-neutral-600">
                    {t('ai.intro')}
                    {status.docsFound ? '' : t('ai.docsMissing')}
                  </div>
                </div>
              )}
              {messages.map((message, index) => (
                <div
                  key={index}
                  className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
                >
                  {message.role === 'user' ? (
                    <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-blue-600/25 px-2.5 py-1.5 text-xs text-blue-50">
                      {message.content}
                    </div>
                  ) : (
                    <div className="max-w-[92%] break-words rounded-lg bg-neutral-800/70 px-2.5 py-1.5 text-xs text-neutral-200">
                      <AssistantMarkdown text={message.content} />
                    </div>
                  )}
                </div>
              ))}
              {busy && streaming === '' && (
                <div className="flex justify-start">
                  <div className="animate-pulse rounded-lg bg-neutral-800/70 px-2.5 py-1.5 text-xs text-neutral-400">
                    {t('ai.thinking')}
                  </div>
                </div>
              )}
              {streaming !== '' && (
                <div className="flex justify-start">
                  <div className="max-w-[92%] break-words rounded-lg bg-neutral-800/70 px-2.5 py-1.5 text-xs text-neutral-200">
                    <AssistantMarkdown text={streaming} />
                  </div>
                </div>
              )}
            </div>

            <form
              className="shrink-0 flex items-end gap-2 border-t border-white/[0.06] p-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                value={input}
                rows={2}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={t('ai.placeholder')}
                className="min-h-0 flex-1 resize-none rounded-lg border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
              />
              {busy ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  title={t('ai.stop')}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={input.trim() === ''}
                  title={t('ai.send')}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              )}
            </form>
          </div>,
          document.body,
        )}
    </>
  );
}
