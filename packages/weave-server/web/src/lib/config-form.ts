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

/** 同组键按词表顺序排（服务端已按文档顺序下发，这里只做稳定分组）。 */
export function groupKeys<T extends { key: string; group: string }>(
  keys: readonly T[],
  groups: readonly string[],
): { group: string; keys: T[] }[] {
  return groups
    .map((group) => ({ group, keys: keys.filter((k) => k.group === group) }))
    .filter((g) => g.keys.length > 0);
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
