import { useState } from 'react';
import { type HookEventRow, type SessionRow } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import { Check, ChevronDown, ChevronRight, Copy, RefreshCw } from 'lucide-react';

interface SessionGroup {
  sessionId: string;
  /** 会话自定义名（sessions 表 title；rename 后回显在折叠条上）。 */
  title: string | null;
  /** dashboard 改名待生效标记。 */
  pendingTitle: string | null;
  events: HookEventRow[];
}

/**
 * Group events by session. The API returns newest-first, so groups come out
 * with the most recent session first and each session's events stay in
 * reverse-chronological order（日志倒序：新事件在上）.
 */
function groupBySession(events: HookEventRow[], sessions: SessionRow[]): SessionGroup[] {
  const titles = new Map(sessions.map((s) => [s.sessionId, s]));
  const m = new Map<string, HookEventRow[]>();
  for (const e of events) {
    const sid = e.sessionId ?? '(no-session)';
    const list = m.get(sid) ?? [];
    list.push(e);
    m.set(sid, list);
  }
  return [...m.entries()].map(([sessionId, evs]) => {
    const s = titles.get(sessionId);
    return {
      sessionId,
      title: s?.title ?? null,
      pendingTitle: s?.pendingTitle ?? null,
      events: evs,
    };
  });
}

/** Fields of the daemon-side NormalizedHookPayload, tolerated when absent. */
interface EventDetail {
  toolName: string | null;
  toolInput: unknown;
  toolResponse: unknown;
  cwd: string | null;
  transcriptPath: string | null;
}

function parseDetail(payload: string): EventDetail {
  try {
    const parsed = JSON.parse(payload) as Partial<EventDetail>;
    return {
      toolName: typeof parsed.toolName === 'string' ? parsed.toolName : null,
      toolInput: parsed.toolInput ?? null,
      toolResponse: parsed.toolResponse ?? null,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
      transcriptPath:
        typeof parsed.transcriptPath === 'string' ? parsed.transcriptPath : null,
    };
  } catch {
    return { toolName: null, toolInput: null, toolResponse: null, cwd: null, transcriptPath: null };
  }
}

const EVENT_TYPE_STYLES: Record<string, string> = {
  PreToolUse: 'bg-blue-900/40 text-blue-300',
  PostToolUse: 'bg-emerald-900/40 text-emerald-300',
  UserPromptSubmit: 'bg-cyan-900/40 text-cyan-300',
  SessionStart: 'bg-purple-900/40 text-purple-300',
  SessionEnd: 'bg-pink-900/40 text-pink-300',
  Notification: 'bg-amber-900/40 text-amber-300',
  Stop: 'bg-orange-900/40 text-orange-300',
  SubagentStop: 'bg-orange-900/40 text-orange-300',
};

const SOURCE_STYLES: Record<string, string> = {
  claude: 'bg-orange-900/40 text-orange-300',
  codex: 'bg-cyan-900/40 text-cyan-300',
};

const EMPTY_SET: ReadonlySet<string> = new Set();

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  const text =
    typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</p>
      <pre className="text-[11px] leading-relaxed text-neutral-300 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
        {text}
      </pre>
    </div>
  );
}

function EventRow({
  event,
  open,
  onToggle,
}: {
  event: HookEventRow;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const d = parseDetail(event.payload);
  const hasDetail =
    d.toolName !== null ||
    d.cwd !== null ||
    d.transcriptPath !== null ||
    d.toolInput !== null ||
    d.toolResponse !== null;
  return (
    <li>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 text-left rounded px-1 py-0.5 hover:bg-white/[0.04]"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-neutral-500" />
        )}
        <Badge className={cn('shrink-0', EVENT_TYPE_STYLES[event.eventType])}>
          {event.eventType}
        </Badge>
        {d.toolName && <span className="text-neutral-300 truncate">{d.toolName}</span>}
        <span className="ml-auto shrink-0 text-neutral-600">{formatTime(event.createdAt)}</span>
      </button>
      {open && (
        <div className="ml-4 mt-1 mb-1.5 space-y-2 rounded-md border border-white/[0.06] bg-black/20 px-2.5 py-2">
          {hasDetail ? (
            <>
              {d.cwd && (
                <p className="text-[11px] text-neutral-500 font-mono break-all">cwd: {d.cwd}</p>
              )}
              {d.transcriptPath && (
                <p className="text-[11px] text-neutral-500 font-mono break-all">
                  transcript: {d.transcriptPath}
                </p>
              )}
              {d.toolInput !== null && <PayloadBlock label="input" value={d.toolInput} />}
              {d.toolResponse !== null && (
                <PayloadBlock label="response" value={d.toolResponse} />
              )}
            </>
          ) : (
            <p className="text-[11px] text-neutral-600">{t('task.noPayload')}</p>
          )}
        </div>
      )}
    </li>
  );
}

function SessionPanel({
  group,
  open,
  onToggle,
  openEvents,
  onToggleEvent,
}: {
  group: SessionGroup;
  open: boolean;
  onToggle: () => void;
  openEvents: ReadonlySet<number>;
  onToggleEvent: (id: number) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const first = group.events[0]; // 最新（倒序列表）
  const last = group.events[group.events.length - 1]; // 最早
  const sources = [...new Set(group.events.map((e) => e.source))];

  const copySessionId = (): void => {
    void navigator.clipboard.writeText(group.sessionId).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.015]">
      {/* 折叠条：div+role=button（内部含复制按钮，不能嵌套 button） */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left rounded-md hover:bg-white/[0.04] cursor-pointer"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        )}
        {sources.map((s) => (
          <Badge key={s} className={cn('shrink-0', SOURCE_STYLES[s])}>
            {s}
          </Badge>
        ))}
        {group.title && (
          <span className="shrink-0 text-xs font-medium text-neutral-200">{group.title}</span>
        )}
        {group.pendingTitle && (
          <Badge className="shrink-0 bg-amber-900/40 text-amber-300">
            {t('task.pendingTitle')}
          </Badge>
        )}
        {/* 完整 session id（不截断） */}
        <span
          className={cn(
            'font-mono whitespace-nowrap',
            group.title ? 'text-[11px] text-neutral-500' : 'text-xs text-neutral-300',
          )}
        >
          {group.sessionId}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            copySessionId();
          }}
          title={copied ? t('task.copied') : t('task.copySessionId')}
          className="shrink-0 p-0.5 rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/[0.06]"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        </button>
        <span className="shrink-0 text-xs text-neutral-500">
          {t('task.events', { n: group.events.length })}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-neutral-600 font-mono">
          {formatTime(last.createdAt)} – {formatTime(first.createdAt)}
        </span>
      </div>
      {open && (
        <ul className="border-t border-white/[0.06] px-2 py-1.5 space-y-0.5">
          {group.events.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              open={openEvents.has(e.id)}
              onToggle={() => onToggleEvent(e.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function TaskView({
  events,
  sessions,
  onRefresh,
}: {
  events: HookEventRow[];
  sessions: SessionRow[];
  onRefresh: () => void;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const groups = groupBySession(events, sessions);

  const handleRefresh = (): void => {
    setRefreshing(true);
    onRefresh();
    window.setTimeout(() => setRefreshing(false), 600);
  };

  // Sessions are open unless the user closes them. Before events load the
  // state stays null; the first non-empty render initializes everything but
  // the newest session to closed, keeping the panel scannable.
  const [closedSessions, setClosedSessions] = useState<ReadonlySet<string> | null>(null);
  if (closedSessions === null && groups.length > 0) {
    setClosedSessions(new Set(groups.slice(1).map((g) => g.sessionId)));
  }
  const closed = closedSessions ?? EMPTY_SET;

  const [openEvents, setOpenEvents] = useState<ReadonlySet<number>>(() => new Set());

  const toggleSession = (sessionId: string): void => {
    setClosedSessions((prev) => {
      const next = new Set(prev ?? groups.slice(1).map((g) => g.sessionId));
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const toggleEvent = (id: number): void => {
    setOpenEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setAllSessions = (open: boolean): void => {
    setClosedSessions(open ? new Set() : new Set(groups.map((g) => g.sessionId)));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 text-xs font-semibold text-neutral-400 uppercase">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1 hover:text-neutral-200"
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
          {t('task.heading', { events: events.length, sessions: groups.length })}
        </button>
        {!collapsed && (
          <span className="ml-auto flex items-center gap-2 font-normal normal-case">
            <button
              onClick={handleRefresh}
              title={t('task.refresh')}
              className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-200"
            >
              <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
              {t('task.refresh')}
            </button>
            {groups.length > 1 && (
              <>
                <button
                  onClick={() => setAllSessions(true)}
                  className="text-[11px] text-neutral-500 hover:text-neutral-200"
                >
                  {t('task.expandAll')}
                </button>
                <button
                  onClick={() => setAllSessions(false)}
                  className="text-[11px] text-neutral-500 hover:text-neutral-200"
                >
                  {t('task.collapseAll')}
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {!collapsed && groups.length === 0 && (
        <p className="text-xs text-neutral-600">{t('task.empty')}</p>
      )}
      {!collapsed &&
        groups.map((g) => (
          <SessionPanel
            key={g.sessionId}
            group={g}
            open={!closed.has(g.sessionId)}
            onToggle={() => toggleSession(g.sessionId)}
            openEvents={openEvents}
            onToggleEvent={toggleEvent}
          />
        ))}
    </div>
  );
}
