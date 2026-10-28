import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { EditorView } from '@codemirror/view';
import { SearchCursor, SearchQuery, setSearchQuery } from '@codemirror/search';
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Download,
  Folder,
  Hash,
  Loader2,
  Maximize,
  Minimize,
  Search,
  TextSearch,
  X,
} from 'lucide-react';
import { api, type ProjectFileEntry } from '@/lib/api';
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
  sizeText,
} from './tasks/FilePicker';

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
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
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
  onClose,
}: {
  projectId: number;
  /** 项目名：面包屑根与左栏的根那一格写它，不写 `/`。 */
  projectName: string;
  /** 初始定位：文件 → 落在其目录并直接预览；目录 → 落在该目录。 */
  path?: string;
  onClose: () => void;
}) {
  const t = useT();
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  const [query, setQuery] = useState('');
  const [dir, setDir] = useState(() => {
    if (!path) return '';
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  });
  const [entries, setEntries] = useState<ProjectFileEntry[]>([]);
  /** 父目录条目：只有桌面三栏的左栏用得上（窄屏不取）。 */
  const [siblings, setSiblings] = useState<ProjectFileEntry[]>([]);
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
  /** 预览里那条小工具条：查找 / 跳到行（同一格，不会同时开）。 */
  const [bar, setBar] = useState<'find' | 'line' | null>(null);
  const [find, setFind] = useState('');
  const [jump, setJump] = useState('');
  const [hits, setHits] = useState<number | null>(null);
  /** 全屏（SessionMessages 先例）：面板类切换，ESC 链里优先于关闭。 */
  const [fullscreen, setFullscreen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  /** 弹窗自己收焦点：不让按键漏到背后的页面。 */
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 请求序号守卫：慢响应不许覆盖新结果（LAN 下会有明显乱序）。 */
  const seq = useRef(0);
  /** 打开浏览器后的第一拍：带 `fresh=1` 让服务端重建一次索引（刚建的文件才在）。 */
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

  const load = useCallback(
    (q: string, target: string, signal: AbortSignal, fresh = false) => {
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      // 没有斜杠但非空（`src`）= 父目录是项目根 `''`；根自身没有父
      const slash = target.lastIndexOf('/');
      const parent = target === '' ? null : slash >= 0 ? target.slice(0, slash) : '';
      void Promise.all([
        api.listProjectFiles(projectId, { q, dir: target, signal, fresh }),
        // 左栏 = 父目录的条目（根没有父，摆一行项目名占位）
        !q && isDesktop && parent !== null
          ? api.listProjectFiles(projectId, { dir: parent, signal }).catch(() => null)
          : Promise.resolve(null),
      ])
        .then(([listing, parentListing]) => {
          if (mine !== seq.current) return;
          setEntries(listing.entries);
          setTotal(listing.total);
          setCapped(listing.capped ?? false);
          setTruncated(listing.truncated);
          // 搜索不打父目录请求；这时留住上一次那份，左栏不闪成空栏
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
    [projectId, isDesktop],
  );

  // 输入防抖：只有搜索框会连打，方向键与点击一律不打请求。搜索范围 = 当前目录
  // 的子树（dir 照传，服务端按它收窄）——换目录时搜索结果跟着换范围。
  useEffect(() => {
    const timer = setTimeout(() => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      load(query.trim(), dir, ctrl.signal, firstLoad.current);
      firstLoad.current = false;
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, dir, load]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  // 选中项滚进视野：回上一级时那一层可能远在折叠区外
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, entries]);

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
          .listProjectFiles(projectId, { dir: cur.path, limit: 100 })
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
        .projectFileText(projectId, cur.path)
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
  }, [current, projectId]);

  /** 行号选区已退役（用户裁决：那是引用选择器的行为，浏览器不需要）——
   *  CodePreview 的 `lines`/`onGutterClick` 传空壳，行号纯展示。 */

  // 换一条选中：查找条重来
  useEffect(() => {
    setBar(null);
    setFind('');
    setJump('');
    setHits(null);
  }, [current?.path]);

  /** ESC 逐层退：查找条 → 全屏 → 关 modal（焦点可能在预览里，挂 document 捕获阶段）。 */
  const barRef = useRef(bar);
  barRef.current = bar;
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (barRef.current) setBar(null);
      else if (fullscreenRef.current) setFullscreen(false);
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
    setQuery('');
    setDir(target);
  };

  const goUp = (): void => {
    const slash = dir.lastIndexOf('/');
    goTo(dir === '' ? '' : slash >= 0 ? dir.slice(0, slash) : '');
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
      if (hit) enter(hit);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const hit = entries[selected];
      if (hit?.kind === 'dir') enter(hit);
      return;
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
                if (isDesktop && !kbdNav.current) setSelected(i);
              }}
              onClick={() => {
                setSelected(i);
                if (!isDesktop) enter(entry);
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
        <span
          className="min-w-0 flex-1 truncate font-mono text-11 text-neutral-300"
          title={searching ? current?.path : undefined}
        >
          {(searching ? current?.path : current?.name) ?? ''}
        </span>
        {current?.kind === 'file' && previewKindOf(current.name) === 'text' && preview?.text != null && (
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
              className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-11 text-blue-200 hover:bg-blue-500/30"
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
            src={api.projectFileUrl(projectId, current.path)}
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
          src={api.projectFileUrl(projectId, current.path)}
          title={current.name}
          className="min-h-0 flex-1 border-0 bg-white"
        />
      ) : current && previewKindOf(current.name) === 'download' ? (
        // docx 这类浏览器渲不了的：给一枚下载按钮，转交本地应用打开。
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-3">
          <p className="text-11 text-neutral-500">{t('tasks.fileDownloadHint')}</p>
          <a
            href={api.projectFileUrl(projectId, current.path)}
            download={current.name}
            className="flex items-center gap-1.5 rounded border border-edge/[0.14] px-3 py-1.5 text-xs text-neutral-200 hover:bg-edge/[0.06]"
          >
            <Download className="h-3.5 w-3.5" />
            {t('tasks.fileDownload')}
          </a>
        </div>
      ) : current?.kind === 'file' ? (
        current && MARKDOWN_EXT.test(current.name) && preview?.path === current.path && preview.text != null ? (
          // markdown 复用全局渲染管线（FileViewer 同款：frontmatter 卡 + prose）。
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
        {/* 头：面包屑 + 搜索 + 全屏 + 关闭 */}
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
          <div className="min-w-0 flex-1 truncate font-mono text-11 text-neutral-400">
            {/* 面包屑恒显：搜索范围就是它指的这棵子树，它本身就是范围说明 */}
            <button type="button" onClick={() => goTo('')} className="hover:text-neutral-200">
              {projectName}
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
          {/* 全屏：样式与 SessionMessages 那枚同款（图标四角括线 + 文字） */}
          <button
            type="button"
            title={fullscreen ? t('tasks.convExitFullscreen') : t('tasks.convFullscreen')}
            aria-label={fullscreen ? t('tasks.convExitFullscreen') : t('tasks.convFullscreen')}
            onClick={() => setFullscreen((f) => !f)}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.08] px-1.5 py-0.5 text-10 text-neutral-400 transition-colors hover:border-edge/[0.16] hover:text-neutral-200 max-lg:py-1.5"
          >
            {fullscreen ? <Minimize className="h-3 w-3" /> : <Maximize className="h-3 w-3" />}
            {fullscreen ? t('tasks.convExitFullscreen') : t('tasks.convFullscreen')}
          </button>
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
                      <li className="flex items-center gap-2 bg-blue-500/15 px-2.5 py-1 text-11 text-neutral-100">
                        <Folder className="h-3.5 w-3.5 shrink-0 text-blue-300/80" />
                        <span className="truncate">{projectName}</span>
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
                                'flex w-full items-center gap-2 px-2.5 py-1 text-left text-11',
                                sib.path === dir
                                  ? 'bg-blue-500/15 text-neutral-100'
                                  : 'text-neutral-400 hover:bg-edge/[0.04] hover:text-neutral-200',
                              )}
                            >
                              {iconFor(sib)}
                              <span className="min-w-0 flex-1 truncate font-mono">
                                {sib.name}
                                {sib.path === dir ? '/' : ''}
                              </span>
                              {sib.head && <HeadBadge head={sib.head} />}
                            </button>
                          </li>
                        ) : (
                          <li
                            key={sib.path}
                            className="flex items-center gap-2 px-2.5 py-1 text-11 text-neutral-600"
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
      </div>
    </div>,
    document.body,
  );
}
