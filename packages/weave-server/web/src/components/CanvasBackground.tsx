import { useSyncExternalStore } from 'react';
import { Background, BackgroundVariant, Panel } from '@xyflow/react';
import { Ban, Grid3x3, Grip, Plus, type LucideIcon } from 'lucide-react';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { cn } from '@/lib/utils';

/**
 * 画布底纹（事件链 / 编排 / 钩子链路三处 ReactFlow 共用一份偏好）：
 * 网格线帮眼睛对齐节点，底色帮区分「这块是画布、不是页面」。
 * 选择存 localStorage —— 一处调完三处一起变。
 */
export type CanvasPattern = 'lines' | 'dots' | 'cross' | 'none';
export type CanvasTint = 'none' | 'sky' | 'violet' | 'emerald' | 'amber';

interface CanvasBg {
  pattern: CanvasPattern;
  tint: CanvasTint;
}

const KEY = 'weave:canvas-bg';

/** 底纹图标即选项：网格 = 事件链默认（原先是几乎看不见的点阵）。 */
const PATTERNS: { id: CanvasPattern; icon: LucideIcon; label: MessageKey }[] = [
  { id: 'lines', icon: Grid3x3, label: 'common.canvas.lines' },
  { id: 'dots', icon: Grip, label: 'common.canvas.dots' },
  { id: 'cross', icon: Plus, label: 'common.canvas.cross' },
  { id: 'none', icon: Ban, label: 'common.canvas.none' },
];

/** 底色走 950 档：暗色下是近黑的染色，浅色下同档翻转成 50 档的淡染（见 tailwind.config.js）。 */
const TINT_BG: Record<CanvasTint, string> = {
  none: 'bg-neutral-950/40',
  sky: 'bg-sky-950/55',
  violet: 'bg-violet-950/55',
  emerald: 'bg-emerald-950/55',
  amber: 'bg-amber-950/55',
};

const TINTS: { id: CanvasTint; dot: string; label: MessageKey }[] = [
  { id: 'none', dot: 'bg-neutral-500', label: 'common.canvas.tintNone' },
  { id: 'sky', dot: 'bg-sky-500', label: 'common.canvas.tintSky' },
  { id: 'violet', dot: 'bg-violet-500', label: 'common.canvas.tintViolet' },
  { id: 'emerald', dot: 'bg-emerald-500', label: 'common.canvas.tintEmerald' },
  { id: 'amber', dot: 'bg-amber-500', label: 'common.canvas.tintAmber' },
];

const GEOMETRY: Record<Exclude<CanvasPattern, 'none'>, { variant: BackgroundVariant; gap: number; size: number }> = {
  lines: { variant: BackgroundVariant.Lines, gap: 16, size: 1 },
  dots: { variant: BackgroundVariant.Dots, gap: 14, size: 1 },
  cross: { variant: BackgroundVariant.Cross, gap: 24, size: 6 },
};

/** 深浅色通吃：`--w-edge` 暗色是白、浅色是黑，一处 alpha 两套都对。 */
const LINE_COLOR = 'rgb(var(--w-edge) / 0.12)';

function stored(): CanvasBg {
  const fallback: CanvasBg = { pattern: 'lines', tint: 'none' };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<CanvasBg> | null;
    return {
      pattern: PATTERNS.some((p) => p.id === raw?.pattern) ? (raw!.pattern as CanvasPattern) : fallback.pattern,
      tint: TINTS.some((x) => x.id === raw?.tint) ? (raw!.tint as CanvasTint) : fallback.tint,
    };
  } catch {
    return fallback;
  }
}

let current: CanvasBg = stored();
const listeners = new Set<() => void>();

function commit(next: CanvasBg): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 隐私模式写不进去：本次会话内照样生效
  }
  for (const listener of listeners) listener();
}

export function setCanvasPattern(pattern: CanvasPattern): void {
  commit({ ...current, pattern });
}

export function setCanvasTint(tint: CanvasTint): void {
  commit({ ...current, tint });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): CanvasBg {
  return current;
}

export function useCanvasBg(): CanvasBg {
  return useSyncExternalStore(subscribe, snapshot);
}

/** 画布容器的底色类：放在 ReactFlow 外层那块 div 上（`.react-flow` 自带同键样式，会被抢）。 */
export function useCanvasTintClass(): string {
  return TINT_BG[useCanvasBg().tint];
}

export function CanvasBackground() {
  const { pattern, tint } = useCanvasBg();
  const t = useT();
  const geometry = pattern === 'none' ? null : GEOMETRY[pattern];
  return (
    <>
      {geometry && (
        <Background variant={geometry.variant} gap={geometry.gap} size={geometry.size} color={LINE_COLOR} />
      )}
      <Panel
        position="bottom-right"
        onClick={(e) => e.stopPropagation()}
        className="nopan flex items-center gap-0.5 rounded-md border border-edge/[0.08] bg-neutral-900/85 p-0.5 opacity-70 shadow-mac-sm backdrop-blur-sm transition-opacity hover:opacity-100 max-lg:opacity-100"
      >
        {PATTERNS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            title={t(label)}
            aria-label={t(label)}
            aria-pressed={pattern === id}
            onClick={() => setCanvasPattern(id)}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded',
              pattern === id
                ? 'bg-edge/[0.14] text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-200',
            )}
          >
            <Icon size={12} />
          </button>
        ))}
        <span className="mx-0.5 h-3 w-px bg-edge/[0.12]" />
        {TINTS.map(({ id, dot, label }) => (
          <button
            key={id}
            type="button"
            title={t(label)}
            aria-label={t(label)}
            aria-pressed={tint === id}
            onClick={() => setCanvasTint(id)}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-full border',
              tint === id ? 'border-edge/50' : 'border-transparent hover:border-edge/25',
            )}
          >
            <span className={cn('h-2.5 w-2.5 rounded-full', dot)} />
          </button>
        ))}
      </Panel>
    </>
  );
}
