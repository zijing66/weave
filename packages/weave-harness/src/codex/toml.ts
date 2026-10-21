/**
 * Codex config.toml 的**纯文本层**——行级增量编辑器（保留注释与键序）。
 *
 * 从 weave-server/src/install/codex-toml.ts 迁入（P2 专属格式下沉）：
 * codex 的配置表示法是 harness 知识，不得散在 server。fs 侧包装
 * （config.toml 路径 / MCP 读写）暂留 server 的同名模块，经本模块原语实现。
 */
import { parse } from 'smol-toml';

/** config.toml exists but does not parse — refusing to write protects the user. */
export class CodexTomlCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexTomlCorruptError';
  }
}
// ---------------------------------------------------------------------------
// Low-level: dotted-key + header parsing / rendering
// ---------------------------------------------------------------------------

function isBareKeyChar(c: string): boolean {
  return /[A-Za-z0-9_-]/.test(c);
}

function isWs(c: string): boolean {
  return c === ' ' || c === '\t';
}

const BASIC_ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

/**
 * Parse a dotted key expression (`a.b.'c d'`, quoted parts allowed) into its
 * component strings. Basic-string escapes are decoded; literal (single-quoted)
 * parts are taken verbatim. Returns null when malformed.
 */
export function parseDottedKey(s: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    while (i < s.length && isWs(s[i]!)) i++;
    if (i >= s.length) return null;
    const c = s[i]!;
    if (c === '"' || c === "'") {
      i++;
      let val = '';
      while (i < s.length) {
        const ch = s[i]!;
        if (c === '"' && ch === '\\') {
          const esc = s[i + 1];
          if (esc === undefined || !(esc in BASIC_ESCAPES)) return null;
          val += BASIC_ESCAPES[esc]!;
          i += 2;
          continue;
        }
        if (ch === c) break;
        val += ch;
        i++;
      }
      if (i >= s.length) return null; // unterminated string
      i++; // closing quote
      parts.push(val);
    } else {
      const start = i;
      while (i < s.length && isBareKeyChar(s[i]!)) i++;
      if (i === start) return null;
      parts.push(s.slice(start, i));
    }
    while (i < s.length && isWs(s[i]!)) i++;
    if (i >= s.length) return parts;
    if (s[i] !== '.') return null;
    i++;
  }
}

/**
 * Parse a `[dotted.key]` / `[[dotted.key]]` header line into its key parts.
 * Returns null when the line is not a well-formed header (values, comments,
 * blank lines, continuation lines of multi-line arrays all yield null).
 */
export function sectionHeaderKey(line: string): string[] | null {
  const s = line.trim();
  if (!s.startsWith('[')) return null;
  const double = s.startsWith('[[');
  let i = double ? 2 : 1;
  let inner = '';
  let closed = false;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      // consume the quoted part verbatim (escape-aware for basic strings)
      const q = c;
      inner += q;
      i++;
      while (i < s.length) {
        if (q === '"' && s[i] === '\\') {
          if (i + 1 >= s.length) return null;
          inner += s[i]! + s[i + 1]!;
          i += 2;
          continue;
        }
        if (s[i] === q) break;
        inner += s[i]!;
        i++;
      }
      if (i >= s.length) return null; // unterminated string
      inner += q;
      i++;
      continue;
    }
    if (c === ']') {
      if (double) {
        if (s[i + 1] !== ']') return null;
        i += 2;
      } else {
        i++;
      }
      closed = true;
      break;
    }
    inner += c;
    i++;
  }
  if (!closed) return null;
  const rest = s.slice(i).trim();
  if (rest !== '' && !rest.startsWith('#')) return null;
  return parseDottedKey(inner);
}

/** Render a single key part — bare when possible, else a quoted basic string. */
export function renderTomlKey(part: string): string {
  return /^[A-Za-z0-9_-]+$/.test(part) ? part : `"${escapeBasicString(part)}"`;
}

/** Render a `[a.b]` section header. */
export function renderTomlHeader(keyPath: string[]): string {
  return `[${keyPath.map(renderTomlKey).join('.')}]`;
}

function escapeBasicString(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch < ' ' || ch === '\u007f') {
      out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    } else out += ch;
  }
  return out;
}

/**
 * Render a string as a TOML literal. Strings containing backslashes and no
 * single quote / control chars use a literal string (`'D:\path'`) — matching
 * Codex's own output for Windows paths — everything else a basic string.
 */
export function renderTomlString(s: string): string {
  const hasBackslash = s.includes('\\');
  const literalSafe = !s.includes("'") && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\n]/.test(s);
  if (hasBackslash && literalSafe) return `'${s}'`;
  return `"${escapeBasicString(s)}"`;
}

// ---------------------------------------------------------------------------
// Section-level editor (pure text in / text out)
// ---------------------------------------------------------------------------

export interface TomlSection {
  /** Dotted key path (quoted parts unquoted); null for the root segment that
   * precedes the first header. */
  key: string[] | null;
  /** Verbatim lines of this segment, the header line included. Blank lines
   * between sections belong to the section that precedes them. */
  lines: string[];
}

/** Split text into sections at header lines. The first segment (root, key
 * null) holds everything before the first header. Lines are kept verbatim. */
export function splitTomlSections(text: string): TomlSection[] {
  const lines = text.split('\n');
  const sections: TomlSection[] = [];
  let current: TomlSection = { key: null, lines: [] };
  for (const line of lines) {
    const key = sectionHeaderKey(line);
    if (key !== null) {
      sections.push(current);
      current = { key, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

export function sameKey(a: string[] | null, b: string[]): boolean {
  return a !== null && a.length === b.length && a.every((v, i) => v === b[i]!);
}

function isNestedUnder(a: string[] | null, prefix: string[]): boolean {
  return a !== null && a.length > prefix.length && prefix.every((v, i) => a[i] === v);
}

function trailingBlankCount(lines: string[]): number {
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() === '') n++;
    else break;
  }
  return n;
}

/** Trim trailing blank lines and end with exactly one newline ('' stays ''). */
function normalizeEof(text: string): string {
  const trimmed = text.replace(/(?:\r?\n)+[ \t]*$/, '');
  return trimmed === '' ? '' : `${trimmed}\n`;
}

/** Append a new section (header + body already joined in `lines`) at EOF,
 * separated by exactly one blank line from the existing content. */
function appendSection(text: string, lines: string[]): string {
  const base = text.replace(/(?:\r?\n)+[ \t]*$/, '');
  if (base.trim() === '') return `${lines.join('\n')}\n`;
  return `${base}\n\n${lines.join('\n')}\n`;
}

/**
 * Insert or replace the `[keyPath]` section (and drop its nested
 * `[keyPath.*]` sub-sections — the replacement body may re-declare them).
 * Unrelated sections, comments and key order are preserved byte-for-byte;
 * the blank-line separation the replaced span had to its successor is kept.
 */
export function upsertTomlSection(text: string, keyPath: string[], bodyLines: string[]): string {
  const sections = splitTomlSections(text);
  let firstExact = -1;
  let lastDropped = -1;
  const drop = new Set<number>();
  for (let i = 0; i < sections.length; i++) {
    const k = sections[i]!.key;
    if (sameKey(k, keyPath)) {
      if (firstExact < 0) firstExact = i;
      drop.add(i);
      lastDropped = i;
    } else if (isNestedUnder(k, keyPath)) {
      drop.add(i);
      lastDropped = i;
    }
  }
  if (firstExact < 0) {
    return appendSection(text, [renderTomlHeader(keyPath), ...bodyLines]);
  }
  // keep the blank lines that separated the dropped span from what follows
  const lastLines = sections[lastDropped]!.lines;
  const sep = lastLines.slice(lastLines.length - trailingBlankCount(lastLines));
  const replacement = [renderTomlHeader(keyPath), ...bodyLines, ...sep];
  const out: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    if (i === firstExact) out.push(...replacement);
    if (drop.has(i)) continue;
    out.push(...sections[i]!.lines);
  }
  return normalizeEof(out.join('\n'));
}

/** Remove the `[keyPath]` section and its nested sub-sections. Returns whether
 * anything was removed; text is returned unchanged when not. */
export function removeTomlSection(
  text: string,
  keyPath: string[],
): { text: string; removed: boolean } {
  const sections = splitTomlSections(text);
  const drop = new Set<number>();
  for (let i = 0; i < sections.length; i++) {
    const k = sections[i]!.key;
    if (sameKey(k, keyPath) || isNestedUnder(k, keyPath)) drop.add(i);
  }
  if (drop.size === 0) return { text, removed: false };
  const out: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    if (drop.has(i)) continue;
    out.push(...sections[i]!.lines);
  }
  return { text: normalizeEof(out.join('\n')), removed: true };
}

/**
 * Parse the `key = value` lines of one section body (header excluded) in file
 * order. Comments and blank lines are skipped. Returns [key, rawLine] pairs;
 * the raw line is preserved verbatim so unknown keys can be re-emitted.
 */
export function parseSectionEntries(lines: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('[')) continue;
    const m = /^("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(t);
    if (!m) continue;
    // parseDottedKey decodes quoted keys ("gpt-5.5") without splitting on dots
    const parsed = parseDottedKey(m[1]!);
    if (parsed === null || parsed.length !== 1) continue;
    out.push([parsed[0]!, line]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codex config.toml — plugin enable ([plugins."key"] enabled)
// ---------------------------------------------------------------------------

/** Insert or replace `[plugins."<key>"] enabled` in config.toml text,
 * preserving other keys in the section and the rest of the file. */
export function upsertCodexPluginEnabledInText(
  text: string,
  key: string,
  enabled: boolean,
): string {
  const keyPath = ['plugins', key];
  const sections = splitTomlSections(text);
  const old = sections.find((s) => sameKey(s.key, keyPath));
  const body: string[] = [`enabled = ${enabled ? 'true' : 'false'}`];
  if (old) {
    for (const [k, rawLine] of parseSectionEntries(old.lines.slice(1))) {
      if (k !== 'enabled') body.push(rawLine);
    }
  }
  return upsertTomlSection(text, keyPath, body);
}

// ---------------------------------------------------------------------------
// Generic dotted-path value editor (config surface: form writes / raw merge)
// ---------------------------------------------------------------------------

/** Render a JSON value as a TOML value literal. Objects become inline tables,
 * arrays inline arrays — the config surface only writes scalar/leaf values
 * through this path; big structures go through section upserts instead. */
export function renderTomlValue(value: unknown): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '""';
  if (typeof value === 'string') return renderTomlString(value);
  if (Array.isArray(value)) return `[${value.map(renderTomlValue).join(', ')}]`;
  const body = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${renderTomlKey(k)} = ${renderTomlValue(v)}`)
    .join(', ');
  return `{ ${body} }`;
}

/**
 * Set one dotted-path key in config.toml text, preserving comments, key order
 * and unrelated sections. `a.b.c = v` lands in the `[a.b]` section (created at
 * EOF when missing); a bare `key = v` lands in the root segment. An existing
 * inline value for the same path is replaced in place; intermediate tables
 * declared inline (`a = { b = 1 }`) are converted to section form when a
 * deeper path needs to grow. Returns whether anything changed.
 */
export function setTomlValueInText(
  text: string,
  path: readonly string[],
  value: unknown,
): string {
  if (path.length === 0) return text;
  const rendered = `${renderTomlKey(path[path.length - 1]!)} = ${renderTomlValue(value)}`;
  const parentPath = path.slice(0, -1);

  if (parentPath.length === 0) {
    // root key: replace or append in the root segment
    const sections = splitTomlSections(text);
    const root = sections[0]!;
    const key = path[0]!;
    const lines = replaceOrAppendKeyValue(root.lines, key, rendered);
    if (lines === root.lines) return text;
    const out = sections.flatMap((s, i) => (i === 0 ? lines : s.lines));
    return normalizeEof(out.join('\n'));
  }

  // ensure the parent section exists (convert inline parents on the way)
  let current = ensureSectionPath(text, parentPath);
  const sections = splitTomlSections(current);
  const idx = sections.findIndex((s) => sameKey(s.key, parentPath));
  if (idx < 0) return current; // ensureSectionPath guarantees this cannot happen
  const section = sections[idx]!;
  const key = path[path.length - 1]!;
  const lines = replaceOrAppendKeyValue(section.lines, key, rendered);
  if (lines === section.lines) return current;
  const out = sections.flatMap((s, i) => (i === idx ? lines : s.lines));
  return normalizeEof(out.join('\n'));
}

/** Remove one dotted-path key from config.toml text. Returns whether the key
 * was found (sections themselves are left alone — removing the last key of a
 * section leaves an empty section, which is harmless TOML). */
export function removeTomlValueInText(
  text: string,
  path: readonly string[],
): { text: string; removed: boolean } {
  if (path.length === 0) return { text, removed: false };
  const sections = splitTomlSections(text);
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1]!;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const matches =
      parentPath.length === 0 ? section.key === null : sameKey(section.key, parentPath);
    if (!matches) continue;
    const lines = removeKeyValueLine(section.lines, key);
    if (lines !== section.lines) {
      const out = sections.flatMap((s, j) => (j === i ? lines : s.lines));
      return { text: normalizeEof(out.join('\n')), removed: true };
    }
  }
  return { text, removed: false };
}

/** Replace `key = …` in a section body (comments before the key stay attached
 * to their own lines; the key's own preceding comment is dropped with it) or
 * append at the end. Returns the input array identity when nothing changed. */
function replaceOrAppendKeyValue(lines: string[], key: string, rendered: string): string[] {
  const out: string[] = [];
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (!replaced && (t.startsWith(`${key} =`) || t.startsWith(`${key}=`))) {
      out.push(rendered);
      replaced = true;
      continue;
    }
    out.push(line);
  }
  if (replaced) return out;
  // append after the last value line (before trailing blanks/comments block)
  let lastValue = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t !== '' && !t.startsWith('#')) {
      lastValue = i;
      break;
    }
  }
  out.splice(lastValue + 1, 0, rendered);
  return out;
}

function removeKeyValueLine(lines: string[], key: string): string[] {
  const out: string[] = [];
  let removed = false;
  for (const line of lines) {
    const t = line.trim();
    if (!removed && (t.startsWith(`${key} =`) || t.startsWith(`${key}=`))) {
      removed = true;
      continue;
    }
    out.push(line);
  }
  return removed ? out : lines;
}

/**
 * Make sure `[a.b]` exists as a section: walk the path converting inline
 * declarations (`a = { b = 1 }`) into `[a]` sections appended at EOF (moving
 * the inline value out of its original line — splicing a header in place
 * would swallow the parent's remaining keys) and appending missing headers.
 */
function ensureSectionPath(text: string, path: readonly string[]): string {
  let current = text;
  for (let depth = 1; depth <= path.length; depth++) {
    const prefix = path.slice(0, depth);
    const sections = splitTomlSections(current);
    // a deeper section ([projects."x"]) already implies every ancestor table —
    // only an exact header (or an inline value) needs lifting/creating
    if (
      sections.some(
        (s) => sameKey(s.key, prefix) || (s.key !== null && isNestedUnder(s.key, prefix)),
      )
    ) {
      continue;
    }
    // inline declaration at the parent level? lift it into a section at EOF
    const parentPrefix = prefix.slice(0, -1);
    const parentSection =
      parentPrefix.length === 0
        ? sections[0]!
        : sections.find((s) => sameKey(s.key, parentPrefix));
    const key = prefix[depth - 1]!;
    if (parentSection) {
      const lifted = liftInlineTable(parentSection.lines, key);
      if (lifted) {
        const idx = sections.indexOf(parentSection);
        current = normalizeEof(
          [
            ...sections.flatMap((s, i) => (i === idx ? lifted.lines : s.lines)),
            ...lifted.sectionLines,
          ].join('\n'),
        );
        continue;
      }
    }
    current = upsertTomlSection(current, [...prefix], []);
  }
  return current;
}

/** Turn `key = { … }` in a section body into section lines appended at EOF.
 * Returns null when the key is not an inline table (caller falls back to
 * appending an empty section — which would collide, but only for documents
 * that mix inline and section forms of the same table; smol-toml rejects
 * those upstream anyway). */
function liftInlineTable(
  lines: string[],
  key: string,
): { lines: string[]; sectionLines: string[] } | null {
  const idx = lines.findIndex((l) => {
    const t = l.trim();
    return t.startsWith(`${key} =`) && t.includes('{');
  });
  if (idx < 0) return null;
  const t = lines[idx]!.trim();
  const inline = t.slice(t.indexOf('=') + 1).trim();
  let parsed: unknown;
  try {
    parsed = parse(`v = ${inline}`);
  } catch {
    return null;
  }
  const value = (parsed as { v?: unknown }).v;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = Object.entries(value as Record<string, unknown>).map(
    ([k, v]) => `${renderTomlKey(k)} = ${renderTomlValue(v)}`,
  );
  const out = [...lines];
  out.splice(idx, 1);
  return { lines: out, sectionLines: [`[${key}]`, ...body] };
}
