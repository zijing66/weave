import { useEffect, useRef, useState } from 'react';
import { type SessionRow, type SessionWatchRow, type MessagingCapability } from '@/lib/api';
import type { Harness } from '@weavecode/core/harness';
import { cn } from '@/lib/utils';
import { getDispatchDrag } from '@/lib/dnd';
import { sessionLabel } from '@/lib/hook-payload';
import { useT } from '@/i18n/I18nProvider';
import { Badge } from '@/components/ui/badge';
import { AgentBadge } from '@/components/AgentBadge';
import { Bell, BellRing, Check, Copy, MessageSquareText, Pencil, SquareTerminal, Trash2 } from 'lucide-react';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import type { ActionState } from '@/lib/feedback-core';
import { STATUS_BADGE, STATUS_KEY, type SessionStatus } from './session-status';
import { SessionStatusIcon } from './SessionStatusIcon';

/** 行内动作按钮（常显示、20×20 正方形描边——与项目卡按钮同款视觉）。 */
const ACTION_BTN =
  'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-white/[0.08] bg-white/[0.02] text-neutral-500 transition-colors hover:border-white/[0.16] hover:bg-white/[0.08] hover:text-neutral-200';

/**
 * 任务视图左栏：会话列表。行内元素 = 名称（title 回退 sessionId 前 8 位，
 * hover 出完整值可复制）+ 状态图标（运行中动效 / 打开静态）+ 事件计数 +
 * pendingTitle 徽标 + 行内改名 + 指令拖拽落点。
 */
export function SessionList({
  sessions,
  statuses,
  selectedId,
  highlightId,
  onSelect,
  onRename,
  onDropDispatch,
  onOpenTerminal,
  openTerminalStateOf,
  capabilities,
  onOpenMessages,
  watchOf,
  watchStateOf,
  onToggleWatch,
  onDelete,
  deleteStateOf,
}: {
  sessions: SessionRow[];
  statuses: Map<string, SessionStatus>;
  selectedId: string | null;
  /** 全局总览跳转定位：该行高亮边框 3s 后移除（selected 之外的临时指位）。 */
  highlightId?: string | null;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onDropDispatch: (dispatchId: number, sessionId: string) => void;
  onOpenTerminal: (sessionId: string) => void;
  /** 打开会话终端按钮的反馈态（loading → ✅ → 还原，防连点重复 spawn）。 */
  openTerminalStateOf?: (sessionId: string) => ActionState;
  /** 消息能力矩阵（服务端 MessagingSurface 派生，完整表不过滤；null = 未载）。 */
  capabilities: ReadonlyMap<Harness, MessagingCapability> | null;
  /** 打开该会话的消息线程（弹窗内投递/查看）。 */
  onOpenMessages: (sessionId: string) => void;
  /** 该会话当前的 pending 订阅行（无 = 未订阅）。 */
  watchOf?: (sessionId: string) => SessionWatchRow | undefined;
  /** 订阅按钮的反馈态（loading → ✅ → 还原）。 */
  watchStateOf?: (sessionId: string) => ActionState;
  /** 订阅/取消订阅（one-shot：fire 即失效）。 */
  onToggleWatch: (sessionId: string) => void;
  /** 删除该会话（含事件与派发；调用方负责确认与报错）。 */
  onDelete: (sessionId: string) => void;
  /** 删除按钮的反馈态（loading → ✅ → 还原）。 */
  deleteStateOf?: (sessionId: string) => ActionState;
}) {
  const t = useT();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [droppingId, setDroppingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingId) inputRef.current?.focus();
  }, [editingId]);

  const startRename = (s: SessionRow): void => {
    setEditingId(s.sessionId);
    setDraft(s.title ?? '');
  };

  const commitRename = (): void => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
  };

  const copyId = (sessionId: string): void => {
    void navigator.clipboard.writeText(sessionId).then(() => {
      setCopiedId(sessionId);
      window.setTimeout(() => setCopiedId(null), 1500);
    });
  };

  return (
    <ul className="space-y-1.5">
      {sessions.map((s) => {
        const status = statuses.get(s.sessionId) ?? 'open';
        const selected = s.sessionId === selectedId;
        const cap = s.harness != null ? capabilities?.get(s.harness) : undefined;
        const watch = watchOf?.(s.sessionId);
        return (
          <li key={s.sessionId}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(s.sessionId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(s.sessionId);
                }
              }}
              onDoubleClick={(e) => {
                // tooltip 承诺「双击改名」——行上直接双击即进编辑（铅笔为 hover 备选）
                e.stopPropagation();
                if (editingId !== s.sessionId) startRename(s);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDroppingId(s.sessionId);
              }}
              onDragLeave={() => setDroppingId((prev) => (prev === s.sessionId ? null : prev))}
              onDrop={(e) => {
                e.preventDefault();
                setDroppingId(null);
                const id = getDispatchDrag(e.dataTransfer);
                if (id !== null) onDropDispatch(id, s.sessionId);
              }}
              title={droppingId === s.sessionId ? t('tasks.dropTip') : s.sessionId}
              className={cn(
                'group flex flex-wrap cursor-pointer items-center gap-x-2 gap-y-1 rounded-xl border p-2 transition-colors',
                selected
                  ? 'border-blue-500/50 bg-blue-500/10'
                  : 'border-white/[0.06] bg-neutral-900/50 hover:border-white/[0.10] hover:bg-white/[0.04]',
                highlightId === s.sessionId && 'border-rose-400/70',
                droppingId === s.sessionId && 'border-dashed border-blue-400/70 bg-blue-500/10',
              )}
            >
              {/* 状态图标：运行中 = harness 跑马灯动效（claude 星芒旋 /
                  codex 六边形脉动），打开 = 同形静态，失败/关闭 = 状态点 */}
              <SessionStatusIcon status={status} harness={s.harness} />

              {editingId === s.sessionId ? (
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  placeholder={t('tasks.renamePlaceholder')}
                  className="min-w-0 flex-1 rounded border border-blue-500/40 bg-neutral-950 px-1.5 py-0.5 text-xs text-neutral-100 focus:outline-none"
                />
              ) : (
                <>
                  {/* 第 1 行：名称 + 悬停操作（basis-full 徽标组强制换到第 2 行） */}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-200">
                    {sessionLabel(s.title, s.sessionId)}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1 [&_svg]:pointer-events-none">
                    {/* 能力真源 = harness ResumeCommandSpec.openArgs（claude 注册，
                        codex 未注册 resume 槽）——镜像判断，服务端仍做 501 校验。
                        该会话的 claude 进程活着（pidAlive，claude 注册表判活）→ 终端
                        图标转绿：与项目卡同款「有终端在跑」信号。绿即「已开」，按钮
                        一并禁用——再点只会又 spawn 一个 claude --resume 抢同一会话。 */}
                    {s.harness === 'claude' && (
                      <button
                        type="button"
                        disabled={!!s.pidAlive}
                        title={
                          s.pidAlive
                            ? t('tasks.sessionTerminalRunning')
                            : t('tasks.openSessionTerminal')
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenTerminal(s.sessionId);
                        }}
                        className={cn(
                          ACTION_BTN,
                          // 已打开：不吃 hover 反馈（否则看着还能点）
                          s.pidAlive &&
                            'disabled:cursor-not-allowed hover:border-white/[0.08] hover:bg-white/[0.02] hover:text-neutral-500',
                        )}
                      >
                        <FeedbackIcon
                          state={openTerminalStateOf?.(s.sessionId) ?? 'idle'}
                          className="h-3 w-3"
                          icon={
                            <SquareTerminal
                              className={cn('h-3 w-3', s.pidAlive && 'text-emerald-400')}
                            />
                          }
                        />
                      </button>
                    )}
                    {/* 消息线程入口：能力真源 = 服务端 MessagingSurface 派生矩阵
                        （表驱动门控，不写死 harness 白名单——任一通道在场即入口）；
                        harness 未知（无事件）的会话不现按钮。 */}
                    {cap && (cap.inject || cap.headless) && (
                      <button
                        type="button"
                        title={t('tasks.messageTooltip')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenMessages(s.sessionId);
                        }}
                        className={ACTION_BTN}
                      >
                        <MessageSquareText className="h-3 w-3" />
                      </button>
                    )}
                    {/* 空闲订阅（one-shot）：门控同上表 watch 位。已有订阅 = 铃铛
                        亮起（amber），再点取消；fire 后行消失、铃铛自然回空。 */}
                    {cap?.watch && (
                      <button
                        type="button"
                        title={watch ? t('tasks.watchActiveTooltip') : t('tasks.watchTooltip')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleWatch(s.sessionId);
                        }}
                        className={ACTION_BTN}
                      >
                        <FeedbackIcon
                          state={watchStateOf?.(s.sessionId) ?? 'idle'}
                          className="h-3 w-3"
                          icon={
                            watch ? (
                              <BellRing className="h-3 w-3 text-amber-300" />
                            ) : (
                              <Bell className="h-3 w-3" />
                            )
                          }
                        />
                      </button>
                    )}
                    <button
                      type="button"
                      title={t('tasks.renameTip')}
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(s);
                      }}
                      className={ACTION_BTN}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title={copiedId === s.sessionId ? t('tasks.copied') : t('tasks.copySessionId')}
                      onClick={(e) => {
                        e.stopPropagation();
                        copyId(s.sessionId);
                      }}
                      className={ACTION_BTN}
                    >
                      {copiedId === s.sessionId ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                    <button
                      type="button"
                      title={t('tasks.deleteTooltip')}
                      aria-label={t('tasks.deleteSession')}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(s.sessionId);
                      }}
                      className={cn(ACTION_BTN, 'hover:text-red-400')}
                    >
                      <FeedbackIcon
                        state={deleteStateOf?.(s.sessionId) ?? 'idle'}
                        className="h-3 w-3"
                        icon={<Trash2 className="h-3 w-3" />}
                      />
                    </button>
                  </span>
                  {/* 第 2 行：徽标组（basis-full 恒换行，状态 Badge 固定第 2 行） */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 basis-full">
                    {s.pendingTitle && (
                      <Badge
                        title={t('tasks.renamePendingTip')}
                        className="shrink-0 bg-amber-900/40 text-amber-300"
                      >
                        {t('tasks.pendingTitle')}
                      </Badge>
                    )}
                    <span className="shrink-0 text-[10px] text-neutral-500">
                      {t('tasks.events', { n: s.eventCount ?? 0 })}
                    </span>
                    {s.harness && (
                      <AgentBadge agent={s.harness} className="shrink-0 px-1 text-[10px]" />
                    )}
                    <Badge className={cn('shrink-0', STATUS_BADGE[status])}>
                      {t(STATUS_KEY[status])}
                    </Badge>
                  </div>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
