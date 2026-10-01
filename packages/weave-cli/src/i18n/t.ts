import type { Dict, MessageKey } from './dict/index.js';

/** Interpolation values for `{name}` placeholders. */
export type Params = Record<string, string | number>;

/** Replace `{name}` placeholders; unknown placeholders stay verbatim so a
 * missing param shows up visibly instead of rendering "undefined". */
export function interpolate(s: string, p?: Params): string {
  if (!p) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m));
}

/** Build a translator bound to a locale dictionary, falling back to the
 * default locale and finally to the key itself (never throws). */
export function makeT(dict: Dict, fallback: Dict) {
  return (key: MessageKey, p?: Params): string =>
    interpolate(dict[key] ?? fallback[key] ?? String(key), p);
}

export type TFunc = ReturnType<typeof makeT>;
