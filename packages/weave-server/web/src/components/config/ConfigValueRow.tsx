import { useEffect, useRef, useState } from 'react';
import { Info, Lock, Plus, X } from 'lucide-react';
import type { ConfigFieldSpec, TreeNodeSpec } from '@/lib/config-form';
import {
  arrayItemsOf,
  boolOf,
  controlOf,
  defaultValueOf,
  emptyItemOf,
  fieldValueOf,
  linesOf,
  listOfLines,
  mapEntriesOf,
  mapOfEntries,
  shapeOf,
  textOf,
  valueOfText,
  withFieldValue,
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
  locked,
  onChange,
}: {
  spec: TreeNodeSpec;
  /** 本层的键名（树上只显示这一段，完整路径在 tooltip 里）。 */
  label: string;
  depth: number;
  value: unknown;
  managed: boolean;
  /** 这个数组里 weave 自己写进去的条目：这几行只读，其余照常增删。 */
  locked?: readonly string[];
  onChange: (edit: RowEdit) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const set = value !== undefined;
  const control = controlOf(spec.type, spec.options);
  const shape = shapeOf(spec);

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
      const empty = shape === 'map' ? {} : shape === 'array' ? [] : defaultValueOf(spec.type, spec.options);
      return (
        <button
          onClick={() => onChange({ value: empty })}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-edge/[0.14] px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200 hover:border-edge/[0.3]"
        >
          <Plus className="h-3 w-3" />
          {t('cfg.write')}
        </button>
      );
    }
    if (shape === 'map') {
      return <MapField spec={spec} value={value} onCommit={(next) => onChange({ value: next })} />;
    }
    if (shape === 'array') {
      return (
        <ListField
          spec={spec}
          value={value}
          locked={locked ?? []}
          onCommit={(next) => onChange({ value: next })}
        />
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

/** map 值的标量形状（`valueType` / `valueOptions`）当作一个匿名字段来出控件。 */
function valueSpecOf(spec: TreeNodeSpec): TreeNodeSpec {
  return {
    ...spec,
    key: `${spec.key}.*`,
    type: spec.valueType ?? 'string',
    options: spec.valueOptions,
  };
}

/**
 * map 值：键名由用户起（模型名、插件 ID），所以不能拆成点号路径的子键——
 * 一行一个条目，值按字段（或标量）在旁边编辑。草稿留在本地，键还没写完也不会掉行。
 */
function MapField({
  spec,
  value,
  onCommit,
}: {
  spec: TreeNodeSpec;
  value: unknown;
  onCommit: (next: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [rows, setRows] = useState(() => mapEntriesOf(value));
  const committed = useRef(JSON.stringify(value));
  useEffect(() => {
    const next = JSON.stringify(value);
    if (next === committed.current) return;
    committed.current = next;
    setRows(mapEntriesOf(value));
  }, [value]);

  const commit = (next: typeof rows): void => {
    setRows(next);
    // 空键名不落进对象：值没变就别攒出一条「待保存」
    const object = mapOfEntries(next);
    const json = JSON.stringify(object);
    if (json === committed.current) return;
    committed.current = json;
    onCommit(object);
  };
  const patch = (index: number, rowValue: unknown, key?: string): void =>
    commit(rows.map((row, i) => (i === index ? { key: key ?? row.key, value: rowValue } : row)));

  const fields = spec.fields ?? [];
  return (
    <div className="space-y-1">
      {rows.map((row, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <input
            value={row.key}
            onChange={(e) => patch(i, row.value, e.target.value)}
            placeholder={t('cfg.mapKey')}
            className={cn(INPUT_CLS, 'max-w-[180px] font-mono')}
          />
          <div className="min-w-0 flex-1">
            {fields.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {fields.map((f) => (
                  <FieldControl
                    key={f.name}
                    field={f}
                    value={fieldValueOf(row.value, f)}
                    onChange={(next) => patch(i, withFieldValue(row.value, f, next))}
                  />
                ))}
              </div>
            ) : (
              <PlainControl
                spec={valueSpecOf(spec)}
                value={row.value}
                onChange={(next) => patch(i, next)}
              />
            )}
          </div>
          <button
            onClick={() => commit(rows.filter((_, j) => j !== i))}
            className="mt-1 rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-red-300"
            title={t('cfg.clear')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      <button
        onClick={() => commit([...rows, { key: '', value: fields.length > 0 ? {} : emptyItemOf(valueSpecOf(spec)) }])}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-edge/[0.14] px-2 py-0.5 text-[11px] text-neutral-400 hover:border-edge/[0.3] hover:text-neutral-200"
      >
        <Plus className="h-3 w-3" />
        {t('cfg.addEntry')}
      </button>
    </div>
  );
}

/** 元素是对象的数组：一行一个元素，元素字段就在行里编。 */
function ListField({
  spec,
  value,
  locked,
  onCommit,
}: {
  spec: TreeNodeSpec;
  value: unknown;
  locked: readonly string[];
  onCommit: (next: unknown[]) => void;
}) {
  const t = useT();
  const [rows, setRows] = useState(() => arrayItemsOf(value));
  const committed = useRef(JSON.stringify(value));
  useEffect(() => {
    const next = JSON.stringify(value);
    if (next === committed.current) return;
    committed.current = next;
    setRows(arrayItemsOf(value));
  }, [value]);

  const commit = (next: unknown[]): void => {
    setRows(next);
    const kept = next.filter((item) => !isBlank(item));
    const json = JSON.stringify(kept);
    if (json === committed.current) return;
    committed.current = json;
    onCommit(kept);
  };
  const fields = spec.fields ?? [];
  return (
    <div className="space-y-1">
      {rows.map((item, i) => {
        const lock = locked.includes(String(item));
        return (
          <div key={i} className="flex items-start gap-1.5">
            {fields.length > 0 ? (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {fields.map((f) => (
                  <FieldControl
                    key={f.name}
                    field={f}
                    value={fieldValueOf(item, f)}
                    onChange={(next) =>
                      commit(rows.map((row, j) => (j === i ? withFieldValue(row, f, next) : row)))
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                {lock ? (
                  <span className="truncate font-mono text-[11px] text-neutral-400">{String(item)}</span>
                ) : (
                  <PlainControl
                    spec={valueSpecOf(spec)}
                    value={item}
                    onChange={(next) => commit(rows.map((row, j) => (j === i ? next : row)))}
                    compact
                  />
                )}
              </div>
            )}
            {lock ? (
              <span className="mt-1 flex items-center gap-1 text-[10px] text-neutral-500" title={t('cfg.managedEntry')}>
                <Lock className="h-3 w-3" />
              </span>
            ) : (
              <button
                onClick={() => commit(rows.filter((_, j) => j !== i))}
                className="mt-1 rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-red-300"
                title={t('cfg.clear')}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
      <button
        onClick={() => commit([...rows, emptyItemOf(spec)])}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-edge/[0.14] px-2 py-0.5 text-[11px] text-neutral-400 hover:border-edge/[0.3] hover:text-neutral-200"
      >
        <Plus className="h-3 w-3" />
        {t('cfg.addEntry')}
      </button>
    </div>
  );
}

/** 全空的行（空串 / 空对象）不值得写进文件。 */
function isBlank(item: unknown): boolean {
  if (item === undefined || item === null) return true;
  if (typeof item === 'string') return item.trim() === '';
  if (typeof item === 'object') return Object.keys(item as Record<string, unknown>).length === 0;
  return false;
}

/** 对象里的一个字段：小标签 + 按类型出的控件。 */
function FieldControl({
  field,
  value,
  onChange,
}: {
  field: ConfigFieldSpec;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="font-mono text-[10px] text-neutral-500" title={field.description ?? field.name}>
        {field.name}
      </span>
      <PlainControl
        spec={{ key: field.name, group: '', description: field.description ?? '', type: field.type, options: field.options }}
        value={value}
        onChange={onChange}
        compact
      />
    </label>
  );
}

/** 按类型出一个控件（不含「写」按钮与托管判定——那两层由外层负责）。 */
function PlainControl({
  spec,
  value,
  onChange,
  compact,
}: {
  spec: TreeNodeSpec;
  value: unknown;
  onChange: (next: unknown) => void;
  compact?: boolean;
}) {
  const t = useT();
  const control = controlOf(spec.type, spec.options);
  if (control === 'switch') return <Switch checked={boolOf(value)} title={spec.key} onChange={onChange} />;
  if (control === 'select') {
    const options = [...(spec.options ?? [])];
    const current = typeof value === 'string' ? value : textOf(value);
    if (current && !options.includes(current)) options.push(current);
    return (
      <select
        value={current}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        className={cn(INPUT_CLS, compact ? 'w-28' : 'max-w-xs')}
      >
        <option value="">{t('cfg.unset')}</option>
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
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className={cn(INPUT_CLS, compact ? 'w-24' : 'max-w-[140px]')}
      />
    );
  }
  if (control === 'list') {
    const text = linesOf(value);
    return (
      <textarea
        value={text}
        rows={Math.min(4, Math.max(1, text.split('\n').length))}
        onChange={(e) => onChange(listOfLines(e.target.value))}
        className={cn(INPUT_CLS, 'font-mono', compact ? 'w-40' : 'w-full')}
      />
    );
  }
  return (
    <input
      value={typeof value === 'string' ? value : textOf(value)}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      className={cn(INPUT_CLS, compact ? 'w-40' : 'w-full')}
    />
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
