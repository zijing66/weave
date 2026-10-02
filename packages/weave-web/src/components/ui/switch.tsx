import { cn } from '@/lib/utils';

/** macOS 风格的迷你开关（hooks 规则节点/规则列表/插件区段共用）。 */
export function Switch({
  checked,
  onChange,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        'nodrag relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200',
        checked ? 'bg-emerald-500/80' : 'bg-neutral-600',
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
}
