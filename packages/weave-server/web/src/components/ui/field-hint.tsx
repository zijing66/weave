import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cssPx } from '@/lib/font-scale';
import { useMediaQuery } from '@/lib/use-media-query';

/**
 * 字段/标题说明的小问号：说明收进悬停提示，不再占标题下方一整行。
 *
 * 定位走 fixed + portal——设置面板、卡片内容区多半是 overflow 容器，绝对定位会被
 * 裁掉；水平位置夹在视口内，靠右的字段也不会溢出。点击可切换（触屏没有 hover），
 * 滚动/缩放自动收起（fixed 坐标会跟着失真）。
 */

/** 同一次手势的间隔上限：触屏/键盘的动作里合成 hover/focus 先到、click 后到，
 *  盖章后这么久以内的 click 只确保显示、不反转（否则 tap 等于没反应）。 */
const GESTURE_GAP_MS = 500;

export function FieldHint(props: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);
  const shownAt = useRef(0);
  // 触屏没有 hover：tap 合成的 mouseenter 不会跟着 mouseleave，tooltip 会挂着
  // 关不掉——coarse 指针只走点击切换（下方 onClick 的盖章逻辑）。
  const coarse = useMediaQuery('(pointer: coarse)');
  const show = (): void => {
    if (coarse) return;
    shownAt.current = Date.now();
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(280, window.innerWidth - 24);
    const half = width / 2 + 12;
    // 视觉 px 落 style 前经 cssPx 除回 CSS 值（根 zoom 会把 fixed 的 CSS 值再乘一次）。
    setBox({
      left: cssPx(Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half)),
      top: cssPx(r.bottom + 6),
      width: cssPx(width),
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
        onClick={() => {
          // 触屏：tap 合成的 mouseenter 已被 show 里的 coarse 闸挡掉，这里就是
          // 唯一入口——点击切换（开着的关、关着的开）。
          if (coarse) {
            if (box) hide();
            else {
              shownAt.current = Date.now();
              const r = ref.current?.getBoundingClientRect();
              if (r) {
                const width = Math.min(280, window.innerWidth - 24);
                const half = width / 2 + 12;
                setBox({
                  left: cssPx(Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half)),
                  top: cssPx(r.bottom + 6),
                  width: cssPx(width),
                });
              }
            }
            return;
          }
          if (box && Date.now() - shownAt.current > GESTURE_GAP_MS) hide();
          else show();
        }}
        className={cn(
          'ml-1 inline-flex shrink-0 items-center rounded-full text-neutral-500 hover:text-neutral-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
          props.className,
        )}
      >
        <HelpCircle className="h-3 w-3" />
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
