import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 字段/标题说明的小问号：说明收进悬停提示，不再占标题下方一整行。
 *
 * 定位走 fixed + portal——设置面板、卡片内容区多半是 overflow 容器，绝对定位会被
 * 裁掉；水平位置夹在视口内，靠右的字段也不会溢出。点击可切换（触屏没有 hover），
 * 滚动/缩放自动收起（fixed 坐标会跟着失真）。
 */
export function FieldHint(props: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);
  const show = (): void => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(280, window.innerWidth - 24);
    const half = width / 2 + 12;
    setBox({
      left: Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half),
      top: r.bottom + 6,
      width,
    });
  };
  const hide = (): void => setBox(null);
  // 滚动/缩放后 fixed 坐标就错了：一滚就收，下一次悬停再算
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
      <button
        ref={ref}
        type="button"
        aria-label={typeof props.children === 'string' ? props.children : undefined}
        onMouseEnter={show}
        onFocus={show}
        onMouseLeave={hide}
        onBlur={hide}
        onClick={() => (box ? hide() : show())}
        className={cn(
          'ml-0.5 -translate-y-1 shrink-0 rounded-full text-neutral-600 hover:text-neutral-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
          props.className,
        )}
      >
        <HelpCircle className="h-2.5 w-2.5" />
      </button>
      {box &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              left: box.left,
              top: box.top,
              width: box.width,
              transform: 'translateX(-50%)',
            }}
            className="pointer-events-none z-[70] rounded-lg border border-edge/[0.12] bg-neutral-900 px-2.5 py-1.5 text-11 leading-4 text-neutral-300 shadow-mac"
          >
            {props.children}
          </div>,
          document.body,
        )}
    </>
  );
}
