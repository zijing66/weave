import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

/** macOS 风格的迷你开关（hooks 规则节点/规则列表/插件区段共用）。 */
export function Switch({
  checked,
  onChange,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** 提示文案；缺省不弹提示。 */
  title?: string;
  /** 行级防重入：忙碌中禁点（可选，缺省恒可用）。 */
  disabled?: boolean;
}) {
  const button = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onChange(!checked);
      }}
      className={cn(
        'nodrag relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200',
        checked ? 'bg-emerald-500/80' : 'bg-neutral-600',
        disabled && 'opacity-50',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all duration-200',
          checked ? 'left-3.5' : 'left-0.5',
        )}
      />
    </button>
  );
  return title ? <Tooltip label={title}>{button}</Tooltip> : button;
}
