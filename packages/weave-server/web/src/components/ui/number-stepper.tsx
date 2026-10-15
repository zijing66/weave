import { Minus, Plus } from 'lucide-react';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';

/** 数字微调器（− 值 +）：提醒次数/保留天数/状态栏间隔这类小范围数值的统一
 *  调整面——按钮步进 + 可直接键入，越界钳回 [min, max]。增减按钮**常显**
 *  （不做 hover 才现的样式，触屏/扫视都可点）；原生 spinner 藏掉。 */
export function NumberStepper({
  value,
  min,
  max,
  disabled,
  onChange,
  title,
}: {
  value: number;
  min: number;
  max?: number;
  /** 行级防重入：忙碌中禁点。 */
  disabled?: boolean;
  onChange: (v: number) => void;
  /** 字段名（aria-label；按钮各自带增减词条）。 */
  title: string;
}) {
  const t = useT();
  const clamp = (n: number): number => Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, n));
  return (
    <span
      role="group"
      aria-label={title}
      className={cn(
        'inline-flex select-none items-stretch rounded border border-white/[0.08] bg-neutral-950 focus-within:border-blue-500/40',
        disabled && 'opacity-40',
      )}
    >
      <button
        type="button"
        aria-label={t('common.decrease')}
        title={t('common.decrease')}
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - 1))}
        className="flex w-6 items-center justify-center rounded-l bg-white/[0.04] text-neutral-400 transition-colors hover:bg-white/[0.08] hover:text-neutral-100 disabled:pointer-events-none disabled:opacity-30"
      >
        <Minus className="h-3 w-3" />
      </button>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        aria-label={title}
        onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
        className="w-14 bg-transparent px-1 text-center text-xs text-neutral-100 focus:outline-none disabled:opacity-40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        aria-label={t('common.increase')}
        title={t('common.increase')}
        disabled={disabled || (max !== undefined && value >= max)}
        onClick={() => onChange(clamp(value + 1))}
        className="flex w-6 items-center justify-center rounded-r bg-white/[0.04] text-neutral-400 transition-colors hover:bg-white/[0.08] hover:text-neutral-100 disabled:pointer-events-none disabled:opacity-30"
      >
        <Plus className="h-3 w-3" />
      </button>
    </span>
  );
}
