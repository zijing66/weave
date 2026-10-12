import { useEffect, useRef, useState } from 'react';
import { type SessionRow } from '@/lib/api';
import { cn } from '@/lib/utils';
import { getDispatchDrag } from '@/lib/dnd';
import { sessionLabel } from '@/lib/hook-payload';
import { useT } from '@/i18n/I18nProvider';
import { Badge } from '@/components/ui/badge';
import { AgentBadge } from '@/components/AgentBadge';
import { Check, Copy, Pencil, SquareTerminal, Trash2 } from 'lucide-react';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import type { ActionState } from '@/lib/feedback-core';
import { STATUS_BADGE, STATUS_KEY, type SessionStatus } from './session-status';
import { SessionStatusIcon } from './SessionStatusIcon';

/**
 * 任务视图左栏：会话列表。行内元素 = 名称（title 回退 sessionId 前 8 位，
 * hover 出完整值可复制）+ 状态图标（运行中动效 / 打开静态）+ 事件计数 +
 * pendingTitle 徽标 + 行内改名 + 指令拖拽落点。
 */
export function SessionList({
  sessions,
  statuses,
  selectedId,
  onSelect,
  onRename,
  onDropDispatch,
  onOpenTerminal,
  openTerminalStateOf,
  onDelete,
  deleteStateOf,
}: {
  sessions: SessionRow[];
  statuses: Map<string, SessionStatus>;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onDropDispatch: (dispatchId: number, sessionId: string) => void;
  onOpenTerminal: (sessionId: string) => void;
  /** 打开会话终端按钮的反馈态（loading → ✅ → 还原，防连点重复 spawn）。 */
  openTerminalStateOf?: (sessionId: string) => ActionState;
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
    <ul className="space-y-1">
      {sessions.map((s) => {
        const status = statuses.get(s.sessionId) ?? 'open';
        const selected = s.sessionId === selectedId;
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
                'group flex flex-wrap cursor-pointer items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1.5 transition-colors',
                selected
                  ? 'border-blue-500/50 bg-blue-500/10'
                  : 'border-white/[0.06] bg-white/[0.015] hover:bg-white/[0.04]',
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
                  <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 [&_svg]:pointer-events-none">
                    {/* 能力真源 = harness ResumeCommandSpec.openArgs（claude 注册，
                        codex 未注册 resume 槽）——镜像判断，服务端仍做 501 校验 */}
                    {s.harness === 'claude' && (
                      <button
                        type="button"
                        title={t('tasks.openSessionTerminal')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenTerminal(s.sessionId);
                        }}
                        className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                      >
                        <FeedbackIcon
                          state={openTerminalStateOf?.(s.sessionId) ?? 'idle'}
                          className="h-3 w-3"
                          icon={<SquareTerminal className="h-3 w-3" />}
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
                      className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
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
                      className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
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
                      className="rounded p-0.5 text-neutral-500 hover:text-red-400"
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
