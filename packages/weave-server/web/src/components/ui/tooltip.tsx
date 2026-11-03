import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * 控件提示（替代原生 title）：hover/focus 显示、portal + fixed 定位——
 * overflow 容器裁不掉、靠右不溢出；滚动/缩放自动收起。触发器自身保持
 * 语义（不包按钮），键盘可达靠 focus。
 */

const GAP = 6;

export function Tooltip(props: {
  label: ReactNode;
  /** 提示弹层在哪一侧（缺省下侧；贴顶的控件给 top）。 */
  side?: 'top' | 'bottom';
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const side = props.side ?? 'bottom';
  const show = (): void => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setBox({
      left: Math.min(Math.max(r.left + r.width / 2, 100), window.innerWidth - 100),
      top: side === 'bottom' ? r.bottom + GAP : r.top - GAP,
    });
  };
  const hide = (): void => setBox(null);
  useEffect(() => {
    if (!box) return;
    const onScroll = (): void => setBox(null);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [box]);
  return (
    <>
      <span
        ref={ref}
        onMouseEnter={show}
        onFocus={show}
        onMouseLeave={hide}
        onBlur={hide}
        className={cn('inline-flex min-w-0', props.className)}
      >
        {props.children}
      </span>
      {box &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              left: box.left,
              top: box.top,
              transform: `translate(-50%, ${side === 'bottom' ? '0' : '-100%'})`,
            }}
            className="pointer-events-none z-[70] max-w-64 rounded-lg border border-edge/[0.12] bg-neutral-900 px-2.5 py-1.5 text-11 leading-4 text-neutral-300 shadow-mac"
          >
            {props.label}
          </div>,
          document.body,
        )}
    </>
  );
}
