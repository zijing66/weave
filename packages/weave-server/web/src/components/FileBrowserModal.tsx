import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { EditorView } from '@codemirror/view';
import { SearchCursor } from '@codemirror/search';
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Copy,
  Download,
  AlignLeft,
  Eye,
  FileCode,
  Folder,
  Hash,
  Loader2,
  Maximize,
  Minimize,
  RefreshCw,
  Search,
  TextSearch,
  WrapText,
  X,
} from 'lucide-react';
import { api, type ProjectFileEntry, type ProjectRow, type SearchFileHit } from '@/lib/api';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/Toast';
import { copyText } from '@/lib/clipboard';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useBackPop } from '@/lib/back-pop';
import { useMediaQuery } from '@/lib/use-media-query';
import { splitFrontmatter } from '@/lib/markdown';
import { FrontmatterCard } from '@/components/FrontmatterCard';
import { markdownPre } from '@/components/ui/mermaid-block';
import { MarqueeText } from '@/components/tasks/conv-widgets';
import {
  CodePreview,
  HeadBadge,
  dirBadge,
  iconFor,
  segmentsOf,
  setFindRanges,
  sizeText,
  useFinderColumns,
} from './tasks/FilePicker';
import {
  FileColumnsBrowser,
  FinderColumnList,
  MobileFadePanels,
  useColumnWidths,
} from '@/components/FileColumnsBrowser';
import { Resizer } from '@/components/Resizer';

/**
 * 项目文件资源浏览器（只读 modal）：FilePicker 的项目级全量版——同样的三栏
 * （父目录 | 当前目录 | 预览）、同样的列表行与只读 CodeMirror，但没有「引用」
 * 这一层：不贴胶囊、不勾选、不落定，纯粹浏览 + 搜索 + 预览。入口 = 项目卡
 * 快捷按钮与全局搜索（Ctrl+K）的文件结果。
 *
 * **只读边界**（用户裁决）：查找（匹配高亮 + 上/下一个）与跳行保留；替换、
 * 保存、写端点一律不做——CodePreview 恒 `editable.of(false)`。
 *
 * 全屏照 SessionMessages 先例：面板类切 `fixed inset-0`（z-[55]，在右栏之上、
 * 菜单/弹窗之下），ESC 链里全屏优先于关闭。本组件恒为 portal，全屏只换面板类、
 * 不切挂载点。
 */

/** 搜索输入的防抖窗（FilePicker 同款）。 */
const SEARCH_DEBOUNCE_MS = 120;

/** 三栏宽度的 sessionStorage 键（会话级记忆：重开弹窗还在，重开浏览器归位）。 */
const SPLIT_KEY = 'weave:file-browser-split';

/** 触屏长按 = 右键的等价动作（ProjectList 同款参数）。 */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 8;

/** 项目绝对根 + 条目相对路径：分隔符跟服务端给的 root 走（root 是本机原生
 *  形态，Windows 反斜杠 / POSIX 正斜杠），绝不自己定；根可能有尾斜杠，归一掉。
 *  根空时只剩相对路径。rel 内部已是正斜杠（服务端相对路径口径），整体替换成
 *  root 的分隔符。含空格的路径按各 OS 的「复制文件地址」惯例包一层双引号
 *  （Windows 资源管理器同款；POSIX shell 也认），无空格保持裸路径——
 *  `quoted` 缺省开，展示用途（头部完整路径）传 false 免引号。 */
const joinAbsPath = (root: string, rel: string, quoted = true): string => {
  if (!root) return rel;
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  const full = `${base}${sep}${rel.replaceAll('/', sep)}`;
  return quoted && full.includes(' ') ? `"${full}"` : full;
};

/** 换一条选中之后的防抖窗：箭头连滑过十行不该打十次预览。 */
const SELECT_DEBOUNCE_MS = 150;

/** 本地缓存条数（目录列表 / 预览正文各一份，纯省往返）。 */
const DIR_CACHE_MAX = 30;
const TEXT_CACHE_MAX = 12;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** markdown 复用全局渲染管线（FileViewer 同款）。 */
const MARKDOWN_EXT = /\.(md|markdown)$/i;

/** iframe 预览型（服务端给真实 content-type + sandbox 头）。 */
const IFRAME_EXT = /\.(html?|svg|pdf)$/i;

/** 下载型（服务端给 attachment；浏览器转交本地应用/下载管理器）。 */
const DOWNLOAD_EXT = /\.(docx?|xlsx?|pptx?|zip|gz|tar|rar|7z|exe|dll|bin|woff2?|ttf|otf|ico|mp4|mp3|wav|mov)$/i;

/** 预览分派：这张文件在第三栏怎么摆。 */
type PreviewKind = 'image' | 'iframe' | 'download' | 'text';
const previewKindOf = (name: string): PreviewKind =>
  IMAGE_EXT.test(name) ? 'image' : IFRAME_EXT.test(name) ? 'iframe' : DOWNLOAD_EXT.test(name) ? 'download' : 'text';

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

/** markdown 预览：FileViewer 同款管线（frontmatter 卡 + remark-gfm + 代码高亮）。 */
function MarkdownPreview({ text }: { text: string }) {
  const parsed = splitFrontmatter(text);
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-4">
      {parsed.frontmatter && <FrontmatterCard data={parsed.frontmatter} />}
      <div className="prose prose-invert prose-sm max-w-none [&_pre]:whitespace-pre-wrap [&_pre]:overflow-x-hidden [&_a]:break-all [&_code]:break-words [&_code]:whitespace-pre-wrap [&_table]:block [&_table]:overflow-x-auto">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: markdownPre }}>
          {parsed.body}
        </ReactMarkdown>
      </div>
    </div>
  );
}

export function FileBrowserModal({
  projectId,
  projectName,
  path,
  projects,
  onClose,
}: {
  projectId: number;
  /** 项目名：面包屑根与左栏的根那一格写它，不写 `/`。 */
  projectName: string;
  /** 初始定位：文件 → 落在其目录并直接预览；目录 → 落在该目录。 */
  path?: string;
  /** 全项目模式（Ctrl+B）：给全部活跃项目——中栏第一屏列项目，点项目就地进入
   *  该项目（同一弹窗切换 projectId），面包屑退回根时回到项目列表。 */
  projects?: ProjectRow[];
  onClose: () => void;
}) {
  const t = useT();
  const { show } = useToast();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  /** 长按只在粗指针下挂（鼠标不该有长按，§11 同款口径）。 */
  const finePointer = useMediaQuery('(pointer: fine)');

  const [query, setQuery] = useState('');
  const [dir, setDir] = useState(() => {
    if (!path) return '';
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  });
  const [entries, setEntries] = useState<ProjectFileEntry[]>([]);
  const [total, setTotal] = useState(0);
  /** 搜索满档即停：命中的先后只是扫描序，条数是下限（文案得如实说「前 N 条」）。 */
  const [capped, setCapped] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string | null; truncated: boolean } | null>(null);
  /** 第三栏的子目录预览（选中一条目录时列它的直接子项；只读，不下钻）。 */
  const [sub, setSub] = useState<{ dir: string; entries: ProjectFileEntry[]; total: number } | null>(null);
  /** 窄屏可操作栏恒为中栏（MobileFadePanels 的窄条只是提示层不可点），
   *  screen 已随该裁决退役——导航动作只改中栏内容。
   *  窄屏「到底」态：点了文件，中栏整个切进文件预览（路径/渲染⇄原始/查找/
   *  跳行/正文满宽可用）；进目录或返回列表即清。桌面不用（右栏本就满宽）。 */
  const [viewing, setViewing] = useState<ProjectFileEntry | null>(null);
  /** 预览里那条小工具条：查找 / 跳到行（同一格，不会同时开）。 */
  const [bar, setBar] = useState<'find' | 'line' | null>(null);
  const [find, setFind] = useState('');
  /** 查找大小写敏感开关：默认不敏感（Aa 按钮切）。 */
  const [matchCase, setMatchCase] = useState(false);
  const [jump, setJump] = useState('');
  const [hits, setHits] = useState<number | null>(null);
  /** 全屏（SessionMessages 先例）：面板类切换，ESC 链里优先于关闭。 */
  const [fullscreen, setFullscreen] = useState(false);
  /** 三栏拖宽（只桌面）：sessionStorage 会话级记忆，重开弹窗还在。 */
  const { leftW, setLeftW, previewW, setPreviewW } = useColumnWidths(SPLIT_KEY);
  /** 首屏两栏分界：记比例（0.1–0.9，随窗口缩放跟着走），null = 未拖过 = 居中。 */
  const [homeSplit, setHomeSplit] = useState<number | null>(() => {
    const v = Number(sessionStorage.getItem(`${SPLIT_KEY}:home`));
    return Number.isFinite(v) && v >= 0.1 && v <= 0.9 ? v : null;
  });
  useEffect(() => {
    if (homeSplit != null) sessionStorage.setItem(`${SPLIT_KEY}:home`, String(homeSplit));
  }, [homeSplit]);
  const homeBodyRef = useRef<HTMLDivElement>(null);
  /** 拖动：增量换算成比例落库（容器宽实时读，比例不写死像素）。 */
  const homeSplitDrag = (d: number): void => {
    const w = homeBodyRef.current?.clientWidth;
    if (!w) return;
    setHomeSplit((r) => Math.min(0.9, Math.max(0.1, (r ?? 0.5) + d / w)));
  };

  const searchRef = useRef<HTMLInputElement>(null);
  /** 弹窗自己收焦点：不让按键漏到背后的页面。 */
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 请求序号守卫：慢响应不许覆盖新结果（LAN 下会有明显乱序）。 */
  const seq = useRef(0);
  /** 打开后的第一拍带 `fresh=1`：旧账毫秒级先出，服务端后台重建、随后静默补一发换新账。 */
  const firstLoad = useRef(true);
  /** 预览单独一份守卫——它和列表是两条并行的取数，共用会把对方顶掉。 */
  const previewSeq = useRef(0);
  /** 目录列表 / 预览正文的本地缓存（箭头连滑时命中即出，不打请求）。 */
  const dirCache = useRef(new Map<string, { entries: ProjectFileEntry[]; total: number }>());
  const textCache = useRef(new Map<string, { text: string | null; truncated: boolean }>());
  /** 每波列表请求一个 controller：新的一波来就掐掉上一波，卸载也掐。 */
  const ctrlRef = useRef<AbortController | null>(null);
  /** 初始定位要落的那一条：列表一回来就选中它，然后清账。 */
  const focusPath = useRef<string | null>(path ?? null);
  /** 键盘导航中：方向键按下后悬停不再抢选中，直到鼠标真的动一下（键盘优先）。 */
  const kbdNav = useRef(false);
  /** 用户是否亲手选过行（hover/点击/方向键）：置位后列表回来自动不再跳回第一行。 */
  const userTouched = useRef(false);
  /** 项目绝对根（服务端每拍都带）：复制绝对路径与头部完整路径都拼它。 */
  const [root, setRoot] = useState('');
  /** 行右键菜单（桌面右键 / 触屏长按）：只有一项——复制绝对路径。 */
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; entry: ProjectFileEntry } | null>(null);
  /** 全项目第一屏的选中项目（↑↓/Enter 与 hover 共用；进入文件树后闲置）。 */
  const [projSelected, setProjSelected] = useState(0);
  /** markdown 原始视图开关（默认渲染视图）：查找/跳行只认原始视图——渲染成
   *  prose 之后 CodeMirror 不在了，高亮与跳转没有落点。换文件重置回预览。 */
  const [rawView, setRawView] = useState(false);
  /** 原始格式预览的自动换行开关（CodeMirror lineWrapping；默认开）。 */
  const [wrapText, setWrapText] = useState(true);
  /** 窄屏搜索框展开态：默认收成图标，点开聚焦，清词失焦收回。 */
  const [searchOpen, setSearchOpen] = useState(false);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  /** 全项目模式：null = 还没进任何项目（首屏，主区列项目）；非 null = 已进入。
   *  面包屑点根（goTo('')）只停在该项目根，出项目走返回链的 exitOneLevel。 */
  const [picked, setPicked] = useState<ProjectRow | null>(null);
  /** 首屏聚焦的项目（未进项目时）：聚焦即在中栏渲染它的根目录列表、右栏预览
   *  跟随选中行——与进项目后「聚焦渲染、点击进入」同构。 */
  const [focused, setFocused] = useState<ProjectRow | null>(null);
  /** 数据面生效的 projectId/projectName：进项目跟 picked，首屏跟 focused。 */
  const activeProjectId = picked?.id ?? focused?.id ?? projectId;
  const activeProjectName = picked?.name ?? focused?.name ?? projectName;
  /** 路过每一层的账（层级递进本身）：父级列的数据源，键 = `projectId:path`。
   *  切项目清账——上一个项目的层对下一个项目没有意义。 */
  const visited = useRef(new Map<string, { entries: ProjectFileEntry[]; total: number }>());
  // 父级列数据（桌面左栏与窄屏左栏共用）：未进项目（dir=''）时为空——左栏摆项目列表
  const finderCols = useFinderColumns(
    activeProjectId,
    picked ? dir : '',
    picked !== null,
    visited,
  );

  const load = useCallback(
    (q: string, target: string, signal: AbortSignal, fresh = false): Promise<void> => {
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      return api
        .listProjectFiles(activeProjectId, { q, dir: target, signal, fresh })
        .then((listing) => {
          if (mine !== seq.current) return;
          setRoot(listing.root);
          setEntries(listing.entries);
          setTotal(listing.total);
          setCapped(listing.capped ?? false);
          setTruncated(listing.truncated);
          // 层级递进的账留给父级列：你来时的每一层都在这儿（不为此单独发请求）
          visited.current.set(`${activeProjectId}:${target}`, { entries: listing.entries, total: listing.total });
          const want = focusPath.current;
          const at = want ? listing.entries.findIndex((e) => e.path === want) : -1;
          focusPath.current = null;
          // 父组件重渲会换 projects 引用 → 防抖 effect 同参重跑：这种重复 load
          // 不许重置选中（focusPath 已被首次消费，else 分支会把「返回聚焦」打回
          // 第一行）。只有参数真的变了（换目录/换词/换项目）才落 0 或定位。
          const key = `${activeProjectId}:${target}:${q}`;
          const sameAsLast = lastLoadKeyRef.current === key;
          lastLoadKeyRef.current = key;
          if (userTouched.current) {
            setSelected((i) => Math.min(i, listing.entries.length - 1));
          } else if (sameAsLast) {
            // 同参重跑：选中保持现状（不跳 0、不覆盖）
          } else {
            setSelected(at >= 0 ? at : 0);
          }
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
    [activeProjectId, visited],
  );

  // 输入防抖：只有搜索框会连打，方向键与点击一律不打请求。搜索范围 = 当前目录
  // 的子树（dir 照传，服务端按它收窄）——换目录时搜索结果跟着换范围。
  /** 上一波 load 的 (project, dir, q)：同参重复 load 不重置选中（见 load 内）。 */
  const lastLoadKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!picked && !focused && projects) return; // 全项目第一屏还没聚焦：无数据面可拉
    const timer = setTimeout(() => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      const fresh = firstLoad.current;
      firstLoad.current = false;
      // fresh 拍端的是旧账（服务端后台重建中）：等它回来再静默补一发（此刻重建
      // 必然已在飞，搭车拿新账）；用户已输入/换目录（seq 前进了）就让位
      void load(query.trim(), dir, ctrl.signal, fresh).then(() => {
        if (!fresh || ctrl.signal.aborted) return;
        const mine = seq.current;
        return api
          .listProjectFiles(activeProjectId, { q: query.trim(), dir, signal: ctrl.signal, fresh: true })
          .then((listing) => {
            if (mine !== seq.current || ctrl.signal.aborted) return;
            setEntries(listing.entries);
            setTotal(listing.total);
            setCapped(listing.capped ?? false);
            setTruncated(listing.truncated);
          })
          .catch(() => {});
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, dir, load, activeProjectId, picked, projects]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  // 手动索引重建（懒语义）：点按钮才定向重扫当前目录子树，await 新账回来后重拉列表。
  const [refreshing, setRefreshing] = useState(false);
  const refreshIndex = (): void => {
    if (refreshing || !activeProjectId) return;
    setRefreshing(true);
    api
      .refreshProjectFilesDir(activeProjectId, dir)
      .catch(() => {})
      .then(() => {
        // 重扫完成后静默重拉当前目录（沿用既有 load，带新索引的常规一拍）
        const ctrl = new AbortController();
        ctrlRef.current = ctrl;
        return load(query.trim(), dir, ctrl.signal);
      })
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  // 选中项滚进视野：回上一级时那一层可能远在折叠区外（项目列表同理，见 projectListShown）
  const projScrollRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, entries]);
  useEffect(() => {
    projScrollRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [projSelected]);

  /** 第三栏要读的东西：目录 → 子项列表，文本文件 → 正文；图片/iframe/下载型
   *  什么也不读（<img>/<iframe>/<a download> 自己取字节）。
   *  防抖 + 缓存：hover 换行与箭头连滑是高频动作，逐行打请求既慢又白烧。 */
  const current = entries[selected];

  useEffect(() => {
    const cur = current;
    // 一律先清：上一份的东西不能挂在新选中的头上（同一拍里再填，不会闪）
    setPreview(null);
    setSub(null);
    if (!cur) return;
    const mine = ++previewSeq.current;
    const passthrough = cur.kind === 'file' && previewKindOf(cur.name) !== 'text';
    const cachedDir = cur.kind === 'dir' ? dirCache.current.get(cur.path) : undefined;
    const cachedText = cur.kind === 'file' && !passthrough ? textCache.current.get(cur.path) : undefined;
    if (cachedDir) setSub({ dir: cur.path, ...cachedDir });
    if (cachedText) setPreview({ path: cur.path, ...cachedText });
    // 图片/iframe/下载型自己取字节；目录与文本命中缓存就不用再问
    if (passthrough || cachedDir || cachedText) return;

    let alive = true;
    const timer = setTimeout(() => {
      if (cur.kind === 'dir') {
        void api
          .listProjectFiles(activeProjectId, { dir: cur.path, limit: 100 })
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
        .projectFileText(activeProjectId, cur.path)
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
  }, [current, activeProjectId]);

  /** 行号选区已退役（用户裁决：那是引用选择器的行为，浏览器不需要）——
   *  CodePreview 的 `lines`/`onGutterClick` 传空壳，行号纯展示。 */

  // 换一条选中：查找条重来；markdown 回到渲染视图
  useEffect(() => {
    setBar(null);
    setFind('');
    setJump('');
    setHits(null);
    setRawView(false);
  }, [current?.path]);

  /** ESC 逐层退：查找条 → 全屏 → 关 modal（焦点可能在预览里，挂 document 捕获阶段）。 */
  const barRef = useRef(bar);
  barRef.current = bar;
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const viewingRef = useRef<ProjectFileEntry | null>(viewing);
  viewingRef.current = viewing;
  const rawViewRef = useRef(rawView);
  rawViewRef.current = rawView;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** 全项目模式退回项目列表第一屏（ESC 链与移动端返回共用）：退到根先是这层，
   *  再退才轮到 onClose。返回 false/true 表达「层退完了没」。 */
  const backOfPickedRef = useRef(false);
  backOfPickedRef.current = !!(projects && picked);
  const exitOneLevel = (): boolean => {
    if (backOfPickedRef.current) {
      setPicked(null);
      userTouched.current = false;
      return true;
    }
    return false;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (barRef.current) setBar(null);
      else if (fullscreenRef.current) setFullscreen(false);
      else if (exitOneLevel()) return;
      else closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // 原始格式预览的快捷键：Ctrl+F 查找 / Ctrl+G 跳到行（bar 已开则切到另一格）。
  // 文本文件预览在场上就拦（preventDefault 不给浏览器 find/搜索抢键）——markdown
  // 渲染态 Ctrl+F 顺手切到原始视图并开查找（渲染态没有高亮落点，先回原始才有处找）；
  // 目录/图片/iframe 里没意义，不拦（浏览器默认照走）。
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const cur = currentRef.current;
      if (!cur || cur.kind !== 'file') return;
      if (previewKindOf(cur.name) !== 'text') return;
      const k = e.key.toLowerCase();
      if (k !== 'f' && k !== 'g') return;
      e.preventDefault();
      e.stopPropagation();
      if (MARKDOWN_EXT.test(cur.name) && !rawViewRef.current) {
        // 渲染态：Ctrl+F = 回原始视图并开查找；Ctrl+G 渲染态没有行号可跳，只吞键
        if (k === 'f') {
          setRawView(true);
          setBar('find');
        }
        return;
      }
      setBar((b) => (k === 'f' ? (b === 'find' ? null : 'find') : b === 'line' ? null : 'line'));
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  /** 移动端返回键/侧滑：先归弹窗自己的层（工具条 → 预览回列表 → 清搜索 →
   *  回上一级），退无可退才关弹窗——「返回上一级优先」由 onBack 返回 false
   *  表达（层没退完，钩子补一枚历史记录让下一次返回继续归它）。 */
  useBackPop(true, () => {
    if (barRef.current) {
      setBar(null);
      return true;
    }
    if (fullscreenRef.current) {
      setFullscreen(false);
      return true;
    }
    // 窄屏「到底」态：先退回目录列表，再逐层往下退
    if (!isDesktop && viewingRef.current) {
      setViewing(null);
      return true;
    }
    if (query !== '') {
      setQuery('');
      return true;
    }
    if (dir !== '') {
      goUp();
      return false;
    }
    if (exitOneLevel()) return true;
    closeRef.current();
    return true;
  });

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
    // 全项目模式退回根 = 停在该项目的文件树根（picked 不动：返回上一级的终点
    // 是项目根，再退一次才轮到 exitOneLevel 出项目回项目列表第一屏）
    userTouched.current = false;
    setQuery('');
    setViewing(null);
    setDir(target);
  };

  const goUp = (): void => {
    if (dir === '') {
      // 全项目模式站在文件树根：上一级 = 项目列表第一屏
      exitOneLevel();
      return;
    }
    const slash = dir.lastIndexOf('/');
    goTo(dir === '' ? '' : slash >= 0 ? dir.slice(0, slash) : '');
  };

  /** 行右键菜单：桌面右键直开；触屏长按等价（粗指针才挂，位移即取消——滑动
   *  列表不是长按）。抬手补的那个 click 要吞掉，否则它顺带改选中。 */
  const suppressRowClick = useRef(false);
  const rowPress = useRef<{ x: number; y: number; timer: number } | null>(null);
  const clearRowPress = (): void => {
    if (!rowPress.current) return;
    window.clearTimeout(rowPress.current.timer);
    rowPress.current = null;
  };
  const openRowMenu = (entry: ProjectFileEntry, x: number, y: number): void => {
    setRowMenu({ x, y, entry });
  };
  const onRowPointerDown = (entry: ProjectFileEntry) => (e: React.PointerEvent): void => {
    suppressRowClick.current = false;
    if (finePointer || e.button !== 0) return;
    const { clientX: x, clientY: y } = e;
    const timer = window.setTimeout(() => {
      rowPress.current = null;
      suppressRowClick.current = true;
      // 触屏长按浏览器会顺带起文字选区：菜单弹出前清掉，菜单里不留蓝影
      window.getSelection()?.removeAllRanges();
      openRowMenu(entry, x, y);
    }, LONG_PRESS_MS);
    rowPress.current = { x, y, timer };
  };
  const onRowPointerMove = (e: React.PointerEvent): void => {
    const p = rowPress.current;
    if (!p) return;
    if (Math.abs(e.clientX - p.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - p.y) > LONG_PRESS_SLOP) {
      clearRowPress();
    }
  };
  /** 项目行长按/右键 = 同款菜单（项目根当作一条目录条目，「复制绝对路径」即根路径）。 */
  const onProjPointerDown = (p: ProjectRow) => (e: React.PointerEvent): void => {
    suppressRowClick.current = false;
    if (finePointer || e.button !== 0) return;
    const { clientX: x, clientY: y } = e;
    const timer = window.setTimeout(() => {
      rowPress.current = null;
      suppressRowClick.current = true;
      openRowMenu({ kind: 'dir', name: p.name, path: p.path }, x, y);
    }, LONG_PRESS_MS);
    rowPress.current = { x, y, timer };
  };
  const onProjPointerMove = onRowPointerMove;

  // 菜单开着时点外面 / 滚动 / Esc / 再右键即关（ProjectList 同款：菜单内的事件
  // 留给条目自己的 onClick，这里先关会在派发中途卸载条目、React 丢掉那一击）。
  useEffect(() => {
    if (!rowMenu) return;
    const close = (e: Event): void => {
      if (rowMenuRef.current?.contains(e.target as Node)) return;
      setRowMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('contextmenu', close, true);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('contextmenu', close, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', close);
    };
  }, [rowMenu]);

  /** 全文命中（一次扫描同时供计数与前后跳；预览上限 1MB，够快）。
   *  默认大小写不敏感，bar 上的 Aa 按钮切敏感。 */
  const matchesOf = (view: EditorView, q: string): { from: number; to: number }[] => {
    const out: { from: number; to: number }[] = [];
    for (
      // 敏感 = 恒等 normalize（不折大小写）；缺省 normalize 自带 toLowerCase（不敏感）
      const cur = new SearchCursor(view.state.doc, q, 0, undefined, matchCase ? (s) => s : undefined);
      !cur.next().done;
    ) {
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
   *  高亮走自绘层（CodePreview 的 findHighlighter），区间由这里推给它。 */
  const runFind = (q: string): void => {
    const view = viewRef.current;
    if (!view) return;
    if (!q) {
      view.dispatch({ effects: setFindRanges.of(null) });
      setHits(null);
      return;
    }
    const all = matchesOf(view, q);
    view.dispatch({ effects: setFindRanges.of(all) });
    setHits(all.length);
    if (all.length === 0) return;
    const from = view.state.selection.main.from;
    selectAt(view, all.find((m) => m.from >= from) ?? all[0]!);
  };

  const stepMatch = (step: 1 | -1): void => {
    const view = viewRef.current;
    if (!view || !find) return;
    const all = matchesOf(view, find);
    if (all.length === 0) return;
    const main = view.state.selection.main;
    const at = all.findIndex((m) => m.from === main.from && m.to === main.to);
    selectAt(view, all[at < 0 ? 0 : (at + step + all.length) % all.length]!);
  };

  /** 跳到行：选中整行并居中。 */
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

  /** 进一条：目录就下钻，文件就选中（预览跟着选中走）；
   *  窄屏点文件 = 到底，中栏切进文件预览。 */
  const enter = (entry: ProjectFileEntry): void => {
    if (entry.kind === 'dir') {
      setQuery('');
      // 返回时聚焦到进来的那个目录：重置「用户选过行」（否则返回后列表回来自动
      // 不覆盖选中），focusPath 指着它让 load 定位
      userTouched.current = false;
      focusPath.current = entry.path;
      setDir(entry.path);
      setViewing(null);
      return;
    }
    // 文件 = 到底态：中栏整个切进预览、右栏摆元信息（窄屏与桌面同构）
    if (entry.kind === 'file') setViewing(entry);
  };

  /** 全项目模式点一条项目：就地切进该项目（从根开始浏览）。
   *  `targetPath` = 搜索命中落点：直接定位到该文件/目录。 */
  const pickProject = (p: ProjectRow, targetPath?: string): void => {
    setPicked(p);
    userTouched.current = false;
    visited.current.clear();
    setQuery('');
    setViewing(null);
    if (targetPath) {
      const slash = targetPath.lastIndexOf('/');
      setDir(slash >= 0 ? targetPath.slice(0, slash) : '');
      focusPath.current = targetPath;
    } else {
      setDir('');
    }
    setSelected(0);
    setEntries([]);
    firstLoad.current = true;
  };

  /** 项目行清单（虚拟根目录层）：键盘导航与渲染共用。 */
  const projectRows: ProjectRow[] = projects ?? [];

  /** 首屏聚焦项目 ↔ 数据面同步：focused 变化即把中栏切到该项目根目录列表
   *  （聚焦渲染，不进入——三栏态的进入是 pickProject）。dir 归零：上一个
   *  项目浏览到多深都不带走。 */
  useEffect(() => {
    if (picked || !focused) return;
    userTouched.current = false;
    focusPath.current = null;
    setQuery('');
    setViewing(null);
    setDir('');
    firstLoad.current = true;
    lastLoadKeyRef.current = null;
  }, [focused, picked]);

  /** 方向键/回车的导航。挂 document 捕获阶段：点空白处焦点会落到 `body`，
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
    // 全项目第一屏：搜索态 ↑↓/Enter 走跨项目文件命中；否则走项目列表
    if (projectListShown) {
      const hits = fileHitsRef.current;
      if (hits) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          kbdNav.current = true;
          const step = e.key === 'ArrowDown' ? 1 : -1;
          setProjSelected((i) => Math.min(hits.length - 1, Math.max(0, i + step)));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const hit = hits[projSelected];
          const proj = hit && projects?.find((p) => p.id === hit.projectId);
          if (proj) pickProject(proj, hit.path);
          return;
        }
      } else {
        const list = projectRows;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          kbdNav.current = true;
          const step = e.key === 'ArrowDown' ? 1 : -1;
          const at = Math.min(list.length - 1, Math.max(0, projSelected + step));
          setProjSelected(at);
          // 聚焦即在中栏渲染它的根目录列表（不进入——进入是 Enter/点击）
          const proj: ProjectRow | undefined = list[at];
          if (proj && focused !== proj) setFocused(proj);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const hit = list[projSelected];
          if (hit) pickProject(hit);
          return;
        }
        if (e.key === 'ArrowRight') {
          // → = 进入聚焦（选中）的项目：与点击同一条路，切进三栏文件树态
          e.preventDefault();
          const hit = projectRows[projSelected];
          if (hit) pickProject(hit);
          return;
        }
        if (e.key === 'ArrowLeft') {
          // 首屏没有更上一层：只吞键，不给任何反应
          e.preventDefault();
          return;
        }
      }
    } else {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // 「到底」态中栏是文件预览：↑↓ 归预览（滚动/移动光标），不切文件
        if (viewingRef.current) return;
        e.preventDefault();
        e.preventDefault();
        // 键盘接管：此后鼠标只是停着不动（悬停）就不许把选中抢回去
        kbdNav.current = true;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        userTouched.current = true;
        setSelected((i) => Math.min(entries.length - 1, Math.max(0, i + step)));
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        // 「到底」态：← 先退回目录列表（与头部返回键同链），再 ← 才是 goUp
        if (viewingRef.current) {
          setViewing(null);
          return;
        }
        goUp();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const hit = entries[selected];
        if (hit) enter(hit);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const hit = entries[selected];
        // 目录 = 下钻；文件 = 到底态（与 Enter/双击同一条路：预览进中栏、右栏元信息）
        if (hit) enter(hit);
        return;
      }
    }
    // 打进搜索框的字：默认焦点不在输入框（不然空格就成了打字），故可打印字符
    // 一律转过去——打开浏览器直接敲就是了，跟从搜索框里打一样。
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

  // 首屏默认聚焦第一个项目（projects 一到就补账）：中栏从第一拍起就有内容可看
  useEffect(() => {
    if (!picked && !focused && projectRows.length > 0) setFocused(projectRows[0]!);
  }, [picked, focused, projectRows]);

  const crumb = dir ? dir.split('/') : [];
  /** 搜索是当前目录子树的（带 q 时 `dir` 照传）：行与预览头都按这个口径换展示。 */
  const searching = query.trim() !== '';
  /** 头部完整路径：进项目 = 项目根 + 当前目录；首屏 = 键盘/hover 高亮那个项目的
   *  绝对路径（列表高亮即头部所指，搜索范围说明跟着它走）。 */
  const headerPath = picked
    ? root
      ? joinAbsPath(root, dir, false)
      : activeProjectName
    : (focused?.path ?? activeProjectName);

  /** 全项目模式第一屏（左栏 = 项目列表 = 虚拟根目录层）。搜索框走全局检索
   *  的文件路（`/search`，跨项目窥视就绪索引，冷项目跳过）——命中行带项目名，
   *  点击/Enter 直接落进该项目并定位到文件；命中前照旧列项目。 */
  const projectListShown = picked === null && !!projects;

  const [fileHits, setFileHits] = useState<SearchFileHit[] | null>(null);
  const [hitsTruncated, setHitsTruncated] = useState(false);
  /** 键盘 handler（挂一次转闭包）读的命中快照。 */
  const fileHitsRef = useRef<SearchFileHit[] | null>(null);
  fileHitsRef.current = fileHits;
  /** 上一拍搜索词有无：只在「有词 → 无词」（用户清词退出搜索）时才重置首屏
   *  聚焦——effect 随 projectListShown 每次进出项目都重跑，无脑 setProjSelected(0)
   *  会把返回首屏的聚焦打回第一行。 */
  const hadQueryRef = useRef(false);
  useEffect(() => {
    if (!projectListShown) {
      setFileHits(null);
      return;
    }
    const q = query.trim();
    if (!q) {
      setFileHits(null);
      if (hadQueryRef.current) {
        hadQueryRef.current = false;
        setProjSelected(0);
      }
      return;
    }
    hadQueryRef.current = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api
        .searchAll(q, ctrl.signal)
        .then((r) => {
          setFileHits(r.files);
          setHitsTruncated(r.truncated.files);
        })
        .catch(() => {});
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, projectListShown]);

  /** 项目列表（虚拟根目录层）：桌面左栏与窄屏左屏共用，恒可用——进项目后
   *  它退居左栏（只换高亮），不是消失。 */
  const projectList = projectRows.length > 0 ? (
    <ul
      ref={projScrollRef}
      role="listbox"
      aria-label={t('app.openFileBrowser')}
      onMouseMove={() => {
        kbdNav.current = false;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
    >
      {fileHits ? (
        // 搜索态：跨项目文件命中平铺（CommandPalette 同源数据），每行带所属项目
        <>
          {fileHits.length === 0 && (
            <li className="px-3 py-6 text-11 text-neutral-500">{t('search.empty')}</li>
          )}
          {fileHits.map((hit, i) => {
            const proj = projectRows.find((p) => p.id === hit.projectId);
            return (
              <li key={`${hit.projectId}:${hit.path}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === projSelected}
                  onMouseEnter={() => {
                    // 粗指针（触屏）的 tap 会顺带 fire mouseover：返回首屏那一下
                    // 指针停在哪儿就把聚焦抢到哪行（实测总落在第一行）。hover
                    // 选中只给精指针。
                    if (!finePointer || kbdNav.current) return;
                    setProjSelected(i);
                  }}
                  onClick={() => {
                    if (!proj) return;
                    userTouched.current = true;
                    setProjSelected(i);
                    pickProject(proj, hit.path);
                  }}
                  className={cn(
                    'flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left transition-colors select-none',
                    i === projSelected ? 'bg-blue-500/15' : 'hover:bg-edge/[0.04]',
                  )}
                >
                  <span className="flex w-full min-w-0 items-center gap-2">
                    {hit.kind === 'dir' ? (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-blue-300/80" />
                    ) : (
                      iconFor({ kind: 'file', name: hit.path.split('/').pop() ?? hit.path, path: hit.path })
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-200">
                      {hit.path.split('/').pop()}
                    </span>
                    <span className="shrink-0 rounded bg-neutral-800 px-1.5 text-10 text-neutral-400">
                      {proj?.name ?? hit.projectId}
                    </span>
                  </span>
                  <span className="truncate pl-5.5 font-mono text-10 text-neutral-600" title={hit.path}>
                    {hit.path}
                  </span>
                </button>
              </li>
            );
          })}
          {hitsTruncated && (
            <li className="px-3 py-1.5 text-10 text-neutral-600">{t('search.more')}</li>
          )}
        </>
      ) : (
        <>
          {projectRows.length === 0 ? (
            <li className="px-3 py-6 text-11 text-neutral-500">{t('app.noProjects')}</li>
          ) : (
            projectRows
              .map((p, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === projSelected}
                  onMouseEnter={() => {
                    // 悬停 = 只聚焦（中栏渲染该项目根列表、右栏预览跟随），不进入；
                    // 进入（切三栏文件树态）只有点击。窄屏不悬停——tap 扫过行会抢屏。
                    if (!isDesktop || kbdNav.current) return;
                    setProjSelected(i);
                    setFocused(p);
                  }}
                  onClick={() => {
                    // 长按刚开的菜单：这一击是抬手补的，不当点选
                    if (suppressRowClick.current) {
                      suppressRowClick.current = false;
                      return;
                    }
                    userTouched.current = true;
                    setProjSelected(i);
                    setFocused(p);
                    pickProject(p);
                  }}
                  onPointerDown={onProjPointerDown(p)}
                  onPointerMove={onProjPointerMove}
                  onPointerUp={clearRowPress}
                  onPointerCancel={clearRowPress}
                  onContextMenu={(e) => {
                    // 触屏长按也会弹原生菜单：一律压掉，但那条路走长按
                    e.preventDefault();
                    e.stopPropagation();
                    if (!finePointer) return;
                    openRowMenu({ kind: 'dir', name: p.name, path: p.path }, e.clientX, e.clientY);
                  }}
                  className={cn(
                    'flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left transition-colors select-none',
                    i === projSelected ? 'bg-blue-500/15' : 'hover:bg-edge/[0.04]',
                  )}
                >
                  <span className="flex w-full min-w-0 items-center gap-2">
                    <Folder className={cn('h-3.5 w-3.5 shrink-0 text-blue-300/80')} />
                    <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">{p.name}</span>
                  </span>
                  <span className="truncate pl-5.5 font-mono text-10 text-neutral-600" title={p.path}>
                    {p.path}
                  </span>
                </button>
              </li>
            ))
          )}
        </>
      )}
    </ul>
  ) : null;

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
        <li className="flex items-center gap-2 px-3 py-6 text-11 text-neutral-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('tasks.fileLoading')}
        </li>
      )}
      {!loading && entries.length === 0 && (
        <li className="px-3 py-6 text-11 text-neutral-500">
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
        return (
          <li key={entry.path}>
            <button
              type="button"
              role="option"
              aria-selected={i === selected}
              onMouseEnter={() => {
                // 键盘刚走过的行不许被「指针刚好停在那儿」抢回去
                if (isDesktop && !kbdNav.current) {
                  userTouched.current = true;
                  setSelected(i);
                }
              }}
              onClick={() => {
                // 长按刚开的菜单：这一击是抬手补的，不当点选
                if (suppressRowClick.current) {
                  suppressRowClick.current = false;
                  return;
                }
                userTouched.current = true;
                setSelected(i);
                // 单击 = 选中聚焦；文件行单击即到底态（中栏切预览、右栏元信息，
                // 窄屏与桌面同构）；目录行单击只聚焦（预览栏渲染子目录），双击/→ 才进入
                if (entry.kind === 'file' || !isDesktop) enter(entry);
              }}
              onPointerDown={onRowPointerDown(entry)}
              onPointerMove={onRowPointerMove}
              onPointerUp={clearRowPress}
              onPointerCancel={clearRowPress}
              onContextMenu={(e) => {
                // 触屏长按也会弹原生菜单：一律压掉，但那条路走长按
                e.preventDefault();
                e.stopPropagation();
                if (!finePointer) return;
                openRowMenu(entry, e.clientX, e.clientY);
              }}
              onDoubleClick={() => isDesktop && enter(entry)}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs transition-colors select-none',
                i === selected ? 'bg-blue-500/15 text-neutral-100' : 'text-neutral-300 hover:bg-edge/[0.04]',
              )}
            >
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
              {/* 搜索范围是当前目录的子树：size 那个槽位空着，正好摆相对当前
                  目录的所在路径——同名文件只有它能区分（浏览模式的目录上下文
                  就是面包屑，不需要）。 */}
              {searching ? (
                (() => {
                  const full = entry.path.slice(0, entry.path.length - entry.name.length);
                  const rel = dir && full.startsWith(`${dir}/`) ? full.slice(dir.length + 1) : full;
                  const badge = dirBadge(rel);
                  return (
                    <>
                      {entry.head && <HeadBadge head={entry.head} />}
                      {badge && <span className="shrink-0 font-mono text-10 text-neutral-600">{badge}</span>}
                    </>
                  );
                })()
              ) : (
                <>
                  {entry.head && <HeadBadge head={entry.head} />}
                  {entry.size != null && (
                    <span className="shrink-0 text-10 tabular-nums text-neutral-600">
                      {sizeText(entry.size)}
                    </span>
                  )}
                </>
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
        {/* 文件路径行：超长不截断，给横向滚动（细滚条）——用户要完整看着路径走。
            首屏右栏摆的是聚焦项目根子目录，这里跟着显示项目根（不跟随中栏选中下探）。 */}
        <span
          className="scrollbar-thin min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-11 text-neutral-300"
          title={!picked && focused ? focused.path : current ? joinAbsPath(root, current.path) : root || undefined}
        >
          {!picked && focused ? focused.path : current ? joinAbsPath(root, current.path, false) : ''}
        </span>
        {current?.kind === 'file' && previewKindOf(current.name) === 'text' && preview?.text != null && (
          <>
            {/* markdown 专有：渲染 ⇄ 原始切换（渲染态 CodeMirror 不在，查找无落点） */}
            {MARKDOWN_EXT.test(current.name) && (
              <Tooltip label={rawView ? t('tasks.fileRenderedView') : t('tasks.fileRawView')}>
                <button
                  type="button"
                  aria-label={rawView ? t('tasks.fileRenderedView') : t('tasks.fileRawView')}
                  onClick={() => {
                    setRawView((v) => !v);
                    setBar(null);
                  }}
                  className={cn(
                    'rounded p-0.5 hover:text-neutral-100',
                    rawView ? 'text-blue-300' : 'text-neutral-400',
                  )}
                >
                  {rawView ? <Eye className="h-3.5 w-3.5" /> : <FileCode className="h-3.5 w-3.5" />}
                </button>
              </Tooltip>
            )}
            {/* 查找/跳行只在原始视图可用：渲染态点了等于无处高亮，不如不摆 */}
            {(!MARKDOWN_EXT.test(current.name) || rawView) && (
              <>
                <Tooltip label={t('tasks.fileWrapToggle')}>
                  <button
                    type="button"
                    aria-label={t('tasks.fileWrapToggle')}
                    onClick={() => setWrapText((v) => !v)}
                    className={cn(
                      'rounded p-0.5 hover:text-neutral-100',
                      wrapText ? 'text-blue-300' : 'text-neutral-400',
                    )}
                  >
                    {wrapText ? <WrapText className="h-3.5 w-3.5" /> : <AlignLeft className="h-3.5 w-3.5" />}
                  </button>
                </Tooltip>
                <Tooltip label={t('tasks.fileFind')}>
                  <button
                    type="button"
                    aria-label={t('tasks.fileFind')}
                    onClick={() => setBar(bar === 'find' ? null : 'find')}
                    className={cn(
                      'rounded p-0.5 hover:text-neutral-100',
                      bar === 'find' ? 'text-blue-300' : 'text-neutral-400',
                    )}
                  >
                    <TextSearch className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip label={t('tasks.fileGoToLineShortcut')}>
                  <button
                    type="button"
                    aria-label={t('tasks.fileGoToLineShortcut')}
                    onClick={() => setBar(bar === 'line' ? null : 'line')}
                    className={cn(
                      'rounded p-0.5 hover:text-neutral-100',
                      bar === 'line' ? 'text-blue-300' : 'text-neutral-400',
                    )}
                  >
                    <Hash className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </>
            )}
          </>
        )}
      </div>
      {/* 查找 / 跳到行：自己这一条，不留 CodeMirror 那个带替换的面板。
          预览是只读的，ESC 先收它。 */}
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
            className="min-w-0 flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-0.5 text-11 text-neutral-100 focus:border-blue-500/40 focus:outline-none"
          />
          {bar === 'find' ? (
            <>
              {/* 大小写匹配开关：默认不敏感（Aa 亮 = 敏感）；切换即重跑当前词 */}
              <Tooltip label={t('tasks.fileMatchCase')}>
                <button
                  type="button"
                  aria-label={t('tasks.fileMatchCase')}
                  onClick={() => {
                    const next = !matchCase;
                    setMatchCase(next);
                    if (find) runFind(find);
                  }}
                  className={cn(
                    'shrink-0 rounded px-1 py-0.5 text-10 font-semibold',
                    matchCase ? 'bg-blue-500/20 text-blue-200' : 'text-neutral-500 hover:text-neutral-200',
                  )}
                >
                  Aa
                </button>
              </Tooltip>
              <span className="shrink-0 text-10 tabular-nums text-neutral-500">
                {hits == null ? '' : hits === 0 ? t('tasks.fileNoMatch') : t('tasks.fileMatchCount', { n: hits })}
              </span>
              <Tooltip label={t('tasks.filePrevMatch')}>
                <button
                  type="button"
                  aria-label={t('tasks.filePrevMatch')}
                  onClick={() => stepMatch(-1)}
                  className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-100"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              <Tooltip label={t('tasks.fileNextMatch')}>
                <button
                  type="button"
                  aria-label={t('tasks.fileNextMatch')}
                  onClick={() => stepMatch(1)}
                  className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-100"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </>
          ) : (
            <button
              type="button"
              onClick={jumpTo}
              className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-11 text-blue-200 hover:bg-blue-500/30"
            >
              {t('tasks.fileGo')}
            </button>
          )}
          <Tooltip label={t('tasks.fileClearSearch')}>
            <button
              type="button"
              aria-label={t('tasks.fileClearSearch')}
              onClick={() => setBar(null)}
              className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      )}
      {!picked && focused ? (
        // 首屏两栏右栏：恒摆聚焦项目的根子目录清单（不下探选中项——核心可操作
        // 区域只有中栏即项目列表，右栏是「这个项目里有什么」的一览）。位置在
        // 目录/文件分支之前：首屏 entries[selected] 也有值，不许被下探渲染抢走。
        <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
          {loading && entries.length === 0 ? (
            <li className="flex items-center gap-2 px-2.5 py-3 text-11 text-neutral-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('tasks.fileLoading')}
            </li>
          ) : entries.length === 0 ? (
            <li className="px-2.5 py-3 text-11 text-neutral-600">{t('common.empty')}</li>
          ) : (
            entries.map((child) => (
              <li
                key={child.path}
                className="flex items-center gap-2 px-2.5 py-0.5 text-11 text-neutral-400"
              >
                {iconFor(child)}
                <span className="min-w-0 flex-1 truncate font-mono">
                  {child.kind === 'dir' ? `${child.name}/` : child.name}
                </span>
                {child.head && <HeadBadge head={child.head} />}
              </li>
            ))
          )}
        </ul>
      ) : current?.kind === 'dir' ? (
        // 第三栏选中目录时列它的直接子项：**只读**，进入仍归第二栏（双击 / →），
        // 两栏都能下钻会打架。列不下就明说还有多少（不假装列全了）。
        <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
          {sub?.dir === current.path ? (
            sub.entries.length === 0 ? (
              <li className="px-2.5 py-3 text-11 text-neutral-600">{t('tasks.fileEmpty')}</li>
            ) : (
              sub.entries.map((child) => (
                <li
                  key={child.path}
                  className="flex items-center gap-2 px-2.5 py-0.5 text-11 text-neutral-400"
                >
                  {iconFor(child)}
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {child.kind === 'dir' ? `${child.name}/` : child.name}
                  </span>
                  {child.head && <HeadBadge head={child.head} />}
                  {child.size != null && (
                    <span className="shrink-0 text-10 tabular-nums text-neutral-600">
                      {sizeText(child.size)}
                    </span>
                  )}
                </li>
              ))
            )
          ) : (
            <li className="flex items-center gap-2 px-2.5 py-3 text-11 text-neutral-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('tasks.fileLoading')}
            </li>
          )}
        </ul>
      ) : current && previewKindOf(current.name) === 'image' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
          <img
            src={api.projectFileUrl(activeProjectId, current.path)}
            alt={current.name}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ) : current && previewKindOf(current.name) === 'iframe' ? (
        // html/svg/pdf：服务端给真实 content-type + 纯 sandbox 响应头（JS 不执行、
        // opaque origin），iframe 只管渲染——sandbox 由响应头负责，元素上不重复
        // 叠（双层 sandbox 会让 contentDocument 都读不到）。key 换文件强制重载。
        <iframe
          key={current.path}
          src={api.projectFileUrl(activeProjectId, current.path)}
          title={current.name}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : current && previewKindOf(current.name) === 'download' ? (
        // docx 这类浏览器渲不了的：给一枚下载按钮，转交本地应用打开。
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-3">
          <p className="text-11 text-neutral-500">{t('tasks.fileDownloadHint')}</p>
          <a
            href={api.projectFileUrl(activeProjectId, current.path)}
            download={current.name}
            className="flex items-center gap-1.5 rounded border border-edge/[0.14] px-3 py-1.5 text-xs text-neutral-200 hover:bg-edge/[0.06]"
          >
            <Download className="h-3.5 w-3.5" />
            {t('tasks.fileDownload')}
          </a>
        </div>
      ) : current?.kind === 'file' ? (
        current && MARKDOWN_EXT.test(current.name) && !rawView && preview?.path === current.path && preview.text != null ? (
          // markdown 复用全局渲染管线（FileViewer 同款：frontmatter 卡 + prose）。
          // 原始视图（rawView）才走 CodeMirror——查找/跳行只在那里有落点。
          <MarkdownPreview text={preview.text} />
        ) : preview?.path === current.path && preview.text != null ? (
          <CodePreview text={preview.text} lines={null} viewRef={viewRef} onGutterClick={() => {}} wrap={wrapText} />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-3 text-11 text-neutral-500">
            {preview?.path === current.path ? t('tasks.fileNoPreview') : t('tasks.fileLoading')}
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1" />
      )}
      {/* 底条：截断提示（只有文本编辑器预览有截断概念） */}
      {current?.kind === 'file' && previewKindOf(current.name) === 'text' && (
        <div className="flex shrink-0 items-center gap-2 border-t border-edge/[0.06] px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-10 text-neutral-500">
            {preview?.truncated && <span className="text-amber-500/80">{t('tasks.fileTruncatedNote')}</span>}
          </span>
        </div>
      )}
    </div>
  );

  /** 文件元信息清单（大小 / 修改时间）：到底态右栏与三栏「选中文件」右栏共用。 */
  const metaList = (e: ProjectFileEntry): ReactNode => (
    <ul className="min-h-0 flex-1 overflow-y-auto py-1">
      {[
        e.size != null ? sizeText(e.size) : null,
        e.mtime ? new Date(e.mtime).toLocaleString() : null,
      ]
        .filter(Boolean)
        .map((line) => (
          <li key={line} className="px-2.5 py-1 text-10 text-neutral-500">
            {line}
          </li>
        ))}
    </ul>
  );

  /** 窄屏「到底」态的右窄条：文件元信息——正文已满宽在中栏。 */
  const mobileMetaPane = viewing ? metaList(viewing) : <div className="min-h-0 flex-1" />;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 max-lg:p-0"
      onClick={(e) => {
        // 只认遮罩本体：双击项目行时第二击的 click 目标可能是行内 DIV（重渲染
        // 换了节点），冒泡上来不带行按钮的证据——不能拿「没落在按钮上」当关。
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* h-[70%] 不用 70dvh：根 zoom 下视口单位被二次放大（见 index.css #root 注）。
          全屏 = 面板类切 fixed inset-0（SessionMessages 先例）：z-[55] 在右栏之上、
          菜单(60)/弹窗(60-70) 之下——开菜单或看大图不会被它挡住。 */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={cn(
          'relative min-h-0 w-full flex-col overflow-hidden bg-neutral-900 focus:outline-none',
          fullscreen
            ? 'fixed inset-0 z-[55] flex rounded-none border-0 shadow-none'
            : 'flex h-[82%] w-[92%] max-w-[1600px] rounded-xl border border-edge/[0.08] shadow-mac max-lg:h-full max-lg:w-full max-lg:max-w-none max-lg:rounded-none',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头：返回 + 路径 + 搜索 + 全屏 + 关闭。头部元素不随分栏切换——
            没进项目时返回键置灰、路径只摆「浏览文件」标题；进了项目路径
            变成面包屑（点项目名 = 回项目列表第一屏）。 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-edge/[0.06] px-3 py-2">
          <Tooltip label={t('tasks.fileUp')}>
            <button
              type="button"
              aria-label={t('tasks.fileUp')}
              disabled={crumb.length === 0 && !picked}
              hidden={!picked}
              onClick={() => {
                // 窄屏「到底」态：先退回目录列表（多退一级的修复——返回键也要
                // 走 backPop 同一条链：到底 → 列表 → 上一级）
                if (!isDesktop && viewingRef.current) {
                  setViewing(null);
                  return;
                }
                goUp();
              }}
              className="rounded p-1 text-neutral-400 transition-colors hover:text-neutral-100 disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          {/* 面包屑恒显（首屏=高亮项目的绝对路径）：搜索范围就是它指的这棵子树，
              它本身就是范围说明。超宽跑马灯来回滚，右侧复制按钮同右键菜单口径
              （含空格包引号）。 */}
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <MarqueeText
              text={headerPath}
              className="font-mono text-11 text-neutral-400"
            />
            <Tooltip label={t('tasks.fileCopyAbsPath')} side="top">
              <button
                type="button"
                aria-label={t('tasks.fileCopyAbsPath')}
                onClick={() => {
                  void copyText(headerPath).then((ok) => {
                    if (!ok) show('error', t('common.copyFailed'));
                  });
                }}
                className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
              >
                <Copy className="h-3 w-3" />
              </button>
            </Tooltip>
          </div>
          {/* 搜索框：窄屏收成图标（点图标展开聚焦），桌面恒 224px 全宽。
              容器宽度随展开态切换——展开后 176px 收在头部 flex 里（标题 truncate 让位），
              不许溢出把头部撑宽。 */}
          <div
            className={cn(
              'relative shrink-0 lg:w-56',
              !isDesktop && (searchOpen || query) ? 'max-lg:w-44' : 'max-lg:w-7',
            )}
          >
            {!isDesktop && !searchOpen && !query ? (
              <button
                type="button"
                aria-label={t('tasks.fileOpenSearch')}
                onClick={() => {
                  setSearchOpen(true);
                  searchRef.current?.focus();
                }}
                className="flex h-6 w-7 items-center justify-center rounded text-neutral-400 hover:text-neutral-200"
              >
                <Search className="h-3.5 w-3.5" />
              </button>
            ) : (
              <>
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-600" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus={!isDesktop && searchOpen}
                  onBlur={(e) => {
                    // 窄屏：没输入也没焦点就收回图标（有词时保留展开，清词即收）
                    if (!isDesktop && !e.target.value) setSearchOpen(false);
                  }}
                  placeholder={t(picked ? 'tasks.fileSearchInDir' : 'tasks.fileSearchAllProjects')}
                  className="w-full rounded border border-edge/[0.1] bg-neutral-950 py-1 pl-7 pr-6 text-11 text-neutral-100 focus:border-blue-500/40 focus:outline-none"
                />
                {query && (
                  <button
                    type="button"
                    aria-label={t('tasks.fileClearSearch')}
                    onClick={() => {
                      setQuery('');
                      if (!isDesktop) setSearchOpen(false);
                    }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-neutral-600 hover:text-neutral-300"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </>
            )}
          </div>
          {/* 刷新索引：手动定向重建当前目录子树（懒语义——不自动扫，点了才扫） */}
          {!projectList && (
            <Tooltip label={t('tasks.fileRefreshIndex')} side="top">
              <button
                type="button"
                aria-label={t('tasks.fileRefreshIndex')}
                onClick={refreshIndex}
                disabled={refreshing}
                className="inline-flex shrink-0 items-center rounded border border-edge/[0.08] p-1 text-neutral-400 transition-colors hover:border-edge/[0.16] hover:text-neutral-200 disabled:opacity-40"
              >
                <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
              </button>
            </Tooltip>
          )}
          {/* 全屏：样式与 SessionMessages 那枚同款（图标四角括线 + 文字） */}
          <Tooltip
            label={fullscreen ? t('tasks.convExitFullscreen') : t('tasks.convFullscreen')}
            side="top"
          >
            <button
              type="button"
              aria-label={fullscreen ? t('tasks.convExitFullscreen') : t('tasks.convFullscreen')}
              onClick={() => setFullscreen((f) => !f)}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.08] px-1.5 py-0.5 text-10 text-neutral-400 transition-colors hover:border-edge/[0.16] hover:text-neutral-200 max-lg:py-1.5"
            >
              {fullscreen ? <Minimize className="h-3 w-3" /> : <Maximize className="h-3 w-3" />}
              {fullscreen ? t('tasks.convExitFullscreen') : t('tasks.convFullscreen')}
            </button>
          </Tooltip>
          <Tooltip label={t('tasks.messagesClose')} side="top">
            <button
              type="button"
              aria-label={t('tasks.messagesClose')}
              onClick={onClose}
              className="rounded p-1 text-neutral-500 hover:text-neutral-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>

        {/* 体：父目录 | 当前目录 | 预览。桌面进项目后三栏（父目录 | 当前 | 预览），
            首屏两栏（项目列表 = 主展示区 + 右栏聚焦项目元信息）；窄屏一屏一栏，
            左右窄条提示层渐入渐出——两套布局同一套状态机（聚焦渲染、点击进入）。 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {isDesktop && picked ? (
              // 桌面进项目后恒 3 栏。左栏语义与窄屏同一份：项目根（无父列）=
              // 项目列表（可点切换项目），深处 = 父目录列——不摆「浏览文件」占位。
              <FileColumnsBrowser
                parentCol={
                  finderCols.length > 0 ? (
                    <FinderColumnList
                      entries={finderCols[0]!.entries}
                      loading={finderCols[0]!.loading}
                      activePath={dir}
                      onOpen={(p) => {
                        setQuery('');
                        setDir(p);
                      }}
                    />
                  ) : (
                    projectList
                  )
                }
                parentRootLabel={t('app.openFileBrowser')}
                middleCol={viewing ? previewPane : list}
                previewCol={viewing ? mobileMetaPane : previewPane}
                leftW={leftW}
                onLeftResize={(d) => setLeftW(leftW + d)}
                previewW={current ? previewW : undefined}
                onPreviewResize={(d) => setPreviewW(previewW - d)}
                dimSides
              />
            ) : isDesktop ? (
              /* 桌面首屏两栏：项目列表 = 主展示区 + 右栏 = 聚焦项目根子目录
                 （只读预览，聚焦渲染不进入）。分界可拖，默认居中。 */
              <div ref={homeBodyRef} className="flex min-h-0 min-w-0 flex-1">
                <div
                  className="flex min-h-0 min-w-0 flex-col"
                  style={{ width: `${(homeSplit ?? 0.5) * 100}%` }}
                >
                  {projectList}
                </div>
                <Resizer onResize={homeSplitDrag} title={t('app.resizeLeft')} />
                <div className="pointer-events-none flex min-h-0 min-w-0 flex-1 flex-col border-l border-edge/[0.18] opacity-40">
                  {previewPane}
                </div>
              </div>
            ) : (
              /* 窄屏（状态机）：level = picked 有无。可操作栏恒为中栏。
                 root 首屏 = 两栏，主展示区就是项目列表（中栏位）；
                 inside = 三栏：左=上一层级（项目根时=项目列表，深处=父目录列）/
                 中=当前目录（导航只改内容）/ 右=预览（提示层不可点）。 */
              <MobileFadePanels hasLeft={picked !== null}>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {picked && finderCols.length > 0 ? (
                    <FinderColumnList
                      entries={finderCols[0]!.entries}
                      loading={finderCols[0]!.loading}
                      activePath={dir}
                      onOpen={(p) => {
                        setQuery('');
                        setDir(p);
                      }}
                    />
                  ) : (
                    projectList
                  )}
                </div>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {/* 「到底」态：中栏整个切进文件预览（路径/渲染⇄原始/查找/正文满宽） */}
                  {viewing ? (
                    previewPane
                  ) : picked ? (
                    list
                  ) : (
                    projectList
                  )}
                </div>
                {viewing ? mobileMetaPane : previewPane}
              </MobileFadePanels>
            )}
          </div>
          {/* 底条：条数 / 截断提示（全项目第一屏不摆——还没有「条数」可数） */}
          <div className={cn('shrink-0 items-center gap-2 border-t border-edge/[0.06] px-3 py-1.5 text-10 text-neutral-600', picked ? 'flex' : projectList ? 'hidden' : 'flex')}>
          </div>
          {/* 底条：条数 / 截断提示 */}
          <div className="flex shrink-0 items-center gap-2 border-t border-edge/[0.06] px-3 py-1.5 text-10 text-neutral-600">
            <span>
              {query
                ? t(capped ? 'tasks.fileHitsTop' : 'tasks.fileHits', { n: total })
                : t('tasks.fileCount', { n: total })}
            </span>
            {truncated && <span className="text-amber-500/80">{t('tasks.fileTruncated')}</span>}
            {/* 按键说明逐块摆：一整串挤在一格里，深色底上等于一团灰字 */}
            <span className="ml-auto hidden items-center gap-1 lg:flex">
              {t('tasks.fileHintBrowse')
                .split(' · ')
                .map((chunk) => (
                  <kbd
                    key={chunk}
                    className="rounded border border-edge/[0.14] bg-neutral-950 px-1.5 py-0.5 font-sans text-10 font-normal text-neutral-400"
                  >
                    {chunk}
                  </kbd>
                ))}
            </span>
          </div>
        </div>
        {/* 行右键菜单 — portal 到 body：弹窗容器的 overflow 会裁剪 fixed 后代。
            两项：复制绝对路径（文件/目录）+ 下载（仅文件）。 */}
        {rowMenu && (
          // 菜单里放 <a download>：click 时浏览器原生转交下载管理器/本地应用，
          // 不用 fetch 拼字节（认证 cookie 同域自动带上）。
          createPortal(
            <div
              ref={rowMenuRef}
              style={{
                left: Math.min(rowMenu.x, window.innerWidth - 220),
                top: Math.min(rowMenu.y, window.innerHeight - 96),
              }}
              className="fixed z-[65] w-52 rounded-lg border border-edge/[0.08] bg-neutral-900 shadow-mac py-1"
              onContextMenu={(e) => e.preventDefault()}
            >
              <p className="truncate px-3 pb-1 pt-0.5 text-10 text-neutral-500" title={rowMenu.entry.path}>
                {rowMenu.entry.name}
              </p>
              <button
                type="button"
                onClick={() => {
                  void copyText(joinAbsPath(root, rowMenu.entry.path)).then((ok) => {
                    if (!ok) show('error', t('common.copyFailed'));
                  });
                  setRowMenu(null);
                }}
                className="flex w-full items-center px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-edge/[0.06] hover:text-neutral-100"
              >
                {t('tasks.fileCopyAbsPath')}
              </button>
              {rowMenu.entry.kind === 'file' && (
                <a
                  href={api.projectFileUrl(activeProjectId, rowMenu.entry.path)}
                  download={rowMenu.entry.name}
                  onClick={() => setRowMenu(null)}
                  className="flex w-full items-center px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-edge/[0.06] hover:text-neutral-100"
                >
                  {t('tasks.fileDownload')}
                </a>
              )}
            </div>,
            document.body,
          )
        )}
      </div>
    </div>,
    document.body,
  );
}
