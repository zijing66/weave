/**
 * 配置表单的纯函数层：词表条目 → 控件种类、点号路径 ↔ 取值、数组/数字的文本往返。
 * 不含 React，便于直接测。
 */

/** 一条键在表单里该摆什么控件。 */
export type ConfigControl = 'switch' | 'select' | 'number' | 'list' | 'object' | 'text';

const NUMERIC = /\b(number|integer)\b/i;
const LISTY = /\b(array|list)\b|\[\]/i;

export function controlOf(type: string, options?: readonly string[]): ConfigControl {
  if (/^\s*Boolean\b/i.test(type)) return 'switch';
  if (options && options.length > 0) return 'select';
  if (NUMERIC.test(type)) return 'number';
  if (LISTY.test(type)) return 'list';
  if (/\bobject\b/i.test(type)) return 'object';
  return 'text';
}

/** 点号路径取值（不存在 → undefined）。 */
export function valueAt(values: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = values;
  for (const seg of dotted.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 数组/对象在文本控件里的初值。 */
export function textOf(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

/** 文本 → 值：能 JSON 解析就按 JSON（数组/对象/数字），否则当原样字符串（空串 = 未设置）。 */
export function valueOfText(text: string): { value: unknown; remove?: boolean; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { value: undefined, remove: true };
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return { value: JSON.parse(trimmed) };
    } catch {
      return { value: undefined, error: 'invalidJson' };
    }
  }
  return { value: text };
}

/** 开关的值：缺省 = 未设置；已设置按真值判（`"true"` 也算真）。 */
export function boolOf(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * 未设置的键按类型给一个「打开开关时写进去」的值——
 * 尽量写宿主认的默认形，而不是空串。
 */
export function defaultValueOf(type: string, options?: readonly string[]): unknown {
  if (/^\s*Boolean\b/i.test(type)) return true;
  if (options && options.length > 0) return options[0];
  if (NUMERIC.test(type)) return 0;
  if (LISTY.test(type)) return [];
  if (/\bobject\b/i.test(type)) return {};
  return '';
}

/** 一个键在树里最小需要的信息（词表条目或为 env 变量现拼的条目）。 */
export interface TreeNodeSpec {
  key: string;
  type: string;
  group: string;
  description: string;
  options?: readonly string[];
  default?: string;
  deprecated?: boolean;
  shape?: 'map' | 'array';
  fields?: readonly ConfigFieldSpec[];
  valueType?: string;
  valueOptions?: readonly string[];
}

export interface ConfigFieldSpec {
  name: string;
  type: string;
  options?: readonly string[];
  description?: string;
}

/** 值的容器形状：有 map/array 或字段时，控件换成逐项编辑而不是一段 JSON。 */
export function shapeOf(spec: TreeNodeSpec): 'map' | 'array' | null {
  if (spec.shape === 'map' || spec.shape === 'array') return spec.shape;
  return null;
}

/** map 值 → 有序条目（非对象给空表；调用方据此判「还没设置」）。 */
export function mapEntriesOf(value: unknown): Array<{ key: string; value: unknown }> {
  if (!isPlainObject(value)) return [];
  return Object.entries(value).map(([key, v]) => ({ key, value: v }));
}

/** 有序条目 → map 值（键名重复时后写的覆盖先写的，交给服务端按普通 JSON 处理）。 */
export function mapOfEntries(entries: readonly { key: string; value: unknown }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (key) out[key] = entry.value;
  }
  return out;
}

/** array 值 → 元素表（非数组给空表）。 */
export function arrayItemsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 元素 → 字段对象（标量元素在带字段的数组里包一层空对象）。 */
export function itemObjectOf(item: unknown): Record<string, unknown> {
  return isPlainObject(item) ? item : {};
}

/** 一个字段值的控件初值（缺省 = 空串/关，写进去时才落默认值）。 */
export function fieldValueOf(item: unknown, field: ConfigFieldSpec): unknown {
  return itemObjectOf(item)[field.name];
}

/** 改一个字段 → 新的元素值；字段清空即从元素里删掉这个键。 */
export function withFieldValue(item: unknown, field: ConfigFieldSpec, value: unknown): Record<string, unknown> {
  const next = { ...itemObjectOf(item) };
  if (value === undefined) delete next[field.name];
  else next[field.name] = value;
  return next;
}

/** 新加一个元素（数组）/条目（map）：有字段表起手空对象，标量按值类型给默认。 */
export function emptyItemOf(spec: TreeNodeSpec): unknown {
  return spec.fields && spec.fields.length > 0 ? {} : defaultValueOf(spec.valueType ?? 'string', spec.valueOptions);
}

/** 配置树的一个节点：段名 + 完整点号路径；有 spec 的是词表里的键，`extra` 的是文件里多出来的。 */
export interface ConfigTreeNode {
  segment: string;
  path: string;
  spec?: TreeNodeSpec;
  extra?: boolean;
  children: ConfigTreeNode[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 词表 + 文件实际值 → 树。
 *
 * 顺序先按文件里出现的键（JSON 原文顺序），词表独有的键再接在后面；同层的父节点被两条
 * 路合并（文件里 `sandbox.enabled` 与词表 `sandbox` 落到同一个 `sandbox` 节点）。
 * 对象只在「词表在它下面还有键」或「词表根本没收它」时展开：`hooks` 这类整体就是一张
 * JSON 的键不拆开，数组一律当叶子。
 */
export function buildConfigTree(
  keys: readonly TreeNodeSpec[],
  values: Record<string, unknown>,
): ConfigTreeNode[] {
  const byPath = new Map<string, ConfigTreeNode>();
  const roots: ConfigTreeNode[] = [];
  const descendants = new Set<string>();
  for (const spec of keys) {
    const segs = spec.key.split('.');
    for (let i = 1; i < segs.length; i++) descendants.add(segs.slice(0, i).join('.'));
  }
  const specOf = new Map(keys.map((s) => [s.key, s]));

  const ensure = (segs: string[]): ConfigTreeNode => {
    let list = roots;
    let node: ConfigTreeNode | undefined;
    let path = '';
    for (const seg of segs) {
      path = path ? `${path}.${seg}` : seg;
      let next = byPath.get(path);
      if (!next) {
        next = { segment: seg, path, children: [] };
        byPath.set(path, next);
        list.push(next);
      }
      node = next;
      list = next.children;
    }
    return node as ConfigTreeNode;
  };

  const walkValues = (object: Record<string, unknown>, prefix: string): void => {
    for (const [seg, value] of Object.entries(object)) {
      const path = prefix ? `${prefix}.${seg}` : seg;
      const node = ensure(path.split('.'));
      if (specOf.has(path)) node.spec = specOf.get(path);
      else node.extra = true;
      const expand = isPlainObject(value) && (!specOf.has(path) || descendants.has(path));
      if (expand) walkValues(value as Record<string, unknown>, path);
    }
  };
  walkValues(values, '');

  for (const spec of keys) {
    const node = ensure(spec.key.split('.'));
    node.spec = spec;
    node.extra = false;
  }
  return roots;
}

/** 树上有没有已配置的值（决定默认展不展开）。 */
export function treeHasValue(node: ConfigTreeNode, hasValue: (path: string) => boolean): boolean {
  if (node.children.length === 0) return hasValue(node.path);
  return node.children.some((child) => treeHasValue(child, hasValue));
}

/** 按叶子判据剪枝：留下的叶子连同祖先，一个叶子都不剩的分支整枝去掉。 */
export function pruneTree(
  nodes: readonly ConfigTreeNode[],
  keepLeaf: (node: ConfigTreeNode) => boolean,
): ConfigTreeNode[] {
  const out: ConfigTreeNode[] = [];
  for (const node of nodes) {
    if (node.children.length === 0) {
      if (keepLeaf(node)) out.push(node);
      continue;
    }
    const children = pruneTree(node.children, keepLeaf);
    if (children.length > 0) out.push({ ...node, children });
  }
  return out;
}

/** 搜索：键名或说明里含关键词即命中（大小写不敏感）。 */
export function matchesQuery(key: string, description: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return key.toLowerCase().includes(q) || description.toLowerCase().includes(q);
}

/** 数组控件的文本形（每行一项）。 */
export function linesOf(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
  return typeof value === 'string' ? value : '';
}

export function listOfLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 表单草稿的一次改动：落值或删键（与服务端 ConfigUpdate 同形）。 */
export interface DraftEdit {
  value?: unknown;
  remove?: boolean;
}

/** 草稿的一次改动 → 新草稿（深拷贝后沿点号路径落值/删键，不改入参）。 */
export function withEdit(
  root: Record<string, unknown>,
  dotted: string,
  edit: DraftEdit,
): Record<string, unknown> {
  const next = structuredClone(root);
  const segs = dotted.split('.').filter(Boolean);
  if (segs.length === 0) return next;
  let cur = next as Record<string, unknown>;
  for (const seg of segs.slice(0, -1)) {
    if (typeof cur[seg] !== 'object' || cur[seg] === null || Array.isArray(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  const last = segs[segs.length - 1];
  if (edit.remove || edit.value === undefined) delete cur[last];
  else cur[last] = edit.value;
  return next;
}
