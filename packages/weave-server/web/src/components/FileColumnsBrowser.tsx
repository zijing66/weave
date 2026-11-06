import { useEffect, useState, type ReactNode } from 'react';
import { Folder, Loader2 } from 'lucide-react';
import type { ProjectFileEntry } from '@/lib/api';
import { Resizer } from '@/components/Resizer';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { HeadBadge, iconFor } from './tasks/FilePicker';

/** 分界线强度：半透 edge 色随主题翻白/翻黑，深浅色下视觉强度一致。 */
const COL_DIVIDER = 'border-edge/[0.18]';

// ---- 恒 3 栏文件浏览骨架（macOS Finder column view 的几何层）----
// 左 = 父级列（根态空占位）| 中 = 当前操作列 | 右 = 预览列。
// 列内容与行交互全部由引用方自定义渲染（FileItem / filePreview 各页面自理），
// 本组件只管分栏几何、拖动分隔条与宽度记忆——框架层一份，多处复用。

/** 分栏宽度范围（px）与 sessionStorage 键前缀（会话级记忆：重开弹窗还在）。 */
export const COLS_LEFT_MIN = 120;
export const COLS_LEFT_MAX = 360;
export const COLS_PREVIEW_MIN = 200;
export const COLS_PREVIEW_MAX = 720;

/** 两条分栏宽度的会话级记忆：键前缀各页面自取（同页共享、跨页隔离）。 */
export function useColumnWidths(key: string): {
  leftW: number;
  setLeftW: (w: number) => void;
  previewW: number;
  setPreviewW: (w: number) => void;
} {
  const [leftW, setLeftWState] = useState<number>(() => {
    const v = Number(sessionStorage.getItem(`${key}:left`));
    return Number.isFinite(v) && v > 0 ? Math.min(COLS_LEFT_MAX, Math.max(COLS_LEFT_MIN, v)) : 160;
  });
  const [previewW, setPreviewWState] = useState<number>(() => {
    const v = Number(sessionStorage.getItem(`${key}:preview`));
    return Number.isFinite(v) && v > 0 ? Math.min(COLS_PREVIEW_MAX, Math.max(COLS_PREVIEW_MIN, v)) : 384;
  });
  useEffect(() => {
    sessionStorage.setItem(`${key}:left`, String(leftW));
    sessionStorage.setItem(`${key}:preview`, String(previewW));
  }, [key, leftW, previewW]);
  return {
    leftW,
    setLeftW: (w) => setLeftWState(Math.min(COLS_LEFT_MAX, Math.max(COLS_LEFT_MIN, w))),
    previewW,
    setPreviewW: (w) => setPreviewWState(Math.min(COLS_PREVIEW_MAX, Math.max(COLS_PREVIEW_MIN, w))),
  };
}

/** 父级列的默认条目清单：目录行点击 = 进入（onOpen），文件行只给上下文
 *  （点文件没有去处）。`onOpen` 缺省 = 整列只读预览（首屏聚焦项目的子目录
 *  视图——只许看，点了没去处）。`activePath` = 当前操作列正在展示的目录（高亮）。
 *  想换行渲染（勾选框、菜单…）就在引用方自己写一列，不经过这里。 */
export function FinderColumnList({
  entries,
  loading,
  activePath,
  onOpen,
}: {
  entries: ProjectFileEntry[];
  loading: boolean;
  activePath: string | null;
  onOpen?: (path: string) => void;
}) {
  const t = useT();
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
      {loading && entries.length === 0 && (
        <li className="flex items-center gap-2 px-2.5 py-3 text-11 text-neutral-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('common.loading')}
        </li>
      )}
      {!loading && entries.length === 0 && (
        <li className="px-2.5 py-3 text-11 text-neutral-600">{t('common.empty')}</li>
      )}
      {entries.map((entry) =>
        entry.kind === 'dir' ? (
          <li key={entry.path}>
            <button
              type="button"
              title={entry.path}
              onClick={() => onOpen?.(entry.path)}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1 text-left text-11',
                entry.path === activePath
                  ? 'bg-blue-500/15 text-neutral-100'
                  : 'text-neutral-400 hover:bg-edge/[0.04] hover:text-neutral-200',
              )}
            >
              {iconFor(entry)}
              <span className="min-w-0 flex-1 truncate font-mono">{entry.name}/</span>
              {entry.head && <HeadBadge head={entry.head} />}
            </button>
          </li>
        ) : (
          <li
            key={entry.path}
            title={entry.path}
            className="flex items-center gap-2 px-2.5 py-1 text-11 text-neutral-600"
          >
            {iconFor(entry)}
            <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
            {entry.head && <HeadBadge head={entry.head} />}
          </li>
        ),
      )}
    </ul>
  );
}

/** 父级列根态的空占位：一行根名（站根时没有父级，几何上仍要有这一列）。 */
export function RootPlaceholderCol({ label }: { label: string }) {
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
      <li className="flex items-center gap-2 bg-blue-500/15 px-2.5 py-1 text-11 text-neutral-100">
        <Folder className="h-3.5 w-3.5 shrink-0 text-blue-300/80" />
        <span className="truncate">{label}</span>
      </li>
    </ul>
  );
}

/** 恒 3 栏骨架。`parentCol` 为 null 时摆根名占位（`parentRootLabel`）。
 *  `showPreview={false}` 收起右列（第一屏项目列表态：左占位 | 列表 | 右占位）。 */
export function FileColumnsBrowser({
  parentCol,
  parentRootLabel,
  middleCol,
  previewCol,
  leftW,
  onLeftResize,
  previewW,
  onPreviewResize,
  showPreview = true,
}: {
  /** 父级列内容；null = 根态空占位（摆一行 `parentRootLabel`）。 */
  parentCol: ReactNode | null;
  parentRootLabel: string;
  /** 中列（当前操作列）：调用方完全自定义。 */
  middleCol: ReactNode;
  /** 右列（预览）内容。 */
  previewCol: ReactNode;
  leftW: number;
  onLeftResize: (delta: number) => void;
  /** 省略 = 右列 `w-2/5` 弹性宽（不参与拖动）；给值 = 固定宽 + 可拖动。 */
  previewW?: number;
  onPreviewResize?: (delta: number) => void;
  /** false = 右列摆空占位（无预览内容可摆的第一屏）。 */
  showPreview?: boolean;
}) {
  const t = useT();
  return (
    <>
      <div
        className="flex h-full min-w-0 shrink-0 flex-col border-r border-edge/[0.18]"
        style={{ width: leftW }}
      >
        {parentCol ?? <RootPlaceholderCol label={parentRootLabel} />}
      </div>
      <Resizer onResize={onLeftResize} title={t('app.resizeLeft')} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{middleCol}</div>
      {previewW === undefined ? (
        <div className="flex w-2/5 shrink-0 flex-col border-l border-edge/[0.18]">{previewCol}</div>
      ) : (
        <>
          <Resizer onResize={onPreviewResize ?? (() => {})} title={t('app.resizePreview')} />
          <div
            className="flex min-h-0 shrink-0 flex-col border-l border-edge/[0.18]"
            style={{ width: previewW }}
          >
            {showPreview ? previewCol : <RootPlaceholderCol label="" />}
          </div>
        </>
      )}
    </>
  );
}

// ---- 窄屏（<lg）三栏同屏窄排 ----

/** 窄屏的缩小版 Finder：三栏同屏，语义与桌面一致（左=父目录 / 中=当前目录 /
 *  右=预览），一眼看清层级。活动栏占大部分宽度、实色可操作；非活动栏收成
 *  窄条（内容压暗可见——是父目录还是预览一眼即知），点按即切换为活动栏。
 *  景深：非活动栏半透明压暗，活动栏实色 + 阴影浮起。 */
export function MobileFadePanels({
  active,
  children,
}: {
  /** 当前活动栏：'list'（中栏=当前目录）/ 'left'（左栏=父目录）/ 'preview'（右栏=预览）。 */
  active: 'list' | 'left' | 'preview';
  /** 恰好三个面板：[左栏, 中栏, 右栏]。 */
  children: [ReactNode, ReactNode, ReactNode];
}) {
  const [left, list, preview] = children;
  const switchTo = (pane: string): void => {
    window.dispatchEvent(new CustomEvent('weave:mobile-pane', { detail: pane }));
  };
  /** 远处的层：收成窄条，内容压暗仍可见（一眼认出是父目录还是预览）。
   *  拦交互的是子 tap 层（z-20 盖住整栏），内容本层的命中都被它接走。 */
  const back = 'w-9 min-w-0 overflow-hidden opacity-40';
  /** 眼前的层：占满剩余宽度，实色 + 投影浮起。 */
  const front = 'flex-1 min-w-0 opacity-100 z-10 shadow-mac-lg';
  const paneCls = (isActive: boolean): string =>
    cn(
      'relative flex min-h-0 flex-col transition-all duration-300 ease-mac',
      COL_DIVIDER,
      isActive ? front : back,
      'border-r',
    );
  /** 非活动栏的点击层：盖在整栏上，点按 = 把这一栏切过来变活动。 */
  const tap = (pane: 'left' | 'list' | 'preview') =>
    pane === active ? undefined : (
      <button
        type="button"
        aria-label={pane}
        onClick={() => switchTo(pane)}
        className="absolute inset-0 z-20"
      />
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className={paneCls(active === 'left')}>
        {left}
        {tap('left')}
      </div>
      <div className={paneCls(active === 'list')}>
        {list}
        {tap('list')}
      </div>
      <div className={cn(paneCls(active === 'preview'), 'border-r-0')}>
        {preview}
        {tap('preview')}
      </div>
    </div>
  );
}

/** 窄屏面板切换事件：MobileFadePanels 的标签点击经它上报，引用方监听并
 *  把自己的 screen state 切过去（组件不持有跨页面状态）。 */
export function useMobilePaneSwitch(
  setScreen: (s: 'list' | 'left' | 'preview') => void,
): void {
  useEffect(() => {
    const onPane = (e: Event): void => {
      const d = (e as CustomEvent<string>).detail;
      setScreen(d === 'left' || d === 'preview' ? d : 'list');
    };
    window.addEventListener('weave:mobile-pane', onPane);
    return () => window.removeEventListener('weave:mobile-pane', onPane);
  }, [setScreen]);
}
