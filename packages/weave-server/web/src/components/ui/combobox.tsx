import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useT } from '@/i18n/I18nProvider';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';

/** 下拉里的一行：value 唯一；label 缺省用 value；hint 是第二行灰字（说明/真名）。 */
export interface ComboboxOption {
  value: string;
  label?: string;
  hint?: string;
}

/**
 * 统一下拉（全站 16 处原生 select 的替换面）：可搜、虚拟滚动（几百上千项不卡）、
 * 键盘可达（↑↓ 移动 / Enter 选 / Esc 关）、触屏友好（选项行高 ≥28px、点选即落）。
 *
 * - `value === ''` 表示「未选」：渲染成列表头部的清空项（与原生 select 的空 option 同义）。
 * - `creatable`：输入的文本不在候选里时，列表顶部给「用 "xxx"」一行——env 变量名
 *   这类「词表是建议不是白名单」的场景用。
 * - 弹层走 portal + fixed 定位（锚点矩形翻转防溢出），z-[60] 盖过对话框。
 * - 触屏（coarse pointer）不自动聚焦搜索框（弹软键盘遮住列表），桌面 autofocus。
 */
export function Combobox({
  value,
  options,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  creatable,
  creatableLabel,
  disabled,
  title,
  className,
  align = 'start',
}: {
  /** 当前值（'' = 未选）。 */
  value: string;
  options: readonly ComboboxOption[];
  onChange: (value: string) => void;
  /** 收起态占位文案。 */
  placeholder?: string;
  searchPlaceholder?: string;
  /** 过滤无命中时的文案。 */
  emptyText?: string;
  /** 允许自由输入（候选外的值也接受）。 */
  creatable?: boolean;
  /** creatable 行的文案模板，`{value}` 会被替换。 */
  creatableLabel?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  /** 弹层与锚点的对齐（窄容器里 end 对齐防出屏）。 */
  align?: 'start' | 'end';
}) {
  const t = useT();
  const coarse = useMediaQuery('(pointer: coarse)');
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.value.toLowerCase().includes(q) || (o.label ?? '').toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q),
    );
  }, [options, query]);
  const exactHit = query.trim() !== '' && options.some((o) => o.value === query.trim());
  const rows: Array<{ kind: 'option'; option: ComboboxOption } | { kind: 'create'; value: string } | { kind: 'clear' }> =
    useMemo(() => {
      const out: Array<{ kind: 'option'; option: ComboboxOption } | { kind: 'create'; value: string } | { kind: 'clear' }> = [];
      if (value !== '') out.push({ kind: 'clear' });
      if (creatable && !exactHit) out.push({ kind: 'create', value: query.trim() });
      for (const option of filtered) out.push({ kind: 'option', option });
      return out;
    }, [creatable, exactHit, filtered, query, value]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 30,
    overscan: 8,
  });

  // 打开时定位弹层（锚点矩形 + 视口翻转），滚动/改窗即关——位置失真不如收起。
  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const width = Math.max(r.width, 220);
    const left = align === 'end' ? r.right - width : r.left;
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const height = Math.min(320, Math.max(below, above) - 8);
    setRect({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: below >= above || below > height ? r.bottom + 4 : Math.max(8, r.top - height - 4),
      width,
    });
  }, [align, open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event): void => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // 打开即定位到当前值；搜索框桌面自动聚焦（触屏不弹软键盘）。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const idx = rows.findIndex((r) => (r.kind === 'option' ? r.option.value === value : false));
    setActive(Math.max(0, idx));
    if (!coarse) searchRef.current?.focus();
    // rows 初值依赖 value/options，打开瞬间算一次即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 键盘移动时把活跃行滚进视野（虚拟列表要手动 scrollToIndex）。
  useEffect(() => {
    if (!open) return;
    virtualizer.scrollToIndex(active);
  }, [active, open, virtualizer]);

  const pick = (row: (typeof rows)[number]): void => {
    if (row.kind === 'clear') onChange('');
    else if (row.kind === 'create') onChange(row.value);
    else onChange(row.option.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // 输入法组字中的方向键/回车是宿主输入法的，不抢
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((i) => Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1))));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const row = rows[active];
      if (row) pick(row);
      return;
    }
  };

  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={cn(
          'flex min-w-0 items-center gap-1 rounded-md bg-neutral-900 border border-edge/[0.08] px-2 py-1 text-xs text-neutral-200 focus:outline-none focus:border-mac-accent/50 disabled:opacity-40',
          className,
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate text-left', current ? '' : 'text-neutral-500')}>
          {current ? (current.label ?? current.value) : (placeholder ?? t('common.empty'))}
        </span>
        <ChevronDown className={cn('h-3 w-3 shrink-0 text-neutral-500 transition-transform', open && 'rotate-180')} />
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={popRef}
            style={{ left: rect.left, top: rect.top, width: rect.width }}
            className="fixed z-[60] flex max-h-[320px] flex-col rounded-lg border border-edge/[0.1] bg-neutral-900 shadow-mac"
          >
            <div className="flex shrink-0 items-center gap-1.5 border-b border-edge/[0.06] px-2 py-1.5">
              <Search className="h-3 w-3 shrink-0 text-neutral-500" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder={searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
              />
            </div>
            <div ref={listRef} id={listId} role="listbox" className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
              {rows.length === 0 ? (
                <p className="px-2.5 py-2 text-[11px] text-neutral-500">{emptyText ?? t('common.empty')}</p>
              ) : (
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((vi) => {
                    const row = rows[vi.index]!;
                    const isActive = vi.index === active;
                    const selected = row.kind === 'option' && row.option.value === value;
                    return (
                      <button
                        key={row.kind === 'clear' ? '__clear__' : row.kind === 'create' ? '__create__' : row.option.value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                        onMouseEnter={() => setActive(vi.index)}
                        onClick={() => pick(row)}
                        className={cn(
                          'flex min-h-[28px] items-center gap-2 px-2.5 py-1 text-left text-xs transition-colors',
                          isActive ? 'bg-blue-500/15 text-neutral-100' : 'text-neutral-300',
                        )}
                      >
                        {row.kind === 'clear' ? (
                          <span className="text-neutral-500">{t('cfg.unset')}</span>
                        ) : row.kind === 'create' ? (
                          <span className="truncate text-neutral-200">
                            {(creatableLabel ?? '用 “{value}”').replace('{value}', row.value)}
                          </span>
                        ) : (
                          <>
                            <span className="min-w-0 flex-1 truncate">{row.option.label ?? row.option.value}</span>
                            {row.option.hint && (
                              <span className="shrink-0 truncate text-[10px] text-neutral-500">{row.option.hint}</span>
                            )}
                            {selected && <Check className="h-3 w-3 shrink-0 text-mac-accent" />}
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
