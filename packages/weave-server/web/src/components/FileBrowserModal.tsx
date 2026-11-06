import { useCallback, useEffect, useRef, useState } from 'react';
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
  Download,
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
  X,
} from 'lucide-react';
import { api, type ProjectFileEntry, type ProjectRow, type SearchFileHit } from '@/lib/api';
import { Tooltip } from '@/components/ui/tooltip';
import { Resizer } from '@/components/Resizer';
import { useToast } from '@/components/Toast';
import { copyText } from '@/lib/clipboard';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useBackPop } from '@/lib/back-pop';
import { useMediaQuery } from '@/lib/use-media-query';
import { splitFrontmatter } from '@/lib/markdown';
import { FrontmatterCard } from '@/components/FrontmatterCard';
import { markdownPre } from '@/components/ui/mermaid-block';
import {
  CodePreview,
  HeadBadge,
  dirBadge,
  iconFor,
  segmentsOf,
  setFindRanges,
  sizeText,
} from './tasks/FilePicker';
import { useFinderColumns } from './tasks/FilePicker';
import {
  FileColumnsBrowser,
  FinderColumnList,
  MobileFadePanels,
  useColumnWidths,
  useMobilePaneSwitch,
} from '@/components/FileColumnsBrowser';

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
 *  root 的分隔符——空格等特殊字符原样保留（剪贴板走纯文本，消费方按路径解析）。 */
const joinAbsPath = (root: string, rel: string): string => {
  if (!root) return rel;
  const sep = root.includes('\\') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return `${base}${sep}${rel.replaceAll('/', sep)}`;
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
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4">
      {parsed.frontmatter && <FrontmatterCard data={parsed.frontmatter} />}
      <div className="prose prose-invert prose-sm max-w-none">
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
  /** 窄屏一屏只放得下一栏：列表与预览是两屏，靠它切。 */
  const [screen, setScreen] = useState<'list' | 'preview'>('list');
  // 窄屏渐入渐出面板的标签点击（MobileFadePanels 经 window 事件上报，组件共用）
  useMobilePaneSwitch(setScreen);
  /** 预览里那条小工具条：查找 / 跳到行（同一格，不会同时开）。 */
  const [bar, setBar] = useState<'find' | 'line' | null>(null);
  const [find, setFind] = useState('');
  const [jump, setJump] = useState('');
  const [hits, setHits] = useState<number | null>(null);
  /** 全屏（SessionMessages 先例）：面板类切换，ESC 链里优先于关闭。 */
  const [fullscreen, setFullscreen] = useState(false);
  /** 三栏拖宽（只桌面）：sessionStorage 会话级记忆，重开弹窗还在。 */
  const { leftW, setLeftW, previewW, setPreviewW } = useColumnWidths(SPLIT_KEY);

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
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  /** 全项目模式：null = 还没进任何项目（中栏第一屏列项目）；非 null = 已进入。
   *  面包屑退回根（goTo('')）时回到项目列表。 */
  const [picked, setPicked] = useState<ProjectRow | null>(null);
  /** 全项目模式真正生效的 projectId/projectName：跟随 picked 漂移。 */
  const activeProjectId = picked?.id ?? projectId;
  const activeProjectName = picked?.name ?? projectName;
  /** 路过每一层的账（层级递进本身）：父级列的数据源，键 = `projectId:path`。
   *  切项目清账——上一个项目的层对下一个项目没有意义。 */
  const visited = useRef(new Map<string, { entries: ProjectFileEntry[]; total: number }>());

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
          // 用户已经用鼠标/键盘选过行就不覆盖（否则列表回来自动跳回第一行，
          // 正盯着的选项被顶掉）；重置只发生在初始定位与换目录
          if (userTouched.current) {
            setSelected((i) => Math.min(i, listing.entries.length - 1));
          } else {
            setSelected(at >= 0 ? at : 0);
            if (at >= 0 && listing.entries[at]!.kind === 'file') setScreen('preview');
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

  /** Finder 父级列（桌面分栏）：进项目后才取数。 */
  const finderCols = useFinderColumns(activeProjectId, dir, isDesktop && !!picked, visited);

  // 输入防抖：只有搜索框会连打，方向键与点击一律不打请求。搜索范围 = 当前目录
  // 的子树（dir 照传，服务端按它收窄）——换目录时搜索结果跟着换范围。
  useEffect(() => {
    if (!picked && projects) return; // 全项目模式第一屏：还没进项目，不打文件请求
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
    if (!isDesktop && screen === 'preview') {
      setScreen('list');
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
    // 全项目模式退回根 = 回到项目列表第一屏（picked 置空后 activeProjectId
    // 回落 props 的占位，列表请求停发——中栏改列项目）
    if (projects && target === '') setPicked(null);
    userTouched.current = false;
    setQuery('');
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

  /** 进一条：目录就下钻，文件就选中（预览跟着选中走）。 */
  const enter = (entry: ProjectFileEntry): void => {
    if (entry.kind === 'dir') {
      setQuery('');
      setDir(entry.path);
      setScreen('list');
      return;
    }
    if (!isDesktop) setScreen('preview');
  };

  /** 全项目模式点一条项目：就地切进该项目（从根开始浏览）。
   *  `targetPath` = 搜索命中落点：直接定位到该文件/目录。 */
  const pickProject = (p: ProjectRow, targetPath?: string): void => {
    setPicked(p);
    userTouched.current = false;
    visited.current.clear();
    setQuery('');
    if (targetPath) {
      const slash = targetPath.lastIndexOf('/');
      setDir(slash >= 0 ? targetPath.slice(0, slash) : '');
      focusPath.current = targetPath;
    } else {
      setDir('');
    }
    setSelected(0);
    setEntries([]);
    setScreen('list');
    firstLoad.current = true;
  };

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
        const list = projects ?? [];
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          kbdNav.current = true;
          const step = e.key === 'ArrowDown' ? 1 : -1;
          setProjSelected((i) => Math.min(list.length - 1, Math.max(0, i + step)));
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const hit = list[projSelected];
          if (hit) pickProject(hit);
          return;
        }
      }
    } else {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
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
        if (hit?.kind === 'dir') enter(hit);
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

  const crumb = dir ? dir.split('/') : [];
  /** 搜索是当前目录子树的（带 q 时 `dir` 照传）：行与预览头都按这个口径换展示。 */
  const searching = query.trim() !== '';

  /** 全项目模式第一屏（中栏 = 项目列表）。搜索框走全局检索的文件路
   *  （`/search`，跨项目窥视就绪索引，冷项目跳过）——命中行带项目名，
   *  点击/Enter 直接落进该项目并定位到文件；命中前照旧列项目。 */
  const projectListShown = picked === null && !!projects;

  /** 首屏（项目列表）聚焦项目的子目录只读预览：悬停/键盘聚焦哪条项目就列
   *  哪个项目根下的直接子项；未聚焦（无选中）不加载。防抖避免扫过一串项目
   *  时连打请求；进项目后这份账整个让位给真正的第三栏。 */
  const focusedProject = projectListShown ? (projects ?? [])[projSelected] : undefined;
  const [focusedSub, setFocusedSub] = useState<{ project: ProjectRow; entries: ProjectFileEntry[]; total: number } | null>(null);
  useEffect(() => {
    if (!projectListShown || !focusedProject || query.trim()) {
      setFocusedSub(null);
      return;
    }
    setFocusedSub(null);
    const cached = dirCache.current.get(focusedProject.path);
    if (cached) {
      setFocusedSub({ project: focusedProject, ...cached });
      return;
    }
    const timer = setTimeout(() => {
      void api
        .listProjectFiles(focusedProject.id, { dir: '', limit: 100 })
        .then((listing) => {
          const value = cacheSet(
            dirCache.current,
            focusedProject.path,
            { entries: listing.entries, total: listing.total },
            DIR_CACHE_MAX,
          );
          setFocusedSub({ project: focusedProject, ...value });
        })
        .catch(() => {});
    }, SELECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectListShown, focusedProject, query]);
  const focusedSubPane = focusedSub ? (
    <FinderColumnList
      entries={focusedSub.entries}
      loading={false}
      activePath={null}
    />
  ) : (
    <div className="flex flex-1 items-center justify-center text-11 text-neutral-600">
      {t('tasks.filePreviewEmpty' as never)}
    </div>
  );

  const [fileHits, setFileHits] = useState<SearchFileHit[] | null>(null);
  const [hitsTruncated, setHitsTruncated] = useState(false);
  /** 键盘 handler（挂一次转闭包）读的命中快照。 */
  const fileHitsRef = useRef<SearchFileHit[] | null>(null);
  fileHitsRef.current = fileHits;
  useEffect(() => {
    if (!projectListShown) {
      setFileHits(null);
      return;
    }
    const q = query.trim();
    if (!q) {
      setFileHits(null);
      setProjSelected(0);
      return;
    }
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

  const projectList = projectListShown ? (
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
            const proj = projects.find((p) => p.id === hit.projectId);
            return (
              <li key={`${hit.projectId}:${hit.path}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === projSelected}
                  onMouseEnter={() => {
                    if (!kbdNav.current) setProjSelected(i);
                  }}
                  onClick={() => {
                    if (!proj) return;
                    userTouched.current = true;
                    pickProject(proj, hit.path);
                  }}
                  className={cn(
                    'flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left transition-colors',
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
          {projects.length === 0 ? (
            <li className="px-3 py-6 text-11 text-neutral-500">{t('app.noProjects')}</li>
          ) : (
            projects
              .map((p, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === projSelected}
                  onMouseEnter={() => {
                    if (!kbdNav.current) setProjSelected(i);
                  }}
                  onClick={() => {
                    // 长按刚开的菜单：这一击是抬手补的，不当点选
                    if (suppressRowClick.current) {
                      suppressRowClick.current = false;
                      return;
                    }
                    userTouched.current = true;
                    setProjSelected(i);
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
                    'flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left transition-colors',
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
                if (!isDesktop) enter(entry);
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
                'flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs transition-colors',
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
        {/* 文件路径行：超长不截断，给横向滚动（细滚条）——用户要完整看着路径走 */}
        <span
          className="scrollbar-thin min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-11 text-neutral-300"
          title={current ? joinAbsPath(root, current.path) : root || undefined}
        >
          {current ? joinAbsPath(root, current.path) : ''}
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
                <Tooltip label={t('tasks.fileGoToLine')}>
                  <button
                    type="button"
                    aria-label={t('tasks.fileGoToLine')}
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
      {current?.kind === 'dir' ? (
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
          <CodePreview text={preview.text} lines={null} viewRef={viewRef} onGutterClick={() => {}} />
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

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 max-lg:p-0"
      onClick={onClose}
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
            : 'flex h-[70%] max-w-4xl rounded-xl border border-edge/[0.08] shadow-mac max-lg:h-full max-lg:max-w-none max-lg:rounded-none',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头：面包屑 + 搜索 + 全屏 + 关闭。全项目第一屏没有面包屑（还没进项目），
            搜索框照摆——打字即可按名过滤项目。 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-edge/[0.06] px-3 py-2">
          {projectList ? (
            <span className="min-w-0 flex-1 truncate text-xs text-neutral-300">{t('app.openFileBrowser')}</span>
          ) : (
            <>
              <Tooltip label={t('tasks.fileUp')}>
                <button
                  type="button"
                  aria-label={t('tasks.fileUp')}
                  disabled={crumb.length === 0 && !picked}
                  onClick={() => {
                    // 窄屏预览态：这枚键先「回列表」（唯一返回键，不与预览头的
                    // 旧返回键叠两层）；列表态才是目录上一级。
                    if (!isDesktop && screen === 'preview') {
                      setScreen('list');
                      return;
                    }
                    goUp();
                  }}
                  className="rounded p-1 text-neutral-400 transition-colors hover:text-neutral-100 disabled:opacity-30"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              <div className="min-w-0 flex-1 truncate font-mono text-11 text-neutral-400">
                {/* 面包屑恒显：搜索范围就是它指的这棵子树，它本身就是范围说明 */}
                <button type="button" onClick={() => goTo('')} className="hover:text-neutral-200">
                  {activeProjectName}
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
              </div>
            </>
          )}
          <div className="relative w-56 shrink-0 max-lg:w-40">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-600" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('tasks.fileSearchPlaceholder')}
              className="w-full rounded border border-edge/[0.1] bg-neutral-950 py-1 pl-7 pr-6 text-11 text-neutral-100 focus:border-blue-500/40 focus:outline-none"
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

        {/* 体：父目录 | 当前目录 | 预览。窄屏一屏一栏（列表 ⇄ 预览）。
            键盘处理只挂在列表这一侧——预览里是编辑器，方向键归它。
            全项目模式第一屏三栏照摆：中栏 = 项目列表，左/预览栏空占位——
            键盘操作（↑↓/Enter）从第一拍起就是主路径。 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {projectList ? (
              // 全项目模式第一屏：桌面 2 栏常显 = 项目列表 | 聚焦项目的子目录
              // （只读预览——鼠标只许看，进项目才可操作）；第二栏只在点了/聚焦
              // 了项目才加载数据，空着摆提示。窄屏一屏一栏。
              isDesktop ? (
                <>
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col">{projectList}</div>
                  <Resizer
                    onResize={(d) => setPreviewW(previewW - d)}
                    title={t('app.resizePreview')}
                  />
                  <div
                    className="flex min-h-0 shrink-0 flex-col border-l border-edge/[0.06] bg-neutral-950/40"
                    style={{ width: previewW }}
                  >
                    {focusedSubPane}
                  </div>
                </>
              ) : (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">{projectList}</div>
              )
            ) : isDesktop ? (
              /* 恒 3 栏：左=父级列（根态空占位）| 中=当前操作列 | 右=下层预览
                  （选中条目才出现，未选中不占宽）。左列数据复用层级递进的账
                  （不为此单独发请求）；列里点目录 = 跳过去，下层区域即右侧预览栏。 */
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
                  ) : null
                }
                parentRootLabel={activeProjectName}
                middleCol={list}
                previewCol={previewPane}
                leftW={leftW}
                onLeftResize={(d) => setLeftW(leftW + d)}
                previewW={current ? previewW : undefined}
                onPreviewResize={(d) => setPreviewW(previewW - d)}
              />
            ) : (
              <MobileFadePanels
                listActive={screen === 'list'}
                listLabel={activeProjectName}
                previewLabel={current?.name ?? activeProjectName}
              >
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">{list}</div>
                {previewPane}
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
