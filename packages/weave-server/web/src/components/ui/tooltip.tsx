import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { cssPx } from '@/lib/font-scale';
import { useMediaQuery } from '@/lib/use-media-query';

/**
 * 控件提示（替代原生 title）：hover/focus 显示、portal + fixed 定位——
 * overflow 容器裁不掉；滚动/缩放自动收起。触发器自身保持语义（不包按钮），
 * 键盘可达靠 focus。定位两步走：先按偏好侧摆，弹层渲染后量实际尺寸——
 * 越界就夹回视口内，底部/顶部放不下就地翻侧（偏好侧只是偏好不是硬承诺）。
 */

const GAP = 6;
const MARGIN = 8;

interface TipBox {
  anchor: DOMRect;
  side: 'top' | 'bottom';
  /** 量宽后算出的最终位置（首次渲染前 null → 摆屏外防闪）。 */
  pos: { left: number; top: number } | null;
}

export function Tooltip(props: {
  label: ReactNode;
  /** 偏好侧（缺省下侧；贴顶的控件给 top）。放不下时自动翻转。 */
  side?: 'top' | 'bottom';
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<TipBox | null>(null);
  // 触屏没有 hover：tap 合成的 mouseenter 不会跟着 mouseleave（手指抬起不发它），
  // tooltip 会一直挂着关不掉——coarse 指针干脆不响应 hover/focus 显示。
  const coarse = useMediaQuery('(pointer: coarse)');

  const show = (): void => {
    if (coarse) return;
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setBox({ anchor: r, side: props.side ?? 'bottom', pos: null });
  };
  const hide = (): void => setBox(null);

  // 弹层渲染后量实际尺寸定最终位置（pos 落状态，重渲不会被打回 -9999）：
  // 先夹水平，再判垂直放不放得下、放不下翻侧（翻侧重进本 effect 再量一次）。
  // 坐标系统一视觉 px：锚点矩形、弹层尺寸、innerWidth/innerHeight 全是视觉 px，
  // 同系比较自洽；只在落 style 前经 cssPx 除回 CSS 值（fixed 的 CSS 值会被根
  // zoom 再乘一次）。
  useLayoutEffect(() => {
    if (!box || box.pos) return;
    const tip = tipRef.current;
    if (!tip) return;
    const { width, height } = tip.getBoundingClientRect();
    const centerX = box.anchor.left + box.anchor.width / 2;
    const left = Math.min(
      Math.max(centerX, width / 2 + MARGIN),
      window.innerWidth - width / 2 - MARGIN,
    );
    const fitsBottom = box.anchor.bottom + GAP + height <= window.innerHeight - MARGIN;
    const fitsTop = box.anchor.top - GAP - height >= MARGIN;
    let side = box.side;
    if (side === 'bottom' && !fitsBottom && fitsTop) side = 'top';
    if (side === 'top' && !fitsTop && fitsBottom) side = 'bottom';
    const top = side === 'bottom' ? box.anchor.bottom + GAP : box.anchor.top - GAP - height;
    setBox({ ...box, side, pos: { left: cssPx(left), top: cssPx(top) } });
  }, [box]);

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
            ref={tipRef}
            role="tooltip"
            style={{
              position: 'fixed',
              left: box.pos?.left ?? -9999,
              top: box.pos?.top ?? -9999,
              transform: 'translateX(-50%)',
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
