import { useState } from 'react';
import { Info, Lock, Plus, X } from 'lucide-react';
import type { TreeNodeSpec } from '@/lib/config-form';
import {
  boolOf,
  controlOf,
  defaultValueOf,
  linesOf,
  listOfLines,
  textOf,
  valueOfText,
} from '@/lib/config-form';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n/I18nProvider';

/** 树里一层的缩进（px）；树节点行与叶子行共用同一个数。 */
export const TREE_INDENT = 14;

const INPUT_CLS =
  'w-full rounded-md bg-neutral-900 border border-edge/[0.08] px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-mac-accent/50';

/** 表单的一次改动：落值或删键。 */
export interface RowEdit {
  value?: unknown;
  remove?: boolean;
}

/**
 * 树里的一片叶子：左边键名、右边按类型出的控件。
 * 托管键只读并标出来由——手改会把采集/插件/状态栏改坏。
 */
export function ConfigValueRow({
  spec,
  label,
  depth,
  value,
  managed,
  onChange,
}: {
  spec: TreeNodeSpec;
  /** 本层的键名（树上只显示这一段，完整路径在 tooltip 里）。 */
  label: string;
  depth: number;
  value: unknown;
  managed: boolean;
  onChange: (edit: RowEdit) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const set = value !== undefined;
  const control = controlOf(spec.type, spec.options);

  const body = (() => {
    if (managed) {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-neutral-500" title={t('cfg.managedHint')}>
          <Lock className="h-3 w-3" />
          <span>{t('cfg.managed')}</span>
        </div>
      );
    }
    if (control === 'switch') {
      return (
        <Switch
          checked={boolOf(value)}
          title={spec.key}
          onChange={(next) => onChange(next ? { value: true } : { remove: true })}
        />
      );
    }
    if (!set) {
      return (
        <button
          onClick={() => onChange({ value: defaultValueOf(spec.type, spec.options) })}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-edge/[0.14] px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200 hover:border-edge/[0.3]"
        >
          <Plus className="h-3 w-3" />
          {t('cfg.write')}
        </button>
      );
    }
    if (control === 'select') {
      const options = [...(spec.options ?? [])];
      const current = typeof value === 'string' ? value : textOf(value);
      if (current && !options.includes(current)) options.push(current);
      return (
        <select
          value={current}
          onChange={(e) => onChange({ value: e.target.value })}
          className={cn(INPUT_CLS, 'max-w-xs')}
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    if (control === 'number') {
      return (
        <input
          type="number"
          value={typeof value === 'number' ? value : textOf(value)}
          onChange={(e) => {
            const raw = e.target.value;
            onChange({ value: raw === '' ? undefined : Number(raw) });
          }}
          className={cn(INPUT_CLS, 'max-w-[140px]')}
        />
      );
    }
    if (control === 'list') {
      return (
        <textarea
          value={linesOf(value)}
          rows={Math.min(6, Math.max(2, linesOf(value).split('\n').length))}
          onChange={(e) => onChange({ value: listOfLines(e.target.value) })}
          className={cn(INPUT_CLS, 'font-mono')}
        />
      );
    }
    if (control === 'object') {
      return <JsonField key={JSON.stringify(value)} value={value} onCommit={(next) => onChange({ value: next })} />;
    }
    return (
      <input
        value={typeof value === 'string' ? value : textOf(value)}
        onChange={(e) => onChange({ value: e.target.value })}
        className={INPUT_CLS}
      />
    );
  })();

  return (
    <div style={{ paddingLeft: depth * TREE_INDENT }} className="group">
      <div className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-neutral-800/30">
        <span
          className={cn(
            'w-[38%] shrink-0 truncate font-mono text-[11px] leading-6',
            set ? 'text-neutral-200' : 'text-neutral-500',
          )}
          title={spec.key}
        >
          {label}
        </span>
        <div className="min-w-0 flex-1">{body}</div>
        <div className="flex shrink-0 items-center gap-1 pt-1">
          {spec.deprecated && (
            <span className="rounded bg-red-500/10 px-1 py-0.5 text-[10px] text-red-300">{t('cfg.deprecated')}</span>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={cn(
              'rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300',
              open && 'text-neutral-300',
            )}
            title={t('cfg.description')}
          >
            <Info className="h-3 w-3" />
          </button>
          {set && !managed && (
            <button
              onClick={() => onChange({ remove: true })}
              className="rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-red-300"
              title={t('cfg.clear')}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {open && (
        <p
          style={{ paddingLeft: 6 }}
          className="pb-1 pr-2 text-[11px] leading-relaxed text-neutral-500"
        >
          {spec.description}
          <span className="ml-1 text-neutral-600">{spec.group}</span>
          {spec.default && (
            <span className="ml-1 text-neutral-600">{t('cfg.defaultValue', { value: spec.default })}</span>
          )}
        </p>
      )}
    </div>
  );
}

/** 对象/数组值：文本域里按 JSON 编，失焦合法才提交。 */
function JsonField({ value, onCommit }: { value: unknown; onCommit: (next: unknown) => void }) {
  const t = useT();
  const [text, setText] = useState(() => textOf(value));
  const parsed = valueOfText(text);
  return (
    <div>
      <textarea
        value={text}
        rows={Math.min(10, Math.max(3, text.split('\n').length))}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const next = valueOfText(text);
          if (next.error === 'invalidJson') return;
          if (next.remove) return;
          onCommit(next.value);
        }}
        className={cn(INPUT_CLS, 'font-mono')}
      />
      {parsed.error === 'invalidJson' && (
        <p className="mt-0.5 text-[10px] text-red-400">{t('cfg.invalidJson')}</p>
      )}
    </div>
  );
}
