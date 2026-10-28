import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Folder, MessageSquareText, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { navigate } from '@/lib/route';
import { useBackPop } from '@/lib/back-pop';
import { useT } from '@/i18n/I18nProvider';
import { useSessionStatus } from '@/components/tasks/session-status-store';
import { sessionLabel } from '@/lib/hook-payload';
import { cn } from '@/lib/utils';

/**
 * 全局搜索弹层（Ctrl/Cmd+K）：会话名 / 聊天记录 / 项目文件三路聚合。
 * 防抖三件套照 FilePicker 范式——setTimeout 防抖 + AbortController 掐旧波 +
 * seq 序号守卫（慢响应不覆盖新结果）。空查询只出本地会话候选，零请求。
 */

const SEARCH_DEBOUNCE_MS = 150;

/** 键盘可聚焦的一条扁平结果（三组摊平后统一 ↑↓/Enter）。 */
interface PaletteRow {
  key: string;
  groupId: 'sessions' | 'messages' | 'files';
  /** 主文本（高亮区间对它而言）。 */
  label: string;
  /** 高亮区间 [起点, 长度]（对 `label`）。 */
  ranges: [number, number][];
  /** 副文本（聊天命中窗口 / 项目名）。 */
  detail?: string;
  /** 跳转参数。 */
  projectId: number | null;
  sessionId: string | null;
  /** 文件组的落点：有它 = Enter 直接弹文件浏览器（不再只跳项目视图）。 */
  path?: string;
  kind?: 'file' | 'dir';
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** 文件结果落定：弹项目文件浏览器并定位到该条（目录 = 落在该目录）。 */
  onOpenFile?: (row: { projectId: number; path: string; kind: 'file' | 'dir' }) => void;
}

export function CommandPalette({ open, onClose, onOpenFile }: CommandPaletteProps) {
  const t = useT();
  const { sessions } = useSessionStatus();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.searchAll>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 防抖三件套（FilePicker 范式）：请求序号 + 每波一个 controller。 */
  const seq = useRef(0);
  const ctrlRef = useRef<AbortController | null>(null);

  // 打开即聚焦并清点上次的输入（弹层是短命面，残留没有意义）。
  useEffect(() => {
    if (open) {
      setQuery('');
      setResult(null);
      setActive(0);
      // 等 portal 挂载完再聚焦
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    // 空查询不发请求：本地会话候选即时出（零请求），网络层清账。
    if (!q) {
      seq.current++;
      ctrlRef.current?.abort();
      ctrlRef.current = null;
      setResult(null);
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      const mine = ++seq.current;
      setLoading(true);
      api
        .searchAll(q, ctrl.signal)
        .then((r) => {
          if (mine !== seq.current) return;
          setResult(r);
          setActive(0);
          setLoading(false);
        })
        .catch(() => {
          if (mine !== seq.current || ctrl.signal.aborted) return;
          // 搜索失败静默清空：弹层是尽力面，报错条反而挡输入
          setResult(null);
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  // 空查询的本地会话候选（title 过滤，零请求）。
  const localSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return (sessions ?? []).slice(0, 8);
    return (sessions ?? [])
      .filter((s) => (s.title ?? '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, sessions]);

  /** 三组摊平成键盘导航序（会话 → 聊天 → 文件）。 */
  const rows = useMemo<PaletteRow[]>(() => {
    const q = query.trim();
    const out: PaletteRow[] = [];
    if (!q) {
      for (const s of localSessions) {
        const label = sessionLabel(s.title, s.sessionId);
        out.push({
          key: `local:${s.sessionId}`,
          groupId: 'sessions',
          label,
          ranges: [],
          projectId: s.projectId,
          sessionId: s.sessionId,
        });
      }
      return out;
    }
    for (const s of result?.sessions ?? []) {
      const label = s.title ?? sessionLabel(null, s.sessionId);
      out.push({
        key: `s:${s.sessionId}`,
        groupId: 'sessions',
        label,
        ranges: rangesOf(label, q),
        projectId: s.projectId,
        sessionId: s.sessionId,
      });
    }
    for (const m of result?.messages ?? []) {
      out.push({
        key: `m:${m.eventId}`,
        groupId: 'messages',
        label: m.text,
        ranges: [[m.offset, q.length]],
        detail: m.clipped ? '…' : undefined,
        projectId: m.projectId,
        sessionId: m.sessionId,
      });
    }
    for (const f of result?.files ?? []) {
      out.push({
        key: `f:${f.projectId}:${f.path}`,
        groupId: 'files',
        label: f.path,
        ranges: f.ranges,
        projectId: f.projectId,
        sessionId: null,
        path: f.path,
        kind: f.kind,
      });
    }
    return out;
  }, [query, result, localSessions]);

  const activate = useCallback(
    (row: PaletteRow | undefined) => {
      if (!row || row.projectId == null) return;
      // 文件结果直接弹文件浏览器（目录 = 落在该目录）；会话/聊天跳所属会话。
      if (row.groupId === 'files' && row.path) {
        onOpenFile?.({ projectId: row.projectId, path: row.path, kind: row.kind ?? 'file' });
        onClose();
        return;
      }
      navigate({
        kind: 'project',
        projectId: row.projectId,
        category: 'tasks',
        sessionId: row.sessionId,
      });
      onClose();
    },
    [onClose, onOpenFile],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, rows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        activate(rows[active]);
      }
    },
    [rows, active, activate, onClose],
  );

  // 高亮项滚进视野。
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, rows]);

  useBackPop(open, () => {
    onClose();
    return true;
  });

  if (!open) return null;

  const groups: Array<{ id: PaletteRow['groupId']; title: string }> = [
    { id: 'sessions', title: t('search.sectionSessions') },
    { id: 'messages', title: t('search.sectionMessages') },
    { id: 'files', title: t('search.sectionFiles') },
  ];
  let flatIndex = -1;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-3">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-[560px] max-w-full rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col max-h-[70vh]">
        <div className="shrink-0 flex items-center gap-2 px-3.5 h-11 border-b border-edge/[0.06]">
          <Search className="h-4 w-4 text-neutral-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('search.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
          />
          {loading && <span className="text-11 text-neutral-600 shrink-0">…</span>}
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 && !loading && (
            <p className="px-3 py-6 text-center text-xs text-neutral-500">{t('search.empty')}</p>
          )}
          {groups.map((g) => {
            const groupRows = rows.filter((r) => r.groupId === g.id);
            if (groupRows.length === 0) return null;
            return (
              <div key={g.id} className="mb-1">
                <p className="px-2.5 pt-1.5 pb-1 text-11 font-medium text-neutral-500">{g.title}</p>
                {groupRows.map((row) => {
                  flatIndex++;
                  const i = flatIndex;
                  return (
                    <button
                      key={row.key}
                      data-active={i === active}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => activate(row)}
                      className={cn(
                        'w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left',
                        i === active ? 'bg-edge/[0.08]' : 'hover:bg-edge/[0.04]',
                      )}
                    >
                      <GroupIcon groupId={row.groupId} path={row.groupId === 'files' ? row.label : undefined} />
                      <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">
                        <Highlight label={row.label} ranges={row.ranges} />
                      </span>
                      {row.detail && (
                        <span className="shrink-0 text-11 text-neutral-600">{row.detail}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {(result?.truncated.messages || result?.truncated.files) && (
            <p className="px-3 py-1.5 text-11 text-neutral-600">{t('search.more')}</p>
          )}
        </div>
        <footer className="shrink-0 border-t border-edge/[0.06] px-3.5 py-1.5 text-11 text-neutral-600">
          {t('search.hintNavigate')}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function GroupIcon({ groupId, path }: { groupId: PaletteRow['groupId']; path?: string }) {
  if (groupId === 'files') {
    const isDir = path?.endsWith('/') ?? false;
    return isDir ? (
      <Folder className="h-3.5 w-3.5 text-neutral-500 shrink-0" />
    ) : (
      <FileText className="h-3.5 w-3.5 text-neutral-500 shrink-0" />
    );
  }
  if (groupId === 'messages') {
    return <MessageSquareText className="h-3.5 w-3.5 text-neutral-500 shrink-0" />;
  }
  return <Search className="h-3.5 w-3.5 text-neutral-500 shrink-0" />;
}

/** 子串高亮切片（大小写不敏感；ranges 为空 = 原样）。 */
function Highlight({ label, ranges }: { label: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{label}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const [start, len] of ranges) {
    if (start < at || start + len > label.length) continue;
    if (start > at) out.push(label.slice(at, start));
    out.push(<mark key={`${start}`} className="bg-transparent text-blue-300 font-medium">{label.slice(start, start + len)}</mark>);
    at = start + len;
  }
  if (at < label.length) out.push(label.slice(at));
  return <>{out}</>;
}

/** 会话名命中的区间（大小写不敏感的子串定位；文件路的 ranges 服务端已给）。 */
function rangesOf(label: string, q: string): [number, number][] {
  const at = label.toLowerCase().indexOf(q.toLowerCase());
  return at >= 0 ? [[at, q.length]] : [];
}
