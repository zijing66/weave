import { useState } from 'react';
import { type HookEventRow } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface SessionGroup {
  sessionId: string;
  events: HookEventRow[];
}

function groupBySession(events: HookEventRow[]): SessionGroup[] {
  const m = new Map<string, HookEventRow[]>();
  for (const e of events) {
    const sid = e.sessionId ?? '(no-session)';
    const list = m.get(sid) ?? [];
    list.push(e);
    m.set(sid, list);
  }
  return [...m.entries()].map(([sessionId, evs]) => ({ sessionId, events: evs }));
}

function toolName(payload: string): string | null {
  try {
    return (JSON.parse(payload) as { toolName?: string }).toolName ?? null;
  } catch {
    return null;
  }
}

export function TaskView({ events }: { events: HookEventRow[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const groups = groupBySession(events);
  return (
    <div className="space-y-3">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1 text-xs font-semibold text-neutral-400 uppercase hover:text-neutral-200"
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
        Tasks ({events.length} events, {groups.length} sessions)
      </button>
      {collapsed && <p className="text-xs text-neutral-600">Collapsed — click to expand</p>}
      {!collapsed && groups.length === 0 && (
        <p className="text-xs text-neutral-600">No hook events yet</p>
      )}
      {!collapsed &&
        groups.map((g) => (
        <div key={g.sessionId} className="border border-white/[0.06] rounded p-2">
          <p className="text-xs text-neutral-400 font-mono mb-1 truncate">{g.sessionId}</p>
          <ul className="space-y-0.5">
            {g.events.map((e) => (
              <li key={e.id} className="flex items-center gap-2 text-xs">
                <Badge>{e.eventType}</Badge>
                {toolName(e.payload) && (
                  <span className="text-neutral-300">{toolName(e.payload)}</span>
                )}
                <span className="text-neutral-600 ml-auto">
                  {new Date(e.createdAt).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
