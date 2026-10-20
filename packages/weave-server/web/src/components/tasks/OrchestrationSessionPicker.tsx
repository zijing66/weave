import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { ProjectRow, SessionRow } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { sessionLabel } from '@/lib/hook-payload';
import { HarnessIcon } from './HarnessIcon';

/**
 * 编排节点选择器：从受管会话里挑（候选集由调用方先按能力面与「有没有发过
 * prompt」筛过——这里只管搜索与项目定位）。候选跨项目，故逐行标出所属项目；
 * 加入后弹窗不关，方便连着挑几个；已在编排里的行标记为已加入，不再重复加。
 */
export function OrchestrationSessionPicker({
  sessions,
  projects,
  selected,
  onPick,
  onClose,
}: {
  sessions: SessionRow[];
  projects: ProjectRow[];
  /** 已在编排里的会话（不再重复加入）。 */
  selected: ReadonlySet<string>;
  onPick: (sessionId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState<number | 'all'>('all');

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const projectName = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  const projectOptions = useMemo(() => {
    const seen = new Set<number>();
    for (const s of sessions) if (s.projectId != null) seen.add(s.projectId);
    return [...seen]
      .map((id) => ({ id, name: projectName.get(id) ?? `#${id}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions, projectName]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (projectId !== 'all' && s.projectId !== projectId) return false;
      if (!q) return true;
      const label = sessionLabel(s.title, s.sessionId).toLowerCase();
      return label.includes(q) || s.sessionId.toLowerCase().includes(q);
    });
  }, [sessions, query, projectId]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-md flex-col rounded-xl border border-edge/[0.08] bg-neutral-900 p-3 shadow-mac"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-2">
          <p className="min-w-0 truncate text-xs font-medium text-neutral-200">
            {t('orch.pickerTitle')}
          </p>
          <button
            type="button"
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={onClose}
            className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pb-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('orch.pickerSearch')}
            autoFocus
            className="min-w-[8rem] flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
          />
          <select
            value={String(projectId)}
            onChange={(e) =>
              setProjectId(e.target.value === 'all' ? 'all' : Number(e.target.value))
            }
            title={t('orch.filterProject')}
            className="max-w-[10rem] shrink-0 rounded border border-edge/[0.08] bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200"
          >
            <option value="all">{t('orch.pickerAllProjects')}</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {rows.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-neutral-600">{t('orch.pickerEmpty')}</p>
        ) : (
          <ul className="-mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1">
            {rows.map((s) => {
              const joined = selected.has(s.sessionId);
              return (
                <li key={s.sessionId}>
                  <button
                    type="button"
                    disabled={joined}
                    onClick={() => onPick(s.sessionId)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors',
                      joined
                        ? 'cursor-default opacity-50'
                        : 'hover:border-edge/[0.12] hover:bg-edge/[0.06]',
                    )}
                  >
                    {s.harness != null ? (
                      <HarnessIcon harness={s.harness} />
                    ) : (
                      <span className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-neutral-200">
                        {sessionLabel(s.title, s.sessionId)}
                      </span>
                      {s.projectId != null && (
                        <span className="block truncate text-[10px] text-neutral-500">
                          {projectName.get(s.projectId) ?? `#${s.projectId}`}
                        </span>
                      )}
                    </span>
                    {joined && (
                      <span className="shrink-0 text-[10px] text-teal-400/80">
                        {t('orch.pickerJoined')}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
