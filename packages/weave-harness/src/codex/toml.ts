/**
 * Codex config.toml 的**纯文本层**——行级增量编辑器（保留注释与键序）。
 *
 * 从 weave-server/src/install/codex-toml.ts 迁入（P2 专属格式下沉）：
 * codex 的配置表示法是 harness 知识，不得散在 server。fs 侧包装
 * （config.toml 路径 / MCP 读写）暂留 server 的同名模块，经本模块原语实现。
 */

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
