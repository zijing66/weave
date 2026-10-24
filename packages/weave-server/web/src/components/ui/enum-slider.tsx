import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBackPop } from '@/lib/back-pop';
import { commitOf, indexOf } from './enum-slider-core';

/** 当前档文字色 = 宿主状态栏 thinking 块的紫（claude statusline 的 `#bb9af7`），
 *  与底条 🧩 块同色相——同一个事实在两处长得像。 */
const CURRENT_TINT = '#bb9af7';

/**
 * 思考强度选择器（收起 = 当前档 + 下拉箭头的一枚按钮；点开 = 浮层里的滑动条，
 * **关闭浮层才提交**——拖动全程只是预览，误拖关掉即弃，不产生任何命令）。
 *
 * 浮层结构照参考实现：自绘轨道（渐变底 + 已走过的紫色 fill）+ 刻度点均分在
 * 轨道上 + thumb 骑在 fill 头上；原生 range 只当透明输入层（拖动/触屏/方向键
 * 全免费）。档名一排摆在轨道下方（浮层里放得下，全显示）。Esc / 点外面 =
 * 关闭并提交；拖动中直接关 = 预览作废。
 */
export function EnumSlider({
  levels,
  value,
  disabled,
  onCommit,
  title,
}: {
  /** 档位词表（宿主自己的名字，展示原样）；空 = 调用方不渲染本组件。 */
  levels: readonly string[];
  /** 当前档位（最后已知）；不在词表内 = 没有选中态，滑块停第一档。 */
  value: string | null;
  disabled?: boolean;
  /** 关闭浮层时提交（拖动过程不触发）。 */
  onCommit: (level: string) => void;
  /** 字段名（aria-label / 按钮 title）。 */
  title: string;
}) {
  const [open, setOpen] = useState(false);
  /** 浮层里的预览档（拖动中变）；关闭时按它裁决提交。 */
  const [draft, setDraft] = useState<number | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => setDraft(null), [value, levels, open]);

  const shown = draft ?? indexOf(levels, value);
  const last = Math.max(0, levels.length - 1);
  const pct = last === 0 ? 0 : (shown / last) * 100;

  const close = (commitDraft: boolean): void => {
    setOpen(false);
    if (commitDraft && draft !== null) {
      const level = commitOf(levels, value, draft);
      if (level !== null) onCommit(level);
    }
    setDraft(null);
  };

  // 外点 / Esc 关闭（并提交）——与对话面板其它浮层同一套手势
  useEffect(() => {
    if (!open) return;
    const dismiss = (e: Event): void => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[data-effort-pop]') || t?.closest?.('[data-effort-btn]')) return;
      e.stopPropagation();
      close(true);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(true);
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('wheel', () => close(true), { capture: true, passive: true });
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('wheel', () => close(true), { capture: true } as EventListenerOptions);
      window.removeEventListener('keydown', key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft, value, levels]);

  // 移动端返回键/侧滑 = 关闭浮层并提交（与 Esc 同一口径）
  useBackPop(open, () => {
    close(true);
    return true;
  });

  const anchor = btnRef.current?.getBoundingClientRect();
  return (
    <span className="relative inline-flex min-w-0 items-center">
      <button
        ref={btnRef}
        type="button"
        data-effort-btn
        disabled={disabled}
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={() => (open ? close(true) : setOpen(true))}
        className="inline-flex min-w-0 shrink-0 items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 transition-colors hover:border-blue-500/40 disabled:opacity-40"
      >
        <span
          style={{ color: CURRENT_TINT }}
          className="truncate font-mono text-11"
        >
          {value ?? '—'}
        </span>
        <ChevronDown className={cn('h-3 w-3 shrink-0 text-neutral-500 transition-transform', open && 'rotate-180')} />
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            data-effort-pop
            className="fixed z-[60] w-56 rounded-lg border border-edge/[0.12] bg-neutral-900 p-3 shadow-mac"
            style={{
              left: Math.max(8, Math.min(anchor.left, window.innerWidth - 232)),
              top: Math.min(anchor.bottom + 6, window.innerHeight - 140),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-baseline justify-end">
              <span style={{ color: CURRENT_TINT }} className="font-mono text-11">
                {levels[shown] ?? ''}
              </span>
            </div>
            {/* 滑杆区：自绘轨道（渐变底 + 紫 fill）+ 刻度点 + thumb；透明 range 叠加 */}
            <span className="relative inline-flex w-full flex-col pt-3.5">
              <span
                className="relative h-2 w-full rounded-full"
                style={{
                  background:
                    'linear-gradient(to right, rgba(255,255,255,0.05), rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.05))',
                }}
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-150"
                  style={{
                    width: `${pct}%`,
                    background: 'linear-gradient(90deg, #4f46e5, #8b5cf6)',
                    boxShadow: '0 0 10px rgba(139,92,246,0.45)',
                  }}
                />
                {levels.map((_, i) => (
                  <span
                    key={i}
                    style={{ left: `${last === 0 ? 0 : (i / last) * 100}%` }}
                    className={cn(
                      'absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full',
                      i <= shown ? 'bg-white/80' : 'bg-neutral-600',
                    )}
                  />
                ))}
                <span
                  style={{ left: `${pct}%` }}
                  className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-violet-300 bg-neutral-200 shadow-[0_0_8px_rgba(139,92,246,0.5)]"
                />
              </span>
              {/* 档名行：浮层里放得下，全显示；当前档紫色高亮 */}
              <span className="mt-1.5 flex items-start justify-between">
                {levels.map((level, i) => (
                  <span
                    key={level}
                    style={i === shown ? { color: CURRENT_TINT } : undefined}
                    className={cn('text-10 leading-none', i !== shown && 'text-neutral-500')}
                  >
                    {level}
                  </span>
                ))}
              </span>
              <input
                type="range"
                min={0}
                max={last}
                step={1}
                value={shown}
                aria-label={title}
                onChange={(e) => setDraft(Number(e.target.value))}
                className="absolute inset-x-0 -top-1 bottom-[-6px] w-full cursor-pointer appearance-none bg-transparent opacity-0 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:appearance-none"
              />
            </span>
          </div>,
          document.body,
        )}
    </span>
  );
}
