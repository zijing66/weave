import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
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
import type { VisualizeRef, VizSeg } from './conv-model';

/**
 * 渲染块：assistant 气泡里的可视化引用行渲染成 sandbox iframe。
 * fetch（cookie 认证）→ materialize（CSP + 主题注入 + openai shim + resize 桥）
 * → srcdoc iframe（allow-scripts，opaque origin）。高度由 iframe 内 postMessage
 * 桥上报，父页调高（clamp 1200px，且不超过当前视口，超出内部滚动）。
 */

export function VisualizationFrame({ ref: viz }: { ref: VisualizeRef }) {
  const t = useT();
  const theme = useTheme();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [cap, setCap] = useState(VIZ_MAX_HEIGHT);
  const [nonce, setNonce] = useState(0);
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

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setHtml(null);
    api.visualizationFragment(viz.path)
      .then((res) => {
        if (!cancelled) setHtml(res.html);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [viz.path, nonce]);

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
          <button
            type="button"
            onClick={refresh}
            title={t('tasks.vizRefresh')}
            className="absolute right-1.5 top-1.5 rounded border border-edge/[0.12] bg-neutral-950/80 p-1 text-neutral-500 hover:text-neutral-200"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

/** 气泡内分段渲染：文本段走调用方给的 markdown 渲染，viz 段走 VisualizationFrame。 */
export function VizSegments({ segments, markdown }: {
  segments: readonly VizSeg[];
  markdown: (text: string) => React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 [&_p]:whitespace-pre-wrap">
      {segments.map((seg, i) =>
        seg.kind === 'viz' ? (
          <VisualizationFrame key={i} ref={seg.ref} />
        ) : seg.text.trim() ? (
          markdown(seg.text)
        ) : null,
      )}
    </div>
  );
}
