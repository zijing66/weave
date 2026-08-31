import { useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';

/**
 * Drag handle that resizes an adjacent region. The owning component tracks the
 * actual size; this only reports movement deltas (px) along the drag axis.
 *
 * `orientation` selects the axis: `horizontal` resizes a column (tracks
 * `clientX`, `cursor-col-resize`), `vertical` resizes a row (tracks `clientY`,
 * `cursor-row-resize`). Pointer events are captured so the drag keeps working
 * even when the pointer leaves the handle.
 */
export function Resizer({
  onResize,
  orientation = 'horizontal',
  className,
  title,
}: {
  /** Called with the cumulative delta since the drag started (px). */
  onResize: (delta: number) => void;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  title?: string;
}) {
  const isVertical = orientation === 'vertical';
  const start = useRef<number | null>(null);
  const last = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      start.current = isVertical ? e.clientY : e.clientX;
      last.current = 0;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [isVertical],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (start.current == null) return;
      const current = isVertical ? e.clientY : e.clientX;
      const delta = current - start.current;
      onResize(delta - last.current);
      last.current = delta;
    },
    [onResize, isVertical],
  );

  const onPointerUp = useCallback(() => {
    start.current = null;
  }, []);

  return (
    <div
      role="separator"
      aria-orientation={isVertical ? 'horizontal' : 'vertical'}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        'shrink-0 touch-none bg-transparent transition-colors',
        'hover:bg-blue-500/40 active:bg-blue-500/60',
        isVertical ? 'h-1.5 w-full cursor-row-resize' : 'w-1.5 cursor-col-resize',
        className,
      )}
    />
  );
}
