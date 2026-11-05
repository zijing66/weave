import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, RefreshCw, X } from 'lucide-react';
import { api } from '@/lib/api';
import {
  materialize,
  themeVarsOf,
  visualizationHeightCap,
  CONV_SCROLLER_ATTR,
  VIZ_MIN_HEIGHT,
  VIZ_MAX_HEIGHT,
} from '@/lib/visualization';
import { useTheme } from '@/lib/theme';
import { useT } from '@/i18n/I18nProvider';
import { Tooltip } from '@/components/ui/tooltip';
import type { VisualizeRef, VizSeg } from './conv-model';

/**
 * 渲染块：assistant 气泡里的可视化引用行渲染成 sandbox iframe。
 * fetch（cookie 认证）→ materialize（CSP + 主题注入 + openai shim + resize 桥）
 * → srcdoc iframe（allow-scripts，opaque origin）。高度由 iframe 内 postMessage
 * 桥上报，父页调高（clamp 1200px，且不超过当前视口，超出内部滚动）。
 */

/** 热更新的轮询间隔：fragment 是模型边跑边写的活文件，4s 一拍足够跟上节奏，
 *  又不会让一个会话里几枚块把请求打成筛子。 */
const VIZ_POLL_MS = 4000;

export function VisualizationFrame({ ref: viz }: { ref: VisualizeRef }) {
  const t = useT();
  const theme = useTheme();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [cap, setCap] = useState(VIZ_MAX_HEIGHT);
  const [nonce, setNonce] = useState(0);
  /** wide 块的全屏面板（codex 的 wide 语义：气泡内照常，点开铺到 1024px 上限）。 */
  const [expanded, setExpanded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 上限基准 = 对话滚动容器（气泡区），不是窗口：右栏 / 手机抽屉里对话区远小于视口。
  // 容器尺寸一变（转屏 / 拉窗口 / 抽屉展开）就重算，已报上来的高度也被重新收口。
  useEffect(() => {
    const scroller =
      wrapRef.current?.closest<HTMLElement>(`[${CONV_SCROLLER_ATTR}]`) ?? document.documentElement;
    const measure = (): void => setCap(visualizationHeightCap(scroller.clientHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, []);

  /** 手上这份内容的 mtime：热更新拿它作条件（变了才换正文）。 */
  const mtimeRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setHtml(null);
    mtimeRef.current = null;
    api.visualizationFragment(viz.path)
      .then((res) => {
        if (cancelled) return;
        mtimeRef.current = res.mtimeMs;
        if (res.html != null) setHtml(res.html);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [viz.path, nonce]);

  // 热更新：模型边跑边重写同一份 fragment，挂载期间按 mtime 轻量轮询，变了才
  // 换正文（服务端只回标记，不搬整份文件）；后台标签页跳过，卸载即停表。
  // 换 html 会让 iframe 重载——跨文档留不住滚动位置，这是 v1 认下的代价。
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden || mtimeRef.current == null) return;
      api
        .visualizationFragment(viz.path, mtimeRef.current)
        .then((res) => {
          if (res.unchanged || res.html == null) return;
          mtimeRef.current = res.mtimeMs;
          setHtml(res.html);
        })
        // 轮询失败静默：手上那份还能看，下一拍再试，不把错误盖上去
        .catch(() => {});
    }, VIZ_POLL_MS);
    return () => clearInterval(timer);
  }, [viz.path]);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const data = e.data as { type?: unknown; height?: unknown } | null;
      if (data?.type !== 'viz-resize' || typeof data.height !== 'number') return;
      setHeight(Math.min(Math.max(Math.round(data.height), VIZ_MIN_HEIGHT), VIZ_MAX_HEIGHT));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const doc = html ? materialize(html, { theme, vars: themeVarsOf() }) : null;

  return (
    <div ref={wrapRef} className="overflow-hidden rounded-md border border-edge/[0.12] bg-neutral-950/40">
      {!doc && !error && (
        <div className="flex items-center gap-2 px-3 py-4 text-11 text-neutral-500">
          <RefreshCw className="h-3 w-3 animate-spin" />
          {t('tasks.vizLoading')}
        </div>
      )}
      {error ? (
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <span className="min-w-0 text-11 text-red-300">
            {t('tasks.vizFailed')}
            {error.includes('outside the allowed roots') ? ` — ${t('tasks.vizOutside')}` : ''}
            <span className="block truncate font-mono text-10 text-neutral-600">{viz.path}</span>
          </span>
          <button
            type="button"
            onClick={refresh}
            className="shrink-0 rounded border border-edge/[0.12] px-1.5 py-0.5 text-10 text-neutral-400 hover:text-neutral-200"
          >
            {t('tasks.vizRetry')}
          </button>
        </div>
      ) : null}
      {doc && (
        <div className="relative">
          <iframe
            ref={frameRef}
            key={`${nonce}-${theme}`}
            title={viz.title ?? viz.path}
            sandbox="allow-scripts"
            srcDoc={doc}
            className="block w-full border-0"
            style={{ height: Math.min(Math.max(height ?? 160, VIZ_MIN_HEIGHT), cap) }}
          />
          <div className="absolute right-1.5 top-1.5 flex gap-1">
            {viz.mode === 'wide' && (
              <Tooltip label={t('tasks.vizExpand')}>
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="rounded border border-edge/[0.12] bg-neutral-950/80 p-1 text-neutral-500 hover:text-neutral-200"
                >
                  <Maximize2 className="h-3 w-3" />
                </button>
              </Tooltip>
            )}
            <Tooltip label={t('tasks.vizRefresh')}>
              <button
                type="button"
                onClick={refresh}
                className="rounded border border-edge/[0.12] bg-neutral-950/80 p-1 text-neutral-500 hover:text-neutral-200"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </Tooltip>
          </div>
        </div>
      )}
      {expanded && doc
        ? createPortal(
            <div
              className="fixed inset-0 z-[65] flex items-center justify-center bg-black/60 p-3"
              onClick={() => setExpanded(false)}
            >
              <div
                className="relative flex h-[88vh] w-[min(1024px,92vw)] flex-col overflow-hidden rounded-xl border border-edge/[0.12] bg-neutral-900 shadow-mac"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-edge/[0.06] px-3">
                  <span className="truncate text-11 text-neutral-400">{viz.title ?? viz.path}</span>
                  <Tooltip label={t('tasks.vizClose')}>
                    <button
                      type="button"
                      onClick={() => setExpanded(false)}
                      className="shrink-0 rounded p-1 text-neutral-500 hover:text-neutral-200"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                </div>
                <iframe
                  title={viz.title ?? viz.path}
                  sandbox="allow-scripts"
                  srcDoc={doc}
                  className="min-h-0 w-full flex-1 border-0"
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** 气泡内分段渲染：文本段走调用方给的 markdown 渲染，viz 段走 VisualizationFrame。 */
export function VizSegments({ segments, markdown }: {
  segments: readonly VizSeg[];
  markdown: (text: string) => React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5 [&_p]:whitespace-pre-wrap">
      {segments.map((seg, i) =>
        seg.kind === 'viz' ? (
          <VisualizationFrame key={i} ref={seg.ref} />
        ) : seg.kind === 'vizUnavailable' ? (
          <div key={i} className="rounded-md border border-edge/[0.12] bg-neutral-950/40 px-3 py-2 text-11 text-neutral-500">
            {t('tasks.vizUnavailable')}
          </div>
        ) : seg.text.trim() ? (
          markdown(seg.text)
        ) : null,
      )}
    </div>
  );
}
