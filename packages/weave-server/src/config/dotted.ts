/** 配置表单的一次改动：`path` 是点号路径（`sandbox.filesystem.allowWrite`）。 */
export interface ConfigUpdate {
  path: string;
  value?: unknown;
  remove?: boolean;
}

function dangerous(seg: string): boolean {
  return seg === '__proto__' || seg === 'constructor' || seg === 'prototype';
}

function segmentsOf(dotted: string): string[] {
  const segs = dotted.split('.');
  if (segs.some((s) => !s || dangerous(s))) throw new Error(`非法配置键：${dotted}`);
  return segs;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ABSENT = Symbol('absent');

function read(root: Record<string, unknown>, segs: string[]): unknown {
  let cur: unknown = root;
  for (const seg of segs) {
    if (!isPlainObject(cur)) return ABSENT;
    cur = cur[seg];
  }
  return cur === undefined ? ABSENT : cur;
}

function remove(root: Record<string, unknown>, segs: string[]): void {
  let cur: Record<string, unknown> = root;
  for (const seg of segs.slice(0, -1)) {
    const next = cur[seg];
    if (!isPlainObject(next)) return;
    cur = next;
  }
  delete cur[segs[segs.length - 1]];
}

function assign(root: Record<string, unknown>, segs: string[], value: unknown): void {
  let cur: Record<string, unknown> = root;
  for (const seg of segs.slice(0, -1)) {
    if (!isPlainObject(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

/** 点号路径取值（不存在 → undefined）。 */
export function getDotted(root: Record<string, unknown>, dotted: string): unknown {
  const got = read(root, segmentsOf(dotted));
  return got === ABSENT ? undefined : got;
}

/** 批量落值/删键，返回新对象（不改入参）。 */
export function applyUpdates(
  root: Record<string, unknown>,
  updates: readonly ConfigUpdate[],
): Record<string, unknown> {
  const next = structuredClone(root);
  for (const update of updates) {
    const segs = segmentsOf(update.path);
    if (update.remove) remove(next, segs);
    else assign(next, segs, update.value);
  }
  return next;
}
