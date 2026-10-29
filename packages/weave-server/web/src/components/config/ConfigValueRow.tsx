import { useState } from 'react';
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
  'max-w-full rounded-md bg-neutral-900 border border-edge/[0.08] px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-mac-accent/50';

/** 表单的一次改动：落值或删键。 */
export interface RowEdit {
  value?: unknown;
  remove?: boolean;
}

/**
 * 树里的一片叶子/容器：行 = 箭头 + 键名 +（= 控件｜收起时的条数）+ 行尾动作，
 * 全部左聚、控件按内容出宽——标签和输入框一起构成树节点，没有对齐的两列。
 * map / 对象数组的值升格为容器节点，孩子缩进递归。
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
  const set = value !== undefined;
  const shape = shapeOf(spec);
  const container = set && !managed ? containerOf(value) : null;
  const [open, setOpen] = useState((container?.count ?? 99) <= 3);
  const [descOpen, setDescOpen] = useState(false);

  const write = (): void => {
    const empty = shape === 'map' ? {} : shape === 'array' ? [] : defaultValueOf(spec.type, spec.options);
    setOpen(true);
    onChange({ value: empty });
  };

  const addObjectKey = (): void => {
    setOpen(true);
    const base = isPlainObjectValue(value) ? value : {};
    let key = 'new_key';
    let i = 2;
    while (key in base) key = `new_key_${i++}`;
    onChange({ value: { ...base, [key]: emptyItemOf(spec) } });
  };

  const addArrayItem = (): void => {
    setOpen(true);
    onChange({ value: [...arrayItemsOf(value), emptyItemOf(spec)] });
  };

  const scalar = (() => {
    if (managed) {
      return (
        <span className="flex items-center gap-1.5 text-11 text-neutral-500" title={t('cfg.managedHint')}>
          <Lock className="h-3 w-3" />
          {t('cfg.managed')}
        </span>
      );
    }
    if (controlOf(spec.type, spec.options) === 'switch') {
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
          onClick={write}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-edge/[0.14] px-2 py-0.5 text-11 text-neutral-400 hover:text-neutral-200 hover:border-edge/[0.3]"
        >
          <Plus className="h-3 w-3" />
          {t('cfg.write')}
        </button>
      );
    }
    const control = controlOf(spec.type, spec.valueOptions ?? spec.options);
    if (control === 'select') {
      const options = [...(spec.valueOptions ?? spec.options ?? [])];
      const current = typeof value === 'string' ? value : textOf(value);
      if (current && !options.includes(current)) options.push(current);
      return (
        <Combobox
          value={current}
          options={options.map((opt) => ({ value: opt }))}
          onChange={(next) => onChange({ value: next })}
          className="w-40"
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
          className={cn(INPUT_CLS, 'w-24')}
        />
      );
    }
    if (control === 'list') {
      const text = linesOf(value);
      return (
        <textarea
          value={text}
          rows={Math.min(6, Math.max(2, text.split('\n').length))}
          onChange={(e) => onChange({ value: listOfLines(e.target.value) })}
          className={cn(INPUT_CLS, 'w-64 font-mono')}
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
        className={cn(INPUT_CLS, 'w-56')}
      />
    );
  })();

  return (
    <div style={{ paddingLeft: depth * TREE_INDENT }} className="group">
      <div className="flex items-start gap-1.5 rounded-md px-1 py-1 hover:bg-neutral-800/30">
        <span className="flex w-4 shrink-0 justify-center">
          {container ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mt-1 rounded p-0.5 text-neutral-600 hover:text-neutral-300"
              title={t('cfg.shapedToggle')}
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          ) : null}
        </span>
        <span
          className={cn(
            'shrink-0 truncate font-mono text-11 leading-6',
            set ? 'text-neutral-200' : 'text-neutral-500',
          )}
          title={spec.key}
        >
          {label}
        </span>
        {container ? (
          !open && (
            <>
              <span className="pt-1 text-10 text-neutral-600">{t('cfg.entryCount', { count: container.count })}</span>
              {spec.group && <span className="truncate pt-1 text-10 text-neutral-700">{spec.group}</span>}
            </>
          )
        ) : (
          <>
            <span className="shrink-0 pt-1 text-11 text-neutral-600">=</span>
            <div className="min-w-0">{scalar}</div>
          </>
        )}
        <div className="flex shrink-0 items-center gap-0.5 pt-1">
          {container && !managed && (
            <button
              type="button"
              onClick={container.kind === 'object' ? addObjectKey : addArrayItem}
              className="rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200"
              title={t('cfg.addEntry')}
            >
              <Plus className="h-3 w-3" />
            </button>
          )}
          {spec.deprecated && (
            <span className="rounded bg-red-500/10 px-1 py-0.5 text-10 text-red-300">{t('cfg.deprecated')}</span>
          )}
          <button
            type="button"
            onClick={() => setDescOpen((v) => !v)}
            className="rounded p-0.5 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300"
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

      {descOpen && (
        <p style={{ paddingLeft: TREE_INDENT }} className="pb-1 pr-2 text-11 leading-relaxed text-neutral-500">
          {spec.description}
          <span className="ml-1 text-neutral-600">{spec.group}</span>
          {spec.default && (
            <span className="ml-1 text-neutral-600">{t('cfg.defaultValue', { value: spec.default })}</span>
          )}
        </p>
      )}

      {container && open && (
        <div style={{ paddingLeft: TREE_INDENT }} className="space-y-0.5 pb-0.5">
          {container.kind === 'object'
            ? mapEntriesOf(value).map((row, i) => (
                <ValueNode
                  key={i}
                  name={row.key}
                  nameEditable
                  value={row.value}
                  spec={childSpecOf(spec, row.key, row.value)}
                  onChange={(next) => onChange({ value: withObjectKey(value, row.key, next) })}
                  onRename={(next) => onChange({ value: renameObjectKey(value, row.key, next) })}
                  onRemove={() => onChange({ value: withObjectKey(value, row.key, undefined) })}
                />
              ))
            : arrayItemsOf(value).map((item, i) => (
                <ValueNode
                  key={i}
                  name={`#${i + 1}`}
                  value={item}
                  spec={childSpecOf(spec, '', item)}
                  onChange={(next) => onChange({ value: withArrayItem(value, i, next) })}
                  onRemove={() => onChange({ value: withoutArrayItem(value, i) })}
                  locked={locked?.includes(String(item))}
                />
              ))}
          {!managed &&
            (container.kind === 'object' ? (
              <AddButton onClick={addObjectKey} />
            ) : (
              <AddButton onClick={addArrayItem} />
            ))}
        </div>
      )}
    </div>
  );
}

/** 值要不要按子树展开：对象一律展开；数组只有元素是对象时才展开（标量数组仍是多行框）。 */
function containerOf(value: unknown): { kind: 'object' | 'array'; count: number } | null {
  if (isPlainObjectValue(value)) {
    return { kind: 'object', count: Object.keys(value).length };
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
    out.push({ name: k, free: true, value: v, spec: childSpecOf(undefined, k, v) });
  }
  return out;
}

/**
 * 子值的 spec：运行期类型打底，词表的值形状（valueType/valueOptions/fields）盖上去——
 * map 条目和数组元素继承父键声明的「每项长什么样」。
 */
function childSpecOf(base: TreeNodeSpec | undefined, key: string, value: unknown): TreeNodeSpec {
  const runtime =
    typeof value === 'boolean'
      ? 'Boolean'
      : typeof value === 'number'
        ? 'Number'
        : Array.isArray(value)
          ? 'Array of String'
          : 'String';
  return {
    key,
    group: '',
    description: '',
    type: base?.valueType ?? runtime,
    options: base?.valueOptions,
    fields: base?.fields,
  };
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

function isPlainObjectValue(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
  locked,
}: {
  name: string;
  nameEditable?: boolean;
  value: unknown;
  spec: TreeNodeSpec;
  onChange: (next: unknown) => void;
  onRename?: (next: string) => void;
  onRemove: () => void;
  locked?: boolean;
}) {
  const t = useT();
  const container = locked ? null : containerOf(value);
  const children = container?.kind === 'object' ? objectChildrenOf(value, spec.fields) : null;
  const count = children?.length ?? container?.count ?? 0;
  const [open, setOpen] = useState(count <= 6);
  const addChild = (): void => {
    if (!container) return;
    setOpen(true);
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
      <div className="flex items-start gap-1.5 rounded px-1 py-1 hover:bg-neutral-800/30">
        <span className="flex w-4 shrink-0 justify-center">
          {container ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mt-1 rounded p-0.5 text-neutral-600 hover:text-neutral-300"
              title={t('cfg.shapedToggle')}
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          ) : null}
        </span>
        {nameEditable ? (
          <input
            value={name}
            onChange={(e) => onRename?.(e.target.value)}
            placeholder={t('cfg.mapKey')}
            className={cn(INPUT_CLS, 'w-40 font-mono')}
          />
        ) : (
          <span
            className="shrink-0 truncate font-mono text-11 leading-6 text-neutral-500"
            title={spec.description || name}
          >
            {name}
          </span>
        )}
        {container ? (
          !open && <span className="pt-1 text-10 text-neutral-600">{t('cfg.entryCount', { count })}</span>
        ) : (
          <>
            <span className="shrink-0 pt-1 text-11 text-neutral-600">=</span>
            <div className="min-w-0">
              {locked ? (
                <span className="block truncate font-mono text-11 leading-6 text-neutral-400">{textOf(value)}</span>
              ) : (
                <PlainControl spec={spec} value={value} onChange={onChange} />
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
              {container && (
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
            </>
          )}
        </div>
      </div>
      {container && open && (
        <div style={{ paddingLeft: TREE_INDENT }} className="space-y-0.5 pb-0.5">
          {children
            ? children.map((child, i) => (
                <ValueNode
                  key={i}
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
                  spec={childSpecOf(undefined, '', item)}
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
      className="inline-flex items-center gap-1 rounded-md border border-dashed border-edge/[0.14] px-2 py-0.5 text-11 text-neutral-400 hover:border-edge/[0.3] hover:text-neutral-200"
    >
      <Plus className="h-3 w-3" />
      {t('cfg.addEntry')}
    </button>
  );
}

/** 按类型出一个控件，宽度按内容（子树里的值通常短）。 */
function PlainControl({
  spec,
  value,
  onChange,
}: {
  spec: TreeNodeSpec;
  value: unknown;
  onChange: (next: unknown) => void;
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
        className="w-28"
      />
    );
  }
  if (control === 'number') {
    return (
      <input
        type="number"
        value={typeof value === 'number' ? value : textOf(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className={cn(INPUT_CLS, 'w-24')}
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
        className={cn(INPUT_CLS, 'w-40 font-mono')}
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
      className={cn(INPUT_CLS, 'w-40')}
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
          if (parsed.error === 'invalidJson') return;
          if (parsed.remove) return;
          onCommit(parsed.value);
        }}
        className={cn(INPUT_CLS, 'w-72 font-mono')}
      />
      {parsed.error === 'invalidJson' && <p className="mt-0.5 text-10 text-red-400">{t('cfg.invalidJson')}</p>}
    </div>
  );
}
