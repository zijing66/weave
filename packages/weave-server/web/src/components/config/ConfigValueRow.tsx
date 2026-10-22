import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Info, Lock, Plus, RotateCcw, X } from 'lucide-react';
import type { ConfigFieldSpec, TreeNodeSpec } from '@/lib/config-form';
import {
  arrayItemsOf,
  boolOf,
  controlOf,
  defaultValueOf,
  emptyItemOf,
  linesOf,
  listOfLines,
  mapEntriesOf,
  mapOfEntries,
  shapeOf,
  textOf,
  valueOfText,
} from '@/lib/config-form';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
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
      return (
        <ShapedField count={mapEntriesOf(value).length} label={`${mapEntriesOf(value).length}`}>
          <MapField spec={spec} value={value} onCommit={(next) => onChange({ value: next })} />
        </ShapedField>
      );
    }
    if (shape === 'array') {
      const items = arrayItemsOf(value);
      return (
        <ShapedField count={items.length} label={String(items.length)}>
          <ListField
            spec={spec}
            value={value}
            locked={locked ?? []}
            onCommit={(next) => onChange({ value: next })}
          />
        </ShapedField>
      );
    }
    if (control === 'select') {
      const options = [...(spec.options ?? [])];
      const current = typeof value === 'string' ? value : textOf(value);
      if (current && !options.includes(current)) options.push(current);
      return (
        <Combobox
          value={current}
          options={options.map((opt) => ({ value: opt }))}
          onChange={(next) => onChange({ value: next })}
          className="max-w-xs"
        />
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
            'shrink-0 truncate font-mono text-[11px] leading-6',
            set ? 'text-neutral-200' : 'text-neutral-500',
          )}
          title={spec.key}
        >
          {label}
        </span>
        <span className="shrink-0 pt-0.5 text-[11px] leading-6 text-neutral-600">=</span>
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
          {set && !managed && defaultOfSpec(spec) !== undefined && (
            <button
              onClick={() => onChange({ value: defaultOfSpec(spec) })}
              className="rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200"
              title={t('cfg.resetDefault')}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
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

/** map / 数组的外壳：折起来只露条数，展开才是逐项编辑器。 */
function ShapedField({ count, label, children }: { count: number; label: string; children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(count <= 3);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
        title={t('cfg.shapedToggle')}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-mono">{label}</span>
        <span className="text-neutral-600">{t('cfg.entryCount', { count })}</span>
      </button>
      {open && <div className="mt-1 space-y-1">{children}</div>}
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
 * 一条一行、对象字段缩进成子树。草稿留在本地，键还没写完也不会掉行。
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
  const scalarSpec = valueSpecOf(spec);
  return (
    <div className="space-y-0.5">
      {rows.map((row, i) => (
        <EntryNode
          key={i}
          label={row.key}
          labelEditable
          onLabelChange={(next) => patch(i, row.value, next)}
          value={row.value}
          fields={fields}
          scalarSpec={scalarSpec}
          onValueChange={(next) => patch(i, next)}
          onReset={() => patch(i, fields.length > 0 ? {} : emptyItemOf(scalarSpec))}
          onRemove={() => commit(rows.filter((_, j) => j !== i))}
        />
      ))}
      <AddButton
        onClick={() =>
          commit([...rows, { key: '', value: fields.length > 0 ? {} : emptyItemOf(scalarSpec) }])
        }
      />
    </div>
  );
}

/** 数组：一项一行，对象元素展开成缩进子树。 */
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
    <div className="space-y-0.5">
      {rows.map((item, i) => {
        const lock = locked.includes(String(item));
        return (
          <EntryNode
            key={i}
            label={`#${i + 1}`}
            labelEditable={false}
            value={item}
            fields={fields}
            scalarSpec={valueSpecOf(spec)}
            onValueChange={(next) => commit(rows.map((row, j) => (j === i ? next : row)))}
            onReset={() => commit(rows.map((row, j) => (j === i ? emptyItemOf(spec) : row)))}
            onRemove={() => commit(rows.filter((_, j) => j !== i))}
            locked={lock}
          />
        );
      })}
      <AddButton onClick={() => commit([...rows, emptyItemOf(spec)])} />
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

/** 词表里的默认值（生成物是 JSON 串；解析不了就按原文）。 */
function defaultOfSpec(spec: TreeNodeSpec): unknown {
  if (!spec.default) return undefined;
  try {
    return JSON.parse(spec.default) as unknown;
  } catch {
    return spec.default;
  }
}

function isPlainObjectValue(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 值要不要按子树展开：对象一律展开；数组只有元素是对象时才展开（标量数组仍是多行框）。 */
function containerOf(
  value: unknown,
  fields?: readonly ConfigFieldSpec[],
): { kind: 'object' | 'array'; count: number } | null {
  if (isPlainObjectValue(value)) {
    return { kind: 'object', count: Math.max(fields?.length ?? 0, Object.keys(value).length) };
  }
  if (Array.isArray(value) && value.some(isPlainObjectValue)) {
    return { kind: 'array', count: value.length };
  }
  return null;
}

/** 对象的一个子行：词表给了字段表就按它排，剩下的实际键接在后面（键名可改）。 */
interface ObjectChild {
  name: string;
  free: boolean;
  value: unknown;
  spec: TreeNodeSpec;
}

function objectChildrenOf(obj: unknown, fields?: readonly ConfigFieldSpec[]): ObjectChild[] {
  const source = isPlainObjectValue(obj) ? obj : {};
  const out: ObjectChild[] = [];
  const seen = new Set<string>();
  for (const f of fields ?? []) {
    seen.add(f.name);
    out.push({
      name: f.name,
      free: false,
      value: source[f.name],
      spec: { key: f.name, group: '', description: f.description ?? '', type: f.type, options: f.options },
    });
  }
  for (const [k, v] of Object.entries(source)) {
    if (seen.has(k)) continue;
    out.push({ name: k, free: true, value: v, spec: specOfValue(k, v) });
  }
  return out;
}

/** 没有词表字段的自由值：按运行期类型挑控件。 */
function specOfValue(key: string, value: unknown): TreeNodeSpec {
  const type =
    typeof value === 'boolean'
      ? 'Boolean'
      : typeof value === 'number'
        ? 'Number'
        : Array.isArray(value)
          ? 'Array of String'
          : 'String';
  return { key, group: '', description: '', type };
}

function withObjectKey(obj: unknown, key: string, next: unknown): Record<string, unknown> {
  const base = isPlainObjectValue(obj) ? obj : {};
  const out = { ...base };
  if (next === undefined) delete out[key];
  else out[key] = next;
  return out;
}

function renameObjectKey(obj: unknown, from: string, to: string): Record<string, unknown> {
  if (from === to) return isPlainObjectValue(obj) ? obj : {};
  const base = isPlainObjectValue(obj) ? obj : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) out[k === from ? to : k] = v;
  return out;
}

function withArrayItem(list: unknown, index: number, next: unknown): unknown[] {
  return (Array.isArray(list) ? list : []).map((item, i) => (i === index ? next : item));
}

function withoutArrayItem(list: unknown, index: number): unknown[] {
  return (Array.isArray(list) ? list : []).filter((_, i) => i !== index);
}

/**
 * 一条条目（map 的一行 / 数组的一项）：行 = 箭头 + 名称 + `=` + 控件 + ↻ + 🗑。
 * 名称不再独占一列，值是对象就展开成缩进子树——整棵按树读，没有对齐的两列。
 */
function EntryNode({
  label,
  labelEditable,
  onLabelChange,
  value,
  fields,
  scalarSpec,
  onValueChange,
  onReset,
  onRemove,
  locked,
}: {
  label: string;
  /** map 的键名可以改；数组项只是序号。 */
  labelEditable: boolean;
  onLabelChange?: (next: string) => void;
  value: unknown;
  fields: readonly ConfigFieldSpec[];
  scalarSpec: TreeNodeSpec;
  onValueChange: (next: unknown) => void;
  onReset: () => void;
  onRemove: () => void;
  locked?: boolean;
}) {
  const t = useT();
  const container = containerOf(value, fields);
  const children = container?.kind === 'object' ? objectChildrenOf(value, fields) : null;
  const count = children?.length ?? container?.count ?? 0;
  const [open, setOpen] = useState(count <= 6);
  return (
    <div>
      <div className="flex items-start gap-1.5 rounded-md px-1 py-0.5 hover:bg-neutral-800/20">
        {container ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1 shrink-0 rounded p-0.5 text-neutral-600 hover:text-neutral-300"
            title={t('cfg.shapedToggle')}
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        {labelEditable ? (
          <input
            value={label}
            onChange={(e) => onLabelChange?.(e.target.value)}
            placeholder={t('cfg.mapKey')}
            className={cn(INPUT_CLS, 'max-w-[180px] font-mono')}
          />
        ) : (
          <span className="shrink-0 truncate font-mono text-[11px] leading-6 text-neutral-500">{label}</span>
        )}
        {container ? (
          !open && (
            <span className="pt-1 text-[10px] text-neutral-600">
              {t('cfg.entryCount', { count })}
            </span>
          )
        ) : (
          <>
            <span className="shrink-0 pt-1 text-[11px] text-neutral-600">=</span>
            <div className="min-w-0 flex-1">
              {locked ? (
                <span className="block truncate font-mono text-[11px] leading-6 text-neutral-400">
                  {textOf(value)}
                </span>
              ) : (
                <PlainControl spec={scalarSpec} value={value} onChange={onValueChange} compact />
              )}
            </div>
          </>
        )}
        <div className="flex shrink-0 items-center gap-0.5 pt-1">
          {locked ? (
            <span className="text-neutral-500" title={t('cfg.managedEntry')}>
              <Lock className="h-3 w-3" />
            </span>
          ) : (
            <>
              <button
                type="button"
                onClick={onReset}
                className="rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200"
                title={t('cfg.resetRow')}
              >
                <RotateCcw className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={onRemove}
                className="rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-red-300"
                title={t('cfg.clear')}
              >
                <X className="h-3 w-3" />
              </button>
            </>
          )}
        </div>
      </div>
      {container && open && (
        <div style={{ paddingLeft: TREE_INDENT }} className="space-y-0.5 pb-0.5">
          {children
            ? children.map((child) => (
                <ValueNode
                  key={child.name}
                  name={child.name}
                  nameEditable={child.free}
                  value={child.value}
                  spec={child.spec}
                  onChange={(next) => onValueChange(withObjectKey(value, child.name, next))}
                  onRename={
                    child.free ? (next) => onValueChange(renameObjectKey(value, child.name, next)) : undefined
                  }
                  onRemove={() => onValueChange(withObjectKey(value, child.name, undefined))}
                />
              ))
            : arrayItemsOf(value).map((item, i) => (
                <ValueNode
                  key={i}
                  name={`#${i + 1}`}
                  value={item}
                  spec={specOfValue('', item)}
                  onChange={(next) => onValueChange(withArrayItem(value, i, next))}
                  onRemove={() => onValueChange(withoutArrayItem(value, i))}
                />
              ))}
        </div>
      )}
    </div>
  );
}

/**
 * 子树里的一个值节点：标量 = `名称 = [控件]`；对象/对象数组 = 可展开节点，
 * 递归下去（不再有 JSON 框，也没有对齐的名称列）。自由键的键名可直接改。
 */
function ValueNode({
  name,
  nameEditable,
  value,
  spec,
  onChange,
  onRename,
  onRemove,
}: {
  name: string;
  nameEditable?: boolean;
  value: unknown;
  spec: TreeNodeSpec;
  onChange: (next: unknown) => void;
  onRename?: (next: string) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const container = containerOf(value);
  const children = container?.kind === 'object' ? objectChildrenOf(value) : null;
  const count = children?.length ?? container?.count ?? 0;
  const [open, setOpen] = useState(count <= 6);
  const canAdd = !!container && (container.kind === 'array' || !children?.some((c) => !c.free));
  const addChild = (): void => {
    if (!container) return;
    if (container.kind === 'array') {
      onChange([...(Array.isArray(value) ? value : []), {}]);
      return;
    }
    const base = isPlainObjectValue(value) ? value : {};
    let next = 'new_key';
    let i = 2;
    while (next in base) next = `new_key_${i++}`;
    onChange({ ...base, [next]: '' });
  };
  return (
    <div>
      <div className="flex items-start gap-1.5 rounded px-1 py-0.5 hover:bg-neutral-800/20">
        {container ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1 shrink-0 rounded p-0.5 text-neutral-600 hover:text-neutral-300"
            title={t('cfg.shapedToggle')}
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        {nameEditable ? (
          <input
            value={name}
            onChange={(e) => onRename?.(e.target.value)}
            placeholder={t('cfg.mapKey')}
            className={cn(INPUT_CLS, 'max-w-[160px] font-mono')}
          />
        ) : (
          <span
            className="shrink-0 truncate font-mono text-[10px] leading-6 text-neutral-500"
            title={spec.description || name}
          >
            {name}
          </span>
        )}
        {container ? (
          !open && (
            <span className="pt-1 text-[10px] text-neutral-600">
              {t('cfg.entryCount', { count })}
            </span>
          )
        ) : (
          <>
            <span className="shrink-0 pt-1 text-[11px] text-neutral-600">=</span>
            <div className="min-w-0 flex-1">
              <PlainControl spec={spec} value={value} onChange={onChange} compact />
            </div>
          </>
        )}
        <div className="flex shrink-0 items-center gap-0.5 pt-1">
          {canAdd && (
            <button
              type="button"
              onClick={addChild}
              className="rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200"
              title={t('cfg.addEntry')}
            >
              <Plus className="h-3 w-3" />
            </button>
          )}
          {container && (
            <button
              type="button"
              onClick={() => onChange(container.kind === 'array' ? [] : {})}
              className="rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200"
              title={t('cfg.resetRow')}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-red-300"
            title={t('cfg.clear')}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      {container && open && (
        <div style={{ paddingLeft: TREE_INDENT }} className="space-y-0.5 pb-0.5">
          {children
            ? children.map((child) => (
                <ValueNode
                  key={child.name}
                  name={child.name}
                  nameEditable={child.free}
                  value={child.value}
                  spec={child.spec}
                  onChange={(next) => onChange(withObjectKey(value, child.name, next))}
                  onRename={
                    child.free ? (next) => onChange(renameObjectKey(value, child.name, next)) : undefined
                  }
                  onRemove={() => onChange(withObjectKey(value, child.name, undefined))}
                />
              ))
            : arrayItemsOf(value).map((item, i) => (
                <ValueNode
                  key={i}
                  name={`#${i + 1}`}
                  value={item}
                  spec={specOfValue('', item)}
                  onChange={(next) => onChange(withArrayItem(value, i, next))}
                  onRemove={() => onChange(withoutArrayItem(value, i))}
                />
              ))}
        </div>
      )}
    </div>
  );
}

/** 「添加一项」按钮（map / 数组共用）。 */
function AddButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-dashed border-edge/[0.14] px-2 py-0.5 text-[11px] text-neutral-400 hover:border-edge/[0.3] hover:text-neutral-200"
    >
      <Plus className="h-3 w-3" />
      {t('cfg.addEntry')}
    </button>
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
  const control = controlOf(spec.type, spec.options);
  if (control === 'switch') return <Switch checked={boolOf(value)} title={spec.key} onChange={onChange} />;
  if (control === 'select') {
    const options = [...(spec.options ?? [])];
    const current = typeof value === 'string' ? value : textOf(value);
    if (current && !options.includes(current)) options.push(current);
    return (
      <Combobox
        value={current}
        options={options.map((opt) => ({ value: opt }))}
        onChange={(next) => onChange(next === '' ? undefined : next)}
        className={compact ? 'w-28' : 'max-w-xs'}
      />
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
  if (control === 'object') {
    return <JsonField key={JSON.stringify(value)} value={value} onCommit={onChange} />;
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
