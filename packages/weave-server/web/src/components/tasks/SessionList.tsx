import { useEffect, useRef, useState } from 'react';
import { type SessionRow } from '@/lib/api';
import { cn } from '@/lib/utils';
import { getDispatchDrag } from '@/lib/dnd';
import { useT } from '@/i18n/I18nProvider';
import { Badge } from '@/components/ui/badge';
import { AgentBadge } from '@/components/AgentBadge';
import { Check, Copy, Pencil } from 'lucide-react';
import { STATUS_BADGE, STATUS_DOT, STATUS_KEY, type SessionStatus } from './session-status';
import { HarnessIcon } from './HarnessIcon';

/**
 * 任务视图左栏：会话列表。行内元素 = 名称（title 回退 sessionId 前 8 位，
 * hover 出完整值可复制）+ 状态图标（running 转 spinner）+ 事件计数 +
 * pendingTitle 徽标 + 行内改名 + 指令拖拽落点。
 */
export function SessionList({
  sessions,
  statuses,
  selectedId,
  onSelect,
  onRename,
  onDropDispatch,
}: {
  sessions: SessionRow[];
  statuses: Map<string, SessionStatus>;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onDropDispatch: (dispatchId: number, sessionId: string) => void;
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
        const status = statuses.get(s.sessionId) ?? 'idle';
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
                'group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 transition-colors',
                selected
                  ? 'border-blue-500/50 bg-blue-500/10'
                  : 'border-white/[0.06] bg-white/[0.015] hover:bg-white/[0.04]',
                droppingId === s.sessionId && 'border-dashed border-blue-400/70 bg-blue-500/10',
              )}
            >
              {/* 状态图标：running = harness 自身跑马灯动效（claude 星芒旋 /
                  codex 六边形脉动），其余 = 状态点 */}
              {status === 'running' ? (
                <HarnessIcon harness={s.harness} running />
              ) : (
                <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status])} />
              )}

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
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-200">
                    {s.title ?? s.sessionId.slice(0, 8)}
                  </span>
                  {s.pendingTitle && (
                    <Badge className="shrink-0 bg-amber-900/40 text-amber-300">
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
                  <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
                  </span>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
