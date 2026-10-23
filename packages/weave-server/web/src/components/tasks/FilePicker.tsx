import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, lineNumbers } from '@codemirror/view';
import { SearchCursor, SearchQuery, search, setSearchQuery } from '@codemirror/search';
import {
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  File as FileIcon,
  FileCode,
  FileImage,
  FileText,
  Folder,
  Hash,
  Loader2,
  Search,
  Square,
  TextSearch,
  X,
} from 'lucide-react';
import { api, type SessionFileEntry } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/use-media-query';
import { useTheme } from '@/lib/theme';

/**
 * 项目文件引用选择器（superfile 式三栏）：父目录 | 当前目录 | 预览。
 *
 * 路径的**表达式由服务端给**（`entry.ref` / `sessionFileRef`，harness 自己的引用
 * 文法）——这里只把它当不透明字符串交给 `onPick`，绝不自拼 `@` 或 `#L`。
 * 索引也在服务端（打开即重建），本组件只负责取一页、防抖输入、把命中的字符区间上色。
 *
 * **第三栏答「这条选中是什么」**：目录列它的直接子项（只读，下钻仍归第二栏，
 * 两栏都能进会打架），文本给只读编辑器，图片给 `<img>`。
 *
 * 手势：单击只挪光标（第三栏跟着走），**Enter 恒为「确认选择」**（目录也当引用贴），
 * 下钻只归 `→` / 双击；空格或左侧勾选框 = 加入/移出「已选」，`Ctrl/Cmd+单击` 与 `Shift+单击`（连选）
 * 是桌面加速键。触屏没有 hover 也没有修饰键：单击仍是「进入」（老手感），
 * 多选只靠勾选框——**勾选框常显**，藏起来的钮在触屏上等于没有。已选非空时
 * 底条出「插入 N 项」，一次落定一批胶囊（顺序 = 点选顺序）。
 *
 * 预览是一个**只读**的 CodeMirror：行号可点（第一下起、第二下止）。查找与跳行
 * 用自己的一条小条（`SearchQuery` + `SearchCursor`）而不是它自带的搜索面板——
 * 那面板带替换与编辑，而预览只该看。选它是因为行号槽、行号上的鼠标事件、选区
 * 绘制与匹配高亮都是现成的，手写这四件只会四件都做不好。
 */

/** 搜索输入的防抖窗：服务端一次模糊匹配 ~10ms，剩下全是省往返。 */
const SEARCH_DEBOUNCE_MS = 120;

/** 换一条选中之后的防抖窗：箭头连滑过十行不该打十次预览 / 十次子目录。 */
const SELECT_DEBOUNCE_MS = 150;

/** 本地缓存条数（目录列表 / 预览正文各一份，纯省往返）：来回看同一批文件不重取。 */
const DIR_CACHE_MAX = 30;
const TEXT_CACHE_MAX = 12;

/** 一条被选中的引用：`ref` 是服务端算好的表达式，其余是胶囊自己留的账。 */
export interface PickItem {
  ref: string;
  target: PickTarget;
}

/** 多选的加入/移出：按路径去重，**保持加入顺序**（落定时胶囊的先后 = 点选先后）。 */
export function togglePick(
  picked: readonly SessionFileEntry[],
  entry: SessionFileEntry,
): SessionFileEntry[] {
  return picked.some((p) => p.path === entry.path)
    ? picked.filter((p) => p.path !== entry.path)
    : [...picked, entry];
}

/** Shift 连选：把 `from`…`to` 之间的行并进来（已在的保持原位，新增的按列表序追加）。 */
export function rangePick(
  picked: readonly SessionFileEntry[],
  rows: readonly SessionFileEntry[],
  from: number,
  to: number,
): SessionFileEntry[] {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(rows.length - 1, Math.max(from, to));
  const out = [...picked];
  for (let i = lo; i <= hi; i++) {
    const row = rows[i];
    if (row && !out.some((p) => p.path === row.path)) out.push(row);
  }
  return out;
}

/** 缓存写一条：超上限就丢最旧（Map 的插入序就是使用序，重插即最近使用）。 */
function cacheSet<T>(cache: Map<string, T>, key: string, value: T, max: number): T {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** 图标按扩展名分组：没必要为图标拉一张语法表。 */
const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|swift|sh|ps1|sql|toml|yaml|yml)$/i;
const TEXT_EXT = /\.(md|markdown|txt|log|csv|ini|cfg|conf|env)$/i;

/** 选中一条之后要贴进输入框的东西：`ref` 是表达式原文，其余是胶囊自己留的账
 *  （编辑那枚胶囊时要能回到这个文件与这段行，前端不去解析表达式）。 */
export interface PickTarget {
  path: string;
  kind: 'file' | 'dir';
  lines?: { start: number; end: number };
}

function iconFor(entry: SessionFileEntry) {
  if (entry.kind === 'dir') return <Folder className="h-3.5 w-3.5 shrink-0 text-blue-300/80" />;
  if (IMAGE_EXT.test(entry.name)) return <FileImage className="h-3.5 w-3.5 shrink-0 text-emerald-300/80" />;
  if (CODE_EXT.test(entry.name)) return <FileCode className="h-3.5 w-3.5 shrink-0 text-amber-300/80" />;
  if (TEXT_EXT.test(entry.name)) return <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-400" />;
  return <FileIcon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />;
}

function sizeText(bytes: number | undefined): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 把命中区间切成「亮 / 暗」交替的片段（区间来自服务端，已按路径下标给好）。 */
function segmentsOf(name: string, ranges: [number, number][] | undefined): { text: string; hit: boolean }[] {
  if (!ranges || ranges.length === 0) return [{ text: name, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, len] of ranges) {
    if (start > at) out.push({ text: name.slice(at, start), hit: false });
    out.push({ text: name.slice(start, start + len), hit: true });
    at = start + len;
  }
  if (at < name.length) out.push({ text: name.slice(at), hit: false });
  return out;
}

/** 只读代码视图的样式：底透明，跟着父容器走。色值全取 CSS 变量（`data-theme`
 *  一翻就跟着翻）——写死浅色字在浅色主题下就是一片看不清。`dark` 只决定
 *  CodeMirror 自己的兜底色（光标等），跟着主题走。 */
const cmTheme = (dark: boolean): Extension =>
  EditorView.theme(
    {
      '&': { height: '100%', fontSize: '11px', color: 'rgb(var(--w-neutral-300))', backgroundColor: 'transparent' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        lineHeight: '1.5',
        overflow: 'auto',
      },
      '.cm-content': { padding: '4px 0' },
      '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'rgb(var(--w-neutral-600))' },
      // 行号是「点我」的：给个手的指针，不然没人知道它能点
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 6px', cursor: 'pointer' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent' },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      // 失焦也要看得见选中（点行号之后焦点多半在别处）
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'rgb(var(--w-blue-500) / 0.32)',
      },
      '.cm-searchMatch': { backgroundColor: 'rgb(var(--w-amber-400) / 0.35)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgb(var(--w-amber-400) / 0.6)' },
    },
    { dark },
  );

/** 主题翻的时候只重配这一格，不重建视图（重建会丢滚动位置与选区）。 */
const themeConf = new Compartment();

/** 只读代码视图。`viewRef` 由父组件持有：查找与跳行都要拿它现算。 */
function CodePreview({
  text,
  lines,
  viewRef,
  onGutterClick,
}: {
  text: string;
  lines: { start: number; end: number } | null;
  viewRef: React.MutableRefObject<EditorView | null>;
  onGutterClick: (line: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  /** 回调每次渲染都是新的，扩展只装一次——用 ref 转一手，别让扩展跟着重建。 */
  const clickRef = useRef(onGutterClick);
  clickRef.current = onGutterClick;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers({
            domEventHandlers: {
              // 返回 true = 吃掉默认行为：光标位置归我们自己摆（整行选中）。
              // 这里拿到的是块信息（`from` = 该行起点），行号要自己按文档算。
              mousedown: (view: EditorView, block: { from: number }) => {
                clickRef.current(view.state.doc.lineAt(block.from).number);
                return true;
              },
            },
          }),
          drawSelection(),
          // 只留 `search` 的**匹配高亮**（查询由外面那条自绘的小条设）。它自带的
          // 面板不做：那面板带替换与编辑，而这里只是预览。
          search({ top: true }),
          EditorView.lineWrapping,
          EditorView.editable.of(false),
          themeConf.of(cmTheme(theme === 'dark')),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 挂载那一次按当下主题建；之后换主题走下面那格重配，视图不重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRef]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeConf.reconfigure(cmTheme(theme === 'dark')) });
  }, [theme]);

  // 换文件：整篇换掉并回到顶部，上一份的查询随之作废
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
      effects: setSearchQuery.of(new SearchQuery({ search: '' })),
    });
    view.scrollDOM.scrollTop = 0;
  }, [text, viewRef]);

  // 行选区 → 编辑器选区（整行，含行尾），并把视口带过去
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !lines) return;
    const doc = view.state.doc;
    const from = doc.line(Math.min(lines.start, doc.lines)).from;
    const to = doc.line(Math.min(lines.end, doc.lines)).to;
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  }, [lines, text, viewRef]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />;
}

export function FilePicker({
  sessionId,
  rootLabel,
  linesSupported,
  dirSupported,
  initial,
  onPick,
  onClose,
}: {
  sessionId: string;
  /** 项目名：面包屑与左栏的根那一格不写 `/`，写它。 */
  rootLabel: string;
  /** harness 认不认行区间（能力矩阵的 `pathRefLines`）。 */
  linesSupported: boolean;
  /** harness 认不认目录引用（能力矩阵的 `pathRefKinds`）：false 时目录行只给「进」不给「选」。 */
  dirSupported: boolean;
  /** 编辑一枚既有胶囊：从它的路径/行区间打开，选中后替换它。 */
  initial?: PickTarget;
  /** 落定一批引用：`ref` 原样交给调用方贴进输入框（一枚 = 一次单击，多枚 = 多选批量）。 */
  onPick: (items: PickItem[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  const [query, setQuery] = useState('');
  const [dir, setDir] = useState(() => {
    if (!initial) return '';
    if (initial.kind === 'dir') return initial.path;
    return initial.path.includes('/') ? initial.path.slice(0, initial.path.lastIndexOf('/')) : '';
  });
  const [entries, setEntries] = useState<SessionFileEntry[]>([]);
  /** 父目录条目：只有桌面三栏的左栏用得上（窄屏不取）。 */
  const [siblings, setSiblings] = useState<SessionFileEntry[]>([]);
  const [total, setTotal] = useState(0);
  /** 搜索满档即停：命中的先后只是扫描序，条数是下限（文案得如实说「前 N 条」）。 */
  const [capped, setCapped] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string | null; truncated: boolean } | null>(null);
  /** 第三栏的子目录预览（选中一条目录时列它的直接子项；只读，不下钻）。 */
  const [sub, setSub] = useState<{ dir: string; entries: SessionFileEntry[]; total: number } | null>(null);
  /** 多选中的一批（顺序 = 加入顺序）。编辑既有胶囊时恒为空。 */
  const [picked, setPicked] = useState<SessionFileEntry[]>([]);
  /** Shift 连选的锚点（列表下标）。 */
  const [pickAnchor, setPickAnchor] = useState<number | null>(null);
  /** 行号选区：`anchor` 存的是「已点了起始行、等第二下」；`lines` 是生效的区间。 */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [lines, setLines] = useState<{ start: number; end: number } | null>(null);
  const [busy, setBusy] = useState(false);
  /** 窄屏一屏只放得下一栏：列表与预览是两屏，靠它切。 */
  const [screen, setScreen] = useState<'list' | 'preview'>(initial?.kind === 'file' ? 'preview' : 'list');
  /** 预览里那条小工具条：查找 / 跳到行（同一格，不会同时开）。 */
  const [bar, setBar] = useState<'find' | 'line' | null>(null);
  const [find, setFind] = useState('');
  const [jump, setJump] = useState('');
  const [hits, setHits] = useState<number | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  /** 弹窗自己收焦点：不让按键漏到背后那个输入框（它正停在 `@` 上，
   *  一个退格就把触发符删了）。 */
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 请求序号守卫：慢响应不许覆盖新结果（服务端在本机，但 LAN 下会有明显乱序）。 */
  const seq = useRef(0);
  /** 打开选择器后的第一拍：带 `fresh=1` 让服务端重建一次索引（刚建的文件才在）。 */
  const firstLoad = useRef(true);
  /** 预览单独一份守卫——它和列表是两条并行的取数，共用会把对方顶掉。 */
  const previewSeq = useRef(0);
  /** 目录列表 / 预览正文的本地缓存（箭头连滑时命中即出，不打请求）。 */
  const dirCache = useRef(new Map<string, { entries: SessionFileEntry[]; total: number }>());
  const textCache = useRef(new Map<string, { text: string | null; truncated: boolean }>());
  /** 每一波列表请求一个 controller：新的一波来就掐掉上一波，卸载也掐。 */
  const ctrlRef = useRef<AbortController | null>(null);
  /** 编辑既有引用时要落回那一条：列表一回来就选中它，然后清账。 */
  const focusPath = useRef(initial?.kind === 'file' ? initial.path : null);
  /** 键盘导航中：方向键按下后悬停不再抢选中，直到鼠标真的动一下（键盘优先）。 */
  const kbdNav = useRef(false);
  /** 当前因「选了行」而被自动勾上的那条（离开或取消行选区时按它退勾）。 */
  const rangePicked = useRef<string | null>(null);

  const load = useCallback(
    (q: string, target: string, signal: AbortSignal, fresh = false) => {
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      // 没有斜杠但非空（`src`）= 父目录是项目根 `''`；根自身没有父
      const slash = target.lastIndexOf('/');
      const parent = target === '' ? null : slash >= 0 ? target.slice(0, slash) : '';
      void Promise.all([
        api.listSessionFiles(sessionId, { q, dir: target, signal, fresh }),
        // 左栏 = 父目录的条目（根没有父，摆一行 `/` 占位）
        !q && isDesktop && parent !== null
          ? api.listSessionFiles(sessionId, { dir: parent, signal }).catch(() => null)
          : Promise.resolve(null),
      ])
        .then(([listing, parentListing]) => {
          if (mine !== seq.current) return;
          setEntries(listing.entries);
          setTotal(listing.total);
          setCapped(listing.capped ?? false);
          setTruncated(listing.truncated);
          // 搜索是全项目的、不带父目录；这时留住上一次那份，左栏不闪成空栏
          if (!q) setSiblings(parentListing?.entries ?? []);
          const want = focusPath.current;
          const at = want ? listing.entries.findIndex((e) => e.path === want) : -1;
          focusPath.current = null;
          setSelected(at >= 0 ? at : 0);
          if (at >= 0 && listing.entries[at]!.kind === 'file') setScreen('preview');
        })
        .catch((e: unknown) => {
          if (mine !== seq.current || signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          setEntries([]);
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    },
    [sessionId, isDesktop],
  );

  // 输入防抖：只有搜索框会连打，方向键与点击一律不打请求。搜索是**全项目**的
  // （索引本来就在项目级），故带 q 时 dir 归空——结果不按当前目录收窄。
  useEffect(() => {
    const timer = setTimeout(() => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      load(query.trim(), query.trim() ? '' : dir, ctrl.signal, firstLoad.current);
      firstLoad.current = false;
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, dir, load]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  // 选中项滚进视野：回上一级时那一层可能远在折叠区外
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, entries]);

  /** 第三栏要读的东西：目录 → 子项列表，文本文件 → 正文，图片 → 什么也不读（<img> 自己取）。
   *  防抖 + 缓存：hover 换行与箭头连滑是高频动作，逐行打请求既慢又白烧。 */
  const current = entries[selected];
  useEffect(() => {
    const cur = current;
    // 一律先清：上一份的东西不能挂在新选中的头上（同一拍里再填，不会闪）
    setPreview(null);
    setSub(null);
    if (!cur) return;
    const mine = ++previewSeq.current;
    const image = cur.kind === 'file' && IMAGE_EXT.test(cur.name);
    const cachedDir = cur.kind === 'dir' ? dirCache.current.get(cur.path) : undefined;
    const cachedText = cur.kind === 'file' && !image ? textCache.current.get(cur.path) : undefined;
    if (cachedDir) setSub({ dir: cur.path, ...cachedDir });
    if (cachedText) setPreview({ path: cur.path, ...cachedText });
    // 图片走 <img> 自己取字节；目录与文本命中缓存就不用再问
    if (image || cachedDir || cachedText) return;

    let alive = true;
    const timer = setTimeout(() => {
      if (cur.kind === 'dir') {
        void api
          .listSessionFiles(sessionId, { dir: cur.path, limit: 100 })
          .then((listing) => {
            if (!alive || mine !== previewSeq.current) return;
            const value = cacheSet(
              dirCache.current,
              cur.path,
              { entries: listing.entries, total: listing.total },
              DIR_CACHE_MAX,
            );
            setSub({ dir: cur.path, ...value });
          })
          .catch(() => {
            if (alive && mine === previewSeq.current) setSub({ dir: cur.path, entries: [], total: 0 });
          });
        return;
      }
      void api
        .sessionFileText(sessionId, cur.path)
        .then(({ text, truncated: cut }) => {
          if (!alive || mine !== previewSeq.current) return;
          setPreview({ path: cur.path, ...cacheSet(textCache.current, cur.path, { text, truncated: cut }, TEXT_CACHE_MAX) });
        })
        .catch(() => {
          if (!alive || mine !== previewSeq.current) return;
          setPreview({
            path: cur.path,
            ...cacheSet(textCache.current, cur.path, { text: null, truncated: false }, TEXT_CACHE_MAX),
          });
        });
    }, SELECT_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [current, sessionId]);

  // 换一条选中：选区与查找条重来；编辑既有引用时按它带来的行区间先选好。
  // 离开上一条文件 = 它那份行选区没了，勾选跟着退（只引用文件才留着手动勾）。
  useEffect(() => {
    setAnchor(null);
    setBar(null);
    setFind('');
    setJump('');
    setHits(null);
    const was = rangePicked.current;
    rangePicked.current = null;
    if (was) setPicked((p) => p.filter((e) => e.path !== was));
    const keep = current && current.kind === 'file' && current.path === initial?.path ? (initial?.lines ?? null) : null;
    setLines(keep);
    if (keep && current) {
      rangePicked.current = current.path;
      setPicked((p) => (p.some((e) => e.path === current.path) ? p : [...p, current]));
    }
  }, [current?.path, initial]);

  /** ESC 关掉选择器（焦点可能落在预览或哪儿都不在，故挂 document 上）。
   *  小工具条开着时先收它——不然一次 ESC 会连面板一起关掉。 */
  const barRef = useRef(bar);
  barRef.current = bar;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (barRef.current) setBar(null);
      else closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  /** 回到某一级时把「刚离开的那一层」选中——不然每次都从列表头上再找一遍。
   *  只认真正的祖先：`target` 为空即项目根。 */
  const goTo = (target: string): void => {
    focusPath.current = null;
    if (dir && dir !== target) {
      const rest = target ? (dir.startsWith(`${target}/`) ? dir.slice(target.length + 1) : '') : dir;
      if (rest) {
        const seg = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest;
        focusPath.current = target ? `${target}/${seg}` : seg;
      }
    }
    setQuery('');
    setDir(target);
  };

  const goUp = (): void => {
    const slash = dir.lastIndexOf('/');
    goTo(dir === '' ? '' : slash >= 0 ? dir.slice(0, slash) : '');
  };

  /** 行选区与勾选联动：选上行 ⇒ 自动勾上；取消行 ⇒ 自动取消勾。
   *  「只引用文件」没有行区间可依，仍要手动勾选或空格。 */
  const applyLines = (next: { start: number; end: number } | null): void => {
    setLines(next);
    const cur = current;
    if (!cur || cur.kind !== 'file') return;
    if (next) {
      rangePicked.current = cur.path;
      setPicked((p) => (p.some((e) => e.path === cur.path) ? p : [...p, cur]));
      return;
    }
    const was = rangePicked.current;
    rangePicked.current = null;
    if (was) setPicked((p) => p.filter((e) => e.path !== was));
  };

  /** 行号点击：第一下起、第二下止（同一行就是单行引用）；再点同一个起点 = 取消。 */
  const onGutterClick = (n: number): void => {
    if (anchor == null) {
      if (lines && lines.start === n && lines.end === n) {
        applyLines(null);
        return;
      }
      setAnchor(n);
      applyLines({ start: n, end: n });
      return;
    }
    setAnchor(null);
    // 起点上再点一下 = 不要这段行了（勾选随之退掉）
    if (anchor === n) {
      applyLines(null);
      return;
    }
    applyLines({ start: Math.min(anchor, n), end: Math.max(anchor, n) });
  };

  /** 全文命中（一次扫描同时供计数与前后跳；预览上限 1MB，够快）。 */
  const matchesOf = (view: EditorView, q: string): { from: number; to: number }[] => {
    const out: { from: number; to: number }[] = [];
    for (const cur = new SearchCursor(view.state.doc, q, 0); !cur.next().done; ) {
      out.push({ from: cur.value.from, to: cur.value.to });
    }
    return out;
  };

  const selectAt = (view: EditorView, m: { from: number; to: number }): void => {
    view.dispatch({
      selection: { anchor: m.from, head: m.to },
      effects: EditorView.scrollIntoView(m.from, { y: 'center' }),
    });
  };

  /** 打字时只落到「光标之后最近的那处」——跟着每次输入往后跳会跳过前几处。
   *  高亮由 `search` 扩展按同一个查询画。 */
  const runFind = (q: string): void => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: q })) });
    if (!q) {
      setHits(null);
      return;
    }
    const all = matchesOf(view, q);
    setHits(all.length);
    if (all.length === 0) return;
    const from = view.state.selection.main.from;
    selectAt(view, all.find((m) => m.from >= from) ?? all[0]!);
  };

  const stepMatch = (dir: 1 | -1): void => {
    const view = viewRef.current;
    if (!view || !find) return;
    const all = matchesOf(view, find);
    if (all.length === 0) return;
    const main = view.state.selection.main;
    const at = all.findIndex((m) => m.from === main.from && m.to === main.to);
    selectAt(view, all[at < 0 ? 0 : (at + dir + all.length) % all.length]!);
  };

  /** 跳到行：选中整行并居中——接着点行号就从这一行起选。 */
  const jumpTo = (): void => {
    const view = viewRef.current;
    const n = Number(jump.trim());
    if (!view || !Number.isInteger(n) || n < 1) return;
    const line = view.state.doc.line(Math.min(n, view.state.doc.lines));
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
  };

  /** 落定一条：带行区间时表达式由服务端现算（前端不拼文法）。 */
  const pick = async (entry: SessionFileEntry, withLines: boolean): Promise<void> => {
    const range = linesSupported && withLines && entry.kind === 'file' ? lines : null;
    if (!range) {
      onPick([{ ref: entry.ref, target: { path: entry.path, kind: entry.kind } }]);
      return;
    }
    setBusy(true);
    try {
      const { ref } = await api.sessionFileRef(sessionId, {
        path: entry.path,
        kind: 'file',
        start: range.start,
        end: range.end,
      });
      onPick([{ ref, target: { path: entry.path, kind: 'file', lines: range } }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 落定底条那一枚钮：有已选就整批插（顺序 = 点选顺序），否则就当前这条。
   *  带行区间的那一条要现算表达式（文法归服务端），其余直接用条目手里的 `ref`。 */
  const commit = async (): Promise<void> => {
    if (picked.length === 0) {
      if (current) await pick(current, true);
      return;
    }
    const items: PickItem[] = [];
    for (const e of picked) {
      const range = linesSupported && e.kind === 'file' && e.path === current?.path ? lines : null;
      if (!range) {
        items.push({ ref: e.ref, target: { path: e.path, kind: e.kind } });
        continue;
      }
      setBusy(true);
      try {
        const { ref } = await api.sessionFileRef(sessionId, {
          path: e.path,
          kind: 'file',
          start: range.start,
          end: range.end,
        });
        items.push({ ref, target: { path: e.path, kind: 'file', lines: range } });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    onPick(items);
  };

  /** 进一条：目录就下钻，文件则（桌面直接落定 / 窄屏先进预览）。 */
  const enter = (entry: SessionFileEntry): void => {
    if (entry.kind === 'dir') {
      setQuery('');
      setDir(entry.path);
      setScreen('list');
      return;
    }
    if (!isDesktop) {
      setScreen('preview');
      return;
    }
    if (picked.length > 0) {
      void commit();
      return;
    }
    void pick(entry, true);
  };

  /** Enter = 确认选择：有已选就整批落定，否则落定当前这条（目录也按目录引用贴）。
   *  与「进入目录」分开——下钻归 `→` / 双击，回车只管「就它了」。 */
  const confirm = (entry: SessionFileEntry): void => {
    if (picked.length > 0) {
      void commit();
      return;
    }
    if (entry.kind === 'file' || dirSupported) {
      void pick(entry, true);
      return;
    }
    // harness 不认目录引用：这一条没有可贴的东西，回车只能带路
    enter(entry);
  };

  /** 勾选/取消一条。取消的正是带行选区的那条 ⇒ 行选区跟着退（两处手势同一口径）。 */
  const toggleCurrentPick = (entry: SessionFileEntry): void => {
    const on = picked.some((p) => p.path === entry.path);
    if (on && lines && entry.path === current?.path) {
      applyLines(null);
      return;
    }
    setPicked((p) => togglePick(p, entry));
  };

  /** 方向键/回车/空格的导航。挂 document 捕获阶段：点空白处焦点会落到 `body`，
   *  那时事件目标的祖先链上没有弹窗，容器级监听根本收不到——只有 document 级
   *  才保证焦点在哪都还能用键盘。查找 / 跳行那两个小输入框除外：那里打的是字，
   *  方向键归光标。 */
  const onKeyDown = (e: KeyboardEvent): void => {
    // 输入法组字中的方向键/回车是宿主输入法的，不抢
    if (e.isComposing || e.keyCode === 229) return;
    // 查找 / 跳行那两个小输入框里，方向键归光标（它们有自己的 Enter 处理）；
    // 搜索框不同：打完词按 ↓ 进列表是主路径，故它下面的方向键照样算导航
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (inInput && e.target !== searchRef.current) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      // 键盘接管：此后鼠标只是停着不动（悬停）就不许把选中抢回去
      kbdNav.current = true;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSelected((i) => Math.min(entries.length - 1, Math.max(0, i + step)));
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goUp();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const hit = entries[selected];
      if (hit) confirm(hit);
      return;
    }
    // 空格 = 加入/移出已选。搜索框空着时也算勾选（打开就按空格是主路径），
    // 一旦打了字，空格还给查询；按钮上的空格是它自己的。
    if (e.key === ' ') {
      if (inInput) {
        if (e.target !== searchRef.current || query !== '') return;
      } else if (e.target instanceof HTMLElement && e.target.closest('button')) return;
      const hit = entries[selected];
      if (!hit) return;
      e.preventDefault();
      toggleCurrentPick(hit);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const hit = entries[selected];
      if (hit?.kind === 'dir') enter(hit);
      return;
    }
    // 打进搜索框的字：默认焦点不在输入框（不然空格就成了打字），故可打印字符
    // 一律转过去——打开选择器直接敲就是了，跟从搜索框里打一样。
    if (!inInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setQuery((q) => q + e.key);
      searchRef.current?.focus();
    }
  };

  /** 监听器只挂一次、转给当下的闭包：省得每次渲染拆装。 */
  const keyHandler = useRef(onKeyDown);
  keyHandler.current = onKeyDown;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keyHandler.current(e);
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const crumb = dir ? dir.split('/') : [];
  const rangeText = lines
    ? lines.start === lines.end
      ? t('tasks.fileLineAt', { n: lines.start })
      : t('tasks.fileLineRange', { from: lines.start, to: lines.end })
    : null;

  const list = (
    <ul
      ref={listRef}
      role="listbox"
      // 鼠标真的动了才把选中权交回悬停（键盘优先：停着不动的指针不许抢）
      onMouseMove={() => {
        kbdNav.current = false;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
    >
      {loading && entries.length === 0 && (
        <li className="flex items-center gap-2 px-3 py-6 text-[11px] text-neutral-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('tasks.fileLoading')}
        </li>
      )}
      {!loading && entries.length === 0 && (
        <li className="px-3 py-6 text-[11px] text-neutral-500">
          {error ? t('tasks.fileLoadFailed', { error }) : t('tasks.fileEmpty')}
        </li>
      )}
      {entries.map((entry, i) => {
        const name = entry.kind === 'dir' ? `${entry.name}/` : entry.name;
        // 高亮区间是对整条路径算的，落到名字上要平移
        const offset = entry.path.length - entry.name.length;
        const ranges = entry.ranges
          ?.map(([s, l]) => [s - offset, l] as [number, number])
          .filter(([s, l]) => s >= 0 && s + l <= entry.name.length);
        const checked = picked.some((p) => p.path === entry.path);
        const pickable = entry.kind === 'file' || dirSupported;
        return (
          <li key={entry.path}>
            <button
              type="button"
              role="option"
              aria-selected={i === selected}
              onMouseEnter={() => {
                // 键盘刚走过的行不许被「指针刚好停在那儿」抢回去
                if (isDesktop && !kbdNav.current) setSelected(i);
              }}
              onClick={(e) => {
                // 修饰键 = 直接多选；触屏没有 hover 也没有修饰键，单击仍走「进入」
                if (pickable && (e.ctrlKey || e.metaKey)) {
                  setSelected(i);
                  setPicked((p) => togglePick(p, entry));
                  return;
                }
                if (pickable && e.shiftKey) {
                  setPicked((p) => rangePick(p, entries, pickAnchor ?? selected, i));
                  setSelected(i);
                  setPickAnchor(i);
                  return;
                }
                setSelected(i);
                setPickAnchor(i);
                if (!isDesktop) enter(entry);
              }}
              onDoubleClick={() => isDesktop && enter(entry)}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs transition-colors',
                i === selected ? 'bg-blue-500/15 text-neutral-100' : 'text-neutral-300 hover:bg-edge/[0.04]',
              )}
            >
              {/* 勾选框常显（触屏没有 hover，藏起来的钮等于没有）：点它只改「已选」，不改变光标 */}
              <span
                role="checkbox"
                aria-checked={checked}
                aria-label={t('tasks.filePickToggle')}
                tabIndex={-1}
                onClick={(e) => {
                  if (!pickable) return;
                  e.stopPropagation();
                  toggleCurrentPick(entry);
                }}
                className={cn(
                  'shrink-0 rounded',
                  pickable ? 'cursor-pointer text-neutral-600 hover:text-neutral-300' : 'text-neutral-800',
                  checked && 'text-blue-300 hover:text-blue-200',
                )}
              >
                {checked ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
              </span>
              {iconFor(entry)}
              <span className="min-w-0 flex-1 truncate font-mono">
                {segmentsOf(name, ranges).map((seg, k) =>
                  seg.hit ? (
                    <span key={k} className="text-amber-300">
                      {seg.text}
                    </span>
                  ) : (
                    <span key={k}>{seg.text}</span>
                  ),
                )}
              </span>
              {entry.size != null && (
                <span className="shrink-0 text-[10px] tabular-nums text-neutral-600">
                  {sizeText(entry.size)}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );

  const previewPane = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge/[0.06] px-2 py-1">
        {!isDesktop && (
          <button
            type="button"
            title={t('tasks.fileBack')}
            aria-label={t('tasks.fileBack')}
            onClick={() => setScreen('list')}
            className="rounded p-0.5 text-neutral-400 hover:text-neutral-100"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-300">
          {current?.name ?? ''}
        </span>
        {current?.kind === 'file' && !IMAGE_EXT.test(current.name) && preview?.text != null && (
          <>
            <button
              type="button"
              title={t('tasks.fileFind')}
              aria-label={t('tasks.fileFind')}
              onClick={() => setBar(bar === 'find' ? null : 'find')}
              className={cn(
                'rounded p-0.5 hover:text-neutral-100',
                bar === 'find' ? 'text-blue-300' : 'text-neutral-400',
              )}
            >
              <TextSearch className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title={t('tasks.fileGoToLine')}
              aria-label={t('tasks.fileGoToLine')}
              onClick={() => setBar(bar === 'line' ? null : 'line')}
              className={cn(
                'rounded p-0.5 hover:text-neutral-100',
                bar === 'line' ? 'text-blue-300' : 'text-neutral-400',
              )}
            >
              <Hash className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      {/* 查找 / 跳到行：自己这一条，不留 CodeMirror 那个带替换的面板。
          预览是只读的，ESC 先收它、再关整个选择器。 */}
      {bar && (
        <div className="flex shrink-0 items-center gap-1 border-b border-edge/[0.06] px-1.5 py-1">
          <input
            autoFocus
            value={bar === 'find' ? find : jump}
            inputMode={bar === 'line' ? 'numeric' : undefined}
            onChange={(e) => {
              if (bar === 'find') {
                setFind(e.target.value);
                runFind(e.target.value);
              } else {
                setJump(e.target.value);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key !== 'Enter') return;
              e.preventDefault();
              e.stopPropagation();
              if (bar === 'find') stepMatch(e.shiftKey ? -1 : 1);
              else jumpTo();
            }}
            placeholder={bar === 'find' ? t('tasks.fileFindPlaceholder') : t('tasks.fileLinePlaceholder')}
            className="min-w-0 flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-0.5 text-[11px] text-neutral-100 focus:border-blue-500/40 focus:outline-none"
          />
          {bar === 'find' ? (
            <>
              <span className="shrink-0 text-[10px] tabular-nums text-neutral-500">
                {hits == null ? '' : hits === 0 ? t('tasks.fileNoMatch') : t('tasks.fileMatchCount', { n: hits })}
              </span>
              <button
                type="button"
                title={t('tasks.filePrevMatch')}
                aria-label={t('tasks.filePrevMatch')}
                onClick={() => stepMatch(-1)}
                className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-100"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title={t('tasks.fileNextMatch')}
                aria-label={t('tasks.fileNextMatch')}
                onClick={() => stepMatch(1)}
                className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-100"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={jumpTo}
              className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-[11px] text-blue-200 hover:bg-blue-500/30"
            >
              {t('tasks.fileGo')}
            </button>
          )}
          <button
            type="button"
            title={t('tasks.fileClearSearch')}
            aria-label={t('tasks.fileClearSearch')}
            onClick={() => setBar(null)}
            className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {current?.kind === 'dir' ? (
        // 第三栏选中目录时列它的直接子项：**只读**，进入仍归第二栏（双击 / →），
        // 两栏都能下钻会打架。列不下就明说还有多少（不假装列全了）。
        <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
          {sub?.dir === current.path ? (
            sub.entries.length === 0 ? (
              <li className="px-2.5 py-3 text-[11px] text-neutral-600">{t('tasks.fileEmpty')}</li>
            ) : (
              sub.entries.map((child) => (
                <li
                  key={child.path}
                  className="flex items-center gap-2 px-2.5 py-0.5 text-[11px] text-neutral-400"
                >
                  {iconFor(child)}
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {child.kind === 'dir' ? `${child.name}/` : child.name}
                  </span>
                  {child.size != null && (
                    <span className="shrink-0 text-[10px] tabular-nums text-neutral-600">
                      {sizeText(child.size)}
                    </span>
                  )}
                </li>
              ))
            )
          ) : (
            <li className="flex items-center gap-2 px-2.5 py-3 text-[11px] text-neutral-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('tasks.fileLoading')}
            </li>
          )}
        </ul>
      ) : current && IMAGE_EXT.test(current.name) ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
          <img
            src={api.sessionFileUrl(sessionId, current.path)}
            alt={current.name}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ) : current?.kind === 'file' ? (
        preview?.path === current.path && preview.text != null ? (
          <CodePreview text={preview.text} lines={lines} viewRef={viewRef} onGutterClick={onGutterClick} />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-3 text-[11px] text-neutral-500">
            {preview?.path === current.path ? t('tasks.fileNoPreview') : t('tasks.fileLoading')}
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1" />
      )}
      {/* 底条：行选区 + 落定钮。行号在这条里只是一个「选了几行」的读数，
          真正贴进 prompt 的表达式由服务端按 harness 文法算。 */}
      {current && (current.kind === 'file' || dirSupported) && (
        <div className="flex shrink-0 items-center gap-2 border-t border-edge/[0.06] px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-500">
            {current.kind === 'dir' ? (
              t('tasks.fileSubCount', { n: sub?.dir === current.path ? sub.total : 0 })
            ) : (
              <>
                {preview?.truncated && (
                  <span className="mr-1 text-amber-500/80">{t('tasks.fileTruncatedNote')}</span>
                )}
                {rangeText ?? (linesSupported ? t('tasks.fileLineHint') : '')}
              </>
            )}
          </span>
          {/* 桌面这条钮与「双击 / Enter 落定」重复，只留给触屏：那边没有
              Enter、双击也不进预览，不摆一枚钮就无路可走（§11）。 */}
          <button
            type="button"
            disabled={busy || (current.kind === 'file' && preview?.text == null)}
            onClick={() => void pick(current, true)}
            className="hidden shrink-0 items-center gap-1 rounded bg-blue-500/20 px-2 py-1 text-[11px] text-blue-200 transition-colors hover:bg-blue-500/30 disabled:opacity-40 max-lg:flex"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {current.kind === 'dir'
              ? t('tasks.fileInsertDir')
              : rangeText
                ? t('tasks.fileInsertLines')
                : t('tasks.fileInsert')}
          </button>
        </div>
      )}
    </div>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 max-lg:p-0"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="flex h-[70dvh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-edge/[0.08] bg-neutral-900 shadow-mac focus:outline-none max-lg:h-full max-lg:max-w-none max-lg:rounded-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头：面包屑 + 搜索 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-edge/[0.06] px-3 py-2">
          <button
            type="button"
            title={t('tasks.fileUp')}
            aria-label={t('tasks.fileUp')}
            disabled={crumb.length === 0}
            onClick={goUp}
            className="rounded p-1 text-neutral-400 transition-colors hover:text-neutral-100 disabled:opacity-30"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-400">
            {query.trim() ? (
              // 搜索是全项目的，这时把目录面包屑换成范围说明，免得看成本目录
              <span className="text-neutral-500">
                {t('tasks.fileSearchScope')} · <span className="text-neutral-300">{query.trim()}</span>
              </span>
            ) : (
              <>
                <button type="button" onClick={() => goTo('')} className="hover:text-neutral-200">
                  {rootLabel}
                </button>
                {crumb.map((seg, i) => (
                  <span key={`${seg}-${i}`}>
                    {'/'}
                    <button
                      type="button"
                      onClick={() => goTo(crumb.slice(0, i + 1).join('/'))}
                      className="text-neutral-300 hover:text-neutral-100"
                    >
                      {seg}
                    </button>
                  </span>
                ))}
              </>
            )}
          </div>
          <div className="relative w-56 shrink-0 max-lg:w-40">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-600" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('tasks.fileSearchPlaceholder')}
              className="w-full rounded border border-edge/[0.1] bg-neutral-950 py-1 pl-7 pr-6 text-[11px] text-neutral-100 focus:border-blue-500/40 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label={t('tasks.fileClearSearch')}
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-neutral-600 hover:text-neutral-300"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <button
            type="button"
            title={t('tasks.messagesClose')}
            aria-label={t('tasks.messagesClose')}
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:text-neutral-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 体：父目录 | 当前目录 | 预览。窄屏一屏一栏（列表 ⇄ 预览）。
            键盘处理只挂在列表这一侧——预览里是编辑器，方向键归它。 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {isDesktop ? (
              <>
                {/* 左栏 = 父目录（superfile 那套）：横向跳同级目录用。文件只是给个
                    上下文、只有目录可点（点文件没有去处）；站在项目根时父就是自己，
                    那一格是项目名，三栏恒在、不塌成两栏。 */}
                <div className="flex w-40 shrink-0 flex-col border-r border-edge/[0.06]">
                  <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
                    {dir === '' ? (
                      <li className="flex items-center gap-2 bg-blue-500/15 px-2.5 py-1 text-[11px] text-neutral-100">
                        <Folder className="h-3.5 w-3.5 shrink-0 text-blue-300/80" />
                        <span className="truncate">{rootLabel}</span>
                      </li>
                    ) : (
                      siblings.map((sib) =>
                        sib.kind === 'dir' ? (
                          <li key={sib.path}>
                            <button
                              type="button"
                              onClick={() => {
                                setQuery('');
                                setDir(sib.path);
                              }}
                              className={cn(
                                'flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11px]',
                                sib.path === dir
                                  ? 'bg-blue-500/15 text-neutral-100'
                                  : 'text-neutral-400 hover:bg-edge/[0.04] hover:text-neutral-200',
                              )}
                            >
                              {iconFor(sib)}
                              <span className="truncate font-mono">
                                {sib.name}
                                {sib.path === dir ? '/' : ''}
                              </span>
                            </button>
                          </li>
                        ) : (
                          <li
                            key={sib.path}
                            className="flex items-center gap-2 px-2.5 py-1 text-[11px] text-neutral-600"
                          >
                            {iconFor(sib)}
                            <span className="truncate font-mono">{sib.name}</span>
                          </li>
                        ),
                      )
                    )}
                  </ul>
                </div>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">{list}</div>
                <div className="flex w-2/5 shrink-0 flex-col border-l border-edge/[0.06]">{previewPane}</div>
              </>
            ) : screen === 'list' ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">{list}</div>
            ) : (
              previewPane
            )}
          </div>
          {/* 已选条：有勾选就整批落定（顺序 = 点选顺序）。窄屏也摆——触屏只能靠它 */}
          {picked.length > 0 && (
            <div className="flex shrink-0 items-center gap-2 border-t border-edge/[0.06] bg-blue-500/[0.06] px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[11px] text-blue-200">
                {t('tasks.filePickedCount', { n: picked.length })}
                <span className="ml-1.5 truncate font-mono text-[10px] text-neutral-500">
                  {picked.map((p) => p.name).join('、')}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setPicked([])}
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-100"
              >
                {t('tasks.fileClearPicked')}
              </button>
              <button
                type="button"
                onClick={() => void commit()}
                className="flex shrink-0 items-center gap-1 rounded bg-blue-500/25 px-2 py-1 text-[11px] text-blue-100 transition-colors hover:bg-blue-500/40"
              >
                {t('tasks.fileInsertPicked', { n: picked.length })}
              </button>
            </div>
          )}
          {/* 底条：条数 / 截断提示 */}
          <div className="flex shrink-0 items-center gap-2 border-t border-edge/[0.06] px-3 py-1.5 text-[10px] text-neutral-600">
            <span>
              {query
                ? t(capped ? 'tasks.fileHitsTop' : 'tasks.fileHits', { n: total })
                : t('tasks.fileCount', { n: total })}
            </span>
            {truncated && <span className="text-amber-500/80">{t('tasks.fileTruncated')}</span>}
            {/* 按键说明逐块摆：一整串挤在一格里，深色底上等于一团灰字 */}
            <span className="ml-auto hidden items-center gap-1 lg:flex">
              {t('tasks.fileHint')
                .split(' · ')
                .map((chunk) => (
                  <kbd
                    key={chunk}
                    className="rounded border border-edge/[0.14] bg-neutral-950 px-1.5 py-0.5 font-sans text-[10px] font-normal text-neutral-400"
                  >
                    {chunk}
                  </kbd>
                ))}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
