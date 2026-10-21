import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { DiffRows } from '@/components/ui/diff-rows';
import { api, type SessionEditHunk, type SessionEdits } from '@/lib/api';
import { collapseDiff, countChanges, diffLines } from '@/lib/text-diff';
import { useT } from '@/i18n/I18nProvider';

/** 一处改动算出来的东西：逐行 diff（折叠未变区）+ 增删行数。 */
interface EditBlock {
  hunk: SessionEditHunk;
  rows: ReturnType<typeof collapseDiff>;
}

/**
 * 会话改动汇总：默认只看右键那一轮的改动（上一次回复 → 这一次回复），头部可切
 * 「全部对话」。改动本身归能力面取（claude = 转录里的编辑调用），这条弹窗只摆，
 * 不算数。
 */
export function SessionEditsDialog({
  sessionId,
  range,
  open,
  onClose,
}: {
  sessionId: string;
  /** 右键锚所在轮的窗口（双 null = 会话里还没有回复，恒为全部）。 */
  range: { since: string | null; until: string | null };
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [data, setData] = useState<SessionEdits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 展开着的文件（第一次进来默认摊开第一个，免得满屏折叠条看不出有没有东西）。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** 取数范围：默认这一轮；「全部对话」不带参（整段会话的逃生门）。 */
  const [scope, setScope] = useState<'turn' | 'all'>('turn');
  const hasTurn = range.since !== null || range.until !== null;

  useEffect(() => {
    if (!open) return;
    setScope('turn');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const active = scope === 'turn' && hasTurn ? range : null;
    let live = true;
    setLoading(true);
    setError(null);
    setData(null);
    api
      .sessionEdits(sessionId, active ?? undefined)
      .then((r) => {
        if (!live) return;
        setData(r);
        const first = r.files?.[0]?.path;
        setExpanded(new Set(first ? [first] : []));
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open, sessionId, scope, hasTurn, range]);

  const files = useMemo(() => {
    return (data?.files ?? []).map((file) => {
      let added = 0;
      let removed = 0;
      const blocks: EditBlock[] = file.hunks.map((hunk) => {
        const lines = diffLines(hunk.before, hunk.after);
        const counts = countChanges(lines);
        added += counts.added;
        removed += counts.removed;
        return { hunk, rows: collapseDiff(lines, 2) };
      });
      return { path: file.path, count: file.hunks.length, added, removed, blocks };
    });
  }, [data]);

  const total = files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  );

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!open) return null;

  const empty =
    !loading && !error && (!data?.files || data.files.length === 0)
      ? data?.reason === 'unsupported'
        ? t('tasks.editsUnsupported')
        : data?.reason === 'unreadable'
          ? t('tasks.editsUnreadable')
          : scope === 'turn' && hasTurn
            ? t('tasks.editsTurnEmpty')
            : t('tasks.editsEmpty')
      : null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 lg:p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-[860px] max-w-full max-h-[86dvh] rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted">
          <span className="text-sm font-semibold text-neutral-200">{t('tasks.editsTitle')}</span>
          {files.length > 0 && (
            <span className="text-[11px] text-neutral-500">
              <span className="text-emerald-400">+{total.added}</span> /{' '}
              <span className="text-red-400">-{total.removed}</span>
            </span>
          )}
          {hasTurn && (
            <div className="ml-auto flex items-center rounded-md border border-edge/[0.08] p-0.5 text-[11px]">
              {(['turn', 'all'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={
                    scope === s
                      ? 'rounded px-2 py-0.5 bg-edge/[0.12] text-neutral-100'
                      : 'rounded px-2 py-0.5 text-neutral-500 hover:text-neutral-200'
                  }
                >
                  {s === 'turn' ? t('tasks.editsScopeTurn') : t('tasks.editsScopeAll')}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={onClose}
            className={hasTurn ? 'p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800' : 'ml-auto p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800'}
            title={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-auto">
          {loading && (
            <p className="flex items-center gap-2 p-4 text-[11px] text-neutral-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('tasks.editsLoading')}
            </p>
          )}
          {error && <p className="p-4 text-[11px] text-red-300">{error}</p>}
          {empty && <p className="p-4 text-[11px] text-neutral-500">{empty}</p>}
          {files.map((file) => {
            const openFile = expanded.has(file.path);
            return (
              <section key={file.path} className="border-b border-edge/[0.06] last:border-b-0">
                <button
                  type="button"
                  onClick={() => toggle(file.path)}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left hover:bg-edge/[0.04]"
                >
                  {openFile ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                  )}
                  <span className="truncate font-mono text-[11px] text-neutral-200">
                    {file.path}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-neutral-500">
                    <span className="text-emerald-400">+{file.added}</span>{' '}
                    <span className="text-red-400">-{file.removed}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-neutral-600">
                    {t('tasks.editsHunks', { n: file.count })}
                  </span>
                </button>
                {openFile && (
                  <div className="pb-2 font-mono text-[11px] leading-5">
                    {file.blocks.map((block, idx) => (
                      <div key={idx} className={idx > 0 ? 'mt-2 border-t border-edge/[0.06]' : ''}>
                        <div className="flex items-center gap-2 px-3 py-1 text-[10px] text-neutral-600">
                          <span>{stamp(block.hunk.at)}</span>
                          {block.hunk.clamped && (
                            <span className="text-amber-400/80">{t('tasks.editsClamped')}</span>
                          )}
                        </div>
                        <DiffRows rows={block.rows} />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {(data?.truncated || (data && data.hunks > 0)) && (
          <footer className="shrink-0 border-t border-edge/[0.06] px-4 py-2 text-[10px] text-neutral-600 frosted">
            {data?.truncated ? t('tasks.editsTruncated') : t('tasks.editsSummary', { n: data?.hunks ?? 0 })}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 一处改动的时刻（本地 `MM-DD HH:mm`）；宿主没带就是空。 */
function stamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
