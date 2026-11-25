import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, Copy, FileText, Folder, Loader2, MessageSquareText, Search } from 'lucide-react';
import { api } from '@/lib/api';
import type { MessageContextResult } from '@/lib/api';
import { navigate } from '@/lib/route';
import { useBackPop } from '@/lib/back-pop';
import { useT } from '@/i18n/I18nProvider';
import { useSessionStatus } from '@/components/tasks/session-status-store';
import { sessionLabel } from '@/lib/hook-payload';
import { cn } from '@/lib/utils';
import { copyText } from '@/lib/clipboard';
import { Tooltip } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';

/**
 * 全局搜索弹层（Ctrl/Cmd+K）：会话名 / 聊天记录 / 文件名 / 文件内容四路聚合。
 * 查询语法解析在服务端——这里的分类 chips 与项目/会话下拉只把状态拼回查询串
 * （`in:chat project:3 …`），语义归服务端 search-query.ts 一处。
 * 防抖三件套照 FilePicker 范式——setTimeout 防抖 + AbortController 掐旧波 +
 * seq 序号守卫（慢响应不覆盖新结果）。空查询只出本地会话候选，零请求。
 * 聊天结果点击 = 行内展开上下文预览（不再直接跳会话——历史太多滚不回去）；
 * 预览里的「打开会话」/ Shift+Enter 才跳。
 */

const SEARCH_DEBOUNCE_MS = 150;

type Tab = 'all' | 'messages' | 'files' | 'content' | 'sessions';

/** chips/下拉态 → 查询串（语法真源在服务端解析器；这里只拼形）。
 *  `in`/`in:`/`:` 裸值不构成可检索查询——防抖不发枪（避免「没有匹配」假空态）。 */
function buildQuery(query: string, tab: Tab, projectId: number | null, sessionId: string | null): string {
  if (!query.trim()) return '';
  const inOf: Record<Exclude<Tab, 'all'>, string> = {
    messages: ':chat',
    files: ':file',
    content: ':content',
    sessions: ':session',
  };
  const parts: string[] = [];
  if (tab !== 'all') parts.push(inOf[tab]);
  if (projectId != null) parts.push(`project:${projectId}`);
  if (sessionId) parts.push(`session:${sessionId}`);
  parts.push(query.trim());
  return parts.join(' ');
}

/** 语法补全候选：`:` 起头的未完 token 给分类值，`project:`/`session:` 给提示。 */
interface SuggestItem {
  insert: string;
  label: string;
}

/** 当前光标所在 token（光标前最近的空格到光标之间的串）。 */
function tokenAtCursor(query: string, caret: number): string {
  const before = query.slice(0, caret);
  const at = before.search(/\S+$/);
  return at >= 0 ? before.slice(at) : '';
}

function suggestFor(token: string, t: ReturnType<typeof useT>): SuggestItem[] {
  // `:` 或 `:par` 形 → 分类候选（含按已敲前缀过滤）
  if (token.startsWith(':') && !token.slice(1).includes(':')) {
    const typed = token.slice(1).toLowerCase();
    const items: SuggestItem[] = [
      { insert: ':chat ', label: t('search.tabMessages') },
      { insert: ':file ', label: t('search.tabFiles') },
      { insert: ':content ', label: t('search.tabContent') },
      { insert: ':session ', label: t('search.tabSessions') },
    ];
    return items.filter((i) => i.insert.slice(1).startsWith(typed));
  }
  if (token === 'project' || token === 'project:') {
    return [{ insert: 'project:', label: t('search.filterProject') }];
  }
  if (token === 'session' || token === 'session:') {
    return [{ insert: 'session:', label: t('search.filterSession') }];
  }
  return [];
}

/** 键盘可聚焦的一条扁平结果（四组摊平后统一 ↑↓/Enter）。 */
interface PaletteRow {
  key: string;
  groupId: 'sessions' | 'messages' | 'files' | 'content';
  /** 主文本（高亮区间对它而言）。 */
  label: string;
  /** 高亮区间 [起点, 长度]（对 `label`）。 */
  ranges: [number, number][];
  /** 副文本（聊天命中窗口 / 项目名）。 */
  detail?: string;
  /** 右侧固定展示的短文本（文件行 = 文件名；聊天行 = 会话名）。 */
  meta?: string;
  /** 悬停 tooltip 的完整文本（可选中复制的那份）。 */
  metaFull?: string;
  /** 复制按钮写入剪贴板的内容（文件行 = 完整路径）。 */
  copyText?: string;
  /** 跳转参数。 */
  projectId: number;
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

/** 预览面板的运行态：正在看哪行 + 上下文数据。 */
interface PreviewState {
  row: PaletteRow;
  data: MessageContextResult | null;
  loading: boolean;
}

export function CommandPalette({ open, onClose, onOpenFile }: CommandPaletteProps) {
  const t = useT();
  const { sessions } = useSessionStatus();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [projFilter, setProjFilter] = useState<number | null>(null);
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.searchAll>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  /** 行内展开的上下文预览（一次一行；null = 全收起）。 */
  const [preview, setPreview] = useState<PreviewState | null>(null);
  /** 输入法之外的裸光标位（补全面板锚定当前 token）。 */
  const [caret, setCaret] = useState(0);
  /** 补全面板选中项（↑↓ 在补全与结果两序间不打架：补全开着时 ↑↓ 归补全）。 */
  const [suggestIdx, setSuggestIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 防抖三件套（FilePicker 范式）：请求序号 + 每波一个 controller。 */
  const seq = useRef(0);
  const ctrlRef = useRef<AbortController | null>(null);

  // 打开即聚焦并清点上次的输入（弹层是短命面，残留没有意义）。
  useEffect(() => {
    if (open) {
      setQuery('');
      setTab('all');
      setProjFilter(null);
      setSessionFilter(null);
      setResult(null);
      setActive(0);
      setPreview(null);
      // 等 portal 挂载完再聚焦
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = buildQuery(query, tab, projFilter, sessionFilter);
    // 空查询不发请求：本地会话候选即时出（零请求），网络层清账。
    if (!q) {
      seq.current++;
      ctrlRef.current?.abort();
      ctrlRef.current = null;
      setResult(null);
      setLoading(false);
      return;
    }
    // 裸限定词（: / :chat / -）还在敲的中间态：不构成可检索查询，不发枪——
    // 否则会出现「没有匹配」假空态（用户裁决 2026-11-25）。
    const bare = query
      .trim()
      .split(/\s+/)
      .every((tok) => /^(in|:.*|-)$/i.test(tok) || /^:(chat|file|content|session|messages|files|code|sessions)?$/i.test(tok));
    if (bare) {
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
  }, [query, tab, projFilter, sessionFilter, open]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  // 空查询的本地会话候选（title 过滤，零请求）。
  const localSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return (sessions ?? []).slice(0, 8);
    return (sessions ?? [])
      .filter((s) => (s.title ?? '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, sessions]);

  // 语法补全：光标所在 token 敲到 `:`/`project:`/`session:` 时浮候选。
  const suggests = useMemo(() => suggestFor(tokenAtCursor(query, caret), t), [query, caret, t]);
  useEffect(() => setSuggestIdx(0), [suggests.length]);

  /** 落一个补全候选：替换光标前的当前 token。 */
  const applySuggest = useCallback(
    (item: SuggestItem) => {
      const before = query.slice(0, caret);
      const at = before.search(/\S+$/);
      const head = at >= 0 ? before.slice(0, at) : before;
      const next = head + item.insert + query.slice(caret);
      setQuery(next);
      const nextCaret = (head + item.insert).length;
      setCaret(nextCaret);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [query, caret],
  );

  /** 项目下拉候选（结果里出现过的项目名优先；空态给全部项目）。 */
  const projectOptions = useMemo(() => {
    void result;
    return [];
  }, [result]);

  /** 四组摊平成键盘导航序（会话 → 聊天 → 文件名 → 文件内容）。 */
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
          projectId: s.projectId ?? 0,
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
        projectId: s.projectId ?? 0,
        sessionId: s.sessionId,
      });
    }
    for (const m of result?.messages ?? []) {
      const session = m.sessionId
        ? (sessions ?? []).find((s) => s.sessionId === m.sessionId)
        : undefined;
      const meta = session?.title ?? undefined;
      out.push({
        key: `m:${m.eventId}:${m.sessionId ?? ''}`,
        groupId: 'messages',
        label: m.text,
        ranges: [[m.offset, q.length]],
        detail: m.text,
        meta: meta ?? (m.clipped ? '…' : undefined),
        metaFull: meta,
        copyText: m.text,
        projectId: m.projectId,
        sessionId: m.sessionId ?? null,
      });
    }
    for (const f of result?.files ?? []) {
      const name = f.path.replace(/\/+$/, '').split('/').pop() ?? f.path;
      out.push({
        key: `f:${f.projectId}:${f.path}`,
        groupId: 'files',
        label: f.path,
        ranges: f.ranges,
        meta: name,
        metaFull: f.path,
        copyText: f.path,
        projectId: f.projectId,
        sessionId: null,
        path: f.path,
        kind: f.kind,
      });
    }
    for (const c of result?.content ?? []) {
      const name = c.path.split('/').pop() ?? c.path;
      out.push({
        key: `c:${c.projectId}:${c.path}:${c.line}`,
        groupId: 'content',
        label: c.text,
        ranges: [[c.offset, q.length]],
        meta: `${name}${c.line ? `:${c.line}` : ''}`,
        metaFull: c.path,
        copyText: c.text,
        projectId: c.projectId,
        sessionId: null,
        path: c.path,
        kind: 'file',
      });
    }
    return out;
  }, [query, result, localSessions, sessions]);

  const openSession = useCallback(
    (row: PaletteRow | undefined) => {
      if (!row || !row.sessionId) return;
      navigate({
        kind: 'project',
        projectId: row.projectId,
        category: 'tasks',
        sessionId: row.sessionId,
      });
      onClose();
    },
    [onClose],
  );

  /** 拉某行的上下文预览（已展开同一行 = 收起）。 */
  const togglePreview = useCallback(
    (row: PaletteRow | undefined) => {
      if (!row) return;
      setPreview((cur) => {
        if (cur && cur.row.key === row.key && !cur.loading) return null;
        return { row, data: null, loading: true };
      });
    },
    [],
  );

  // 预览请求（preview 状态翻开后拉一次；row 变更重拉）。
  useEffect(() => {
    if (!preview?.loading) return;
    const { row } = preview;
    if (!row.sessionId) return;
    const ctrl = new AbortController();
    const sessionId: string = row.sessionId;
    api
      .messageContext(
        { projectId: row.projectId, sessionId, q: query.trim() },
        ctrl.signal,
      )
      .then((data) => {
        setPreview((cur) => (cur && cur.row.key === row.key ? { row, data, loading: false } : cur));
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        setPreview((cur) => (cur && cur.row.key === row.key ? { row, data: null, loading: false } : cur));
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.row.key]);

  const activate = useCallback(
    (row: PaletteRow | undefined) => {
      if (!row) return;
      // 文件名/内容结果直接弹文件浏览器；会话/聊天行内展开预览（不跳走）。
      if ((row.groupId === 'files' || row.groupId === 'content') && row.path) {
        onOpenFile?.({ projectId: row.projectId, path: row.path, kind: row.kind ?? 'file' });
        onClose();
        return;
      }
      togglePreview(row);
    },
    [onClose, onOpenFile, togglePreview],
  );

  const suggestsOpen = suggests.length > 0;
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown' && suggestsOpen) {
        e.preventDefault();
        setSuggestIdx((i) => Math.min(i + 1, suggests.length - 1));
      } else if (e.key === 'ArrowUp' && suggestsOpen) {
        e.preventDefault();
        setSuggestIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, rows.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter' && suggestsOpen && !e.shiftKey) {
        // 补全开着：Enter 落候选（Shift+Enter 仍是打开会话）
        e.preventDefault();
        applySuggest(suggests[Math.min(suggestIdx, suggests.length - 1)]);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) openSession(rows[active]);
        else activate(rows[active]);
      }
    },
    [rows, active, activate, openSession, onClose, suggestsOpen, suggests, suggestIdx, applySuggest],
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
    { id: 'content', title: t('search.sectionContent') },
  ];
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all', label: t('search.tabAll') },
    { id: 'messages', label: t('search.tabMessages') },
    { id: 'files', label: t('search.tabFiles') },
    { id: 'content', label: t('search.tabContent') },
    { id: 'sessions', label: t('search.tabSessions') },
  ];
  const sessionOptions = (sessions ?? [])
    .filter((s) => projFilter == null || s.projectId === projFilter)
    .slice(0, 200)
    .map((s) => ({ value: s.sessionId, label: sessionLabel(s.title, s.sessionId) }));
  let flatIndex = -1;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-3">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-[640px] max-w-full rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col max-h-[76vh]">
        <div className="shrink-0 flex items-center gap-2 px-3.5 h-11 border-b border-edge/[0.06]">
          <Search className="h-4 w-4 text-neutral-500 shrink-0" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            placeholder={t('search.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
          />
          {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-500" />}
        </div>
        {/* 语法补全：光标 token 敲到 `:`/`project:`/`session:` 时浮候选（↑↓/Enter） */}
        {suggestsOpen && (
          <div className="shrink-0 border-b border-edge/[0.06] px-2.5 py-1">
            {suggests.map((item, i) => (
              <button
                key={item.insert}
                type="button"
                onMouseEnter={() => setSuggestIdx(i)}
                onClick={() => applySuggest(item)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-11',
                  i === suggestIdx ? 'bg-edge/[0.1] text-neutral-100' : 'text-neutral-400',
                )}
              >
                <code className="font-mono text-neutral-200">{item.insert.trim()}</code>
                <span className="text-neutral-500">{item.label}</span>
              </button>
            ))}
          </div>
        )}
        {/* 分类 chips + 项目/会话下拉：枚举全程点选（拼回查询串，语义归服务端） */}
        <div className="shrink-0 flex flex-wrap items-center gap-1 border-b border-edge/[0.06] px-2.5 py-1.5">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              onClick={() => setTab(tb.id)}
              className={cn(
                'rounded-full px-2 py-0.5 text-11 transition-colors',
                tab === tb.id
                  ? 'bg-edge/[0.14] text-neutral-100'
                  : 'text-neutral-500 hover:bg-edge/[0.06] hover:text-neutral-300',
              )}
            >
              {tb.label}
            </button>
          ))}
          <span className="min-w-0 flex-1" />
          <Combobox
            value={projFilter != null ? String(projFilter) : ''}
            onChange={(v) => {
              setProjFilter(v ? Number(v) : null);
              setSessionFilter(null);
            }}
            options={projectOptions}
            placeholder={t('search.filterProject')}
            align="end"
            className="max-w-40 py-0.5"
          />
          <Combobox
            value={sessionFilter ?? ''}
            onChange={(v) => setSessionFilter(v || null)}
            options={sessionOptions}
            placeholder={t('search.filterSession')}
            disabled={projFilter == null || sessionOptions.length === 0}
            align="end"
            className="max-w-40 py-0.5"
          />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 && !loading && query.trim() !== '' && !suggestsOpen && (
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
                  const expanded = preview?.row.key === row.key;
                  return (
                    <div key={row.key}>
                      <button
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
                        {row.meta && (
                          <span className="shrink-0 max-w-[40%] truncate text-11 text-neutral-500">
                            {row.meta}
                          </span>
                        )}
                        {row.copyText && (
                          <CopyButton
                            text={row.copyText}
                            tip={row.metaFull ?? row.copyText}
                            ariaLabel={t('search.copy')}
                          />
                        )}
                        {(row.groupId === 'sessions' || row.groupId === 'messages') && (
                          <ChevronRight
                            className={cn(
                              'h-3 w-3 shrink-0 text-neutral-600 transition-transform',
                              expanded && 'rotate-90',
                            )}
                          />
                        )}
                      </button>
                      {/* 聊天/会话命中行内展开上下文（不跳对话窗——历史太多滚不回去） */}
                      {expanded && preview && (
                        <div className="mb-1 ml-6 border-l-2 border-blue-500/40 pl-2.5 pr-1">
                          {preview.loading ? (
                            <p className="flex items-center gap-1.5 py-2 text-11 text-neutral-500">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {t('search.previewLoading')}
                            </p>
                          ) : preview.data && preview.data.anchored && preview.data.messages.length > 0 ? (
                            <>
                              <ul className="space-y-1 py-1">
                                {preview.data.messages.map((m) => (
                                  <li
                                    key={m.id}
                                    className={cn(
                                      'rounded px-1.5 py-1 text-11 leading-relaxed',
                                      m.hit ? 'bg-blue-500/10 text-neutral-100' : 'text-neutral-400',
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        'mr-1.5 font-medium',
                                        m.role === 'user' ? 'text-mac-accent' : 'text-neutral-500',
                                      )}
                                    >
                                      {m.role === 'user' ? t('search.roleUser') : t('search.roleAssistant')}
                                    </span>
                                    <span className="[overflow-wrap:anywhere] line-clamp-6">{m.text}</span>
                                  </li>
                                ))}
                              </ul>
                              <div className="flex items-center gap-2 py-1">
                                <button
                                  type="button"
                                  onClick={() => openSession(row)}
                                  className="rounded-md bg-neutral-800 px-2 py-0.5 text-11 text-neutral-200 hover:bg-neutral-700"
                                >
                                  {t('search.openSession')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setPreview(null)}
                                  className="rounded-md px-2 py-0.5 text-11 text-neutral-500 hover:text-neutral-300"
                                >
                                  {t('search.collapse')}
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <p className="py-1.5 text-11 text-neutral-500 [overflow-wrap:anywhere] line-clamp-6">
                                {row.detail ?? row.label}
                              </p>
                              <p className="pb-1 text-10 text-neutral-600">{t('search.previewMiss')}</p>
                              <div className="flex items-center gap-2 pb-1">
                                <button
                                  type="button"
                                  onClick={() => openSession(row)}
                                  className="rounded-md bg-neutral-800 px-2 py-0.5 text-11 text-neutral-200 hover:bg-neutral-700"
                                >
                                  {t('search.openSession')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setPreview(null)}
                                  className="rounded-md px-2 py-0.5 text-11 text-neutral-500 hover:text-neutral-300"
                                >
                                  {t('search.collapse')}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {(result?.truncated.messages || result?.truncated.files || result?.truncated.content) && (
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

/** 行尾复制钮：悬停 tooltip 展示完整内容（可选中复制），点击直写剪贴板。 */
function CopyButton({ text, tip, ariaLabel }: { text: string; tip: string; ariaLabel: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <Tooltip label={tip} side="top" className="shrink-0">
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          void copyText(text).then((ok) => setDone(ok));
        }}
        className="flex items-center rounded p-0.5 text-neutral-600 hover:text-neutral-300"
      >
        {done ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
    </Tooltip>
  );
}

function GroupIcon({ groupId, path }: { groupId: PaletteRow['groupId']; path?: string }) {
  if (groupId === 'files' || groupId === 'content') {
    const isDir = groupId === 'files' && (path?.endsWith('/') ?? false);
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
