import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { McpServerConfig } from './installer.js';

/**
 * Incremental editor for `~/.codex/config.toml`.
 *
 * config.toml is a user-authored file (sandbox, approvals, model, …) whose
 * comments and key order must survive weave's writes. A TOML parse →
 * stringify round-trip would destroy both, so this module edits the file at
 * the *line* level instead: a section `[a.b]` (plus its nested sub-sections
 * `[a.b.*]`) is located by its dotted key and replaced or removed verbatim,
 * with every other line kept byte-for-byte. Weave-owned keys (command/args/env)
 * are refreshed; user-added keys inside a managed section are preserved
 * (the "weave keys refresh, everything else stays" merge policy).
 *
 * Reads still go through smol-toml (tolerant); writes refuse to touch a file
 * that does not parse, and the merged result is parse-validated before it is
 * returned — on failure the write falls back to a clean replace, so a merged
 * output can never corrupt config.toml.
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

function sameKey(a: string[] | null, b: string[]): boolean {
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
// Codex config.toml — MCP servers ([mcp_servers.<name>])
// ---------------------------------------------------------------------------

/** Absolute path of the Codex user config (`~/.codex/config.toml`),
 * respecting the test override. */
export function codexConfigFile(home: string = homedir()): string {
  return codexConfigFileOverride ?? path.join(home, '.codex', 'config.toml');
}

/** Read the `mcp_servers` map from config.toml text (empty when absent or
 * unparseable). stdio servers only — entries without a `command` (e.g. remote
 * url servers) are skipped. */
export function readCodexMcpFromText(text: string): Record<string, McpServerConfig> {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return {};
  }
  const servers = (parsed as Record<string, unknown>).mcp_servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const cfg = toMcpServerConfig(raw);
    if (cfg) out[name] = cfg;
  }
  return out;
}

function toMcpServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.command !== 'string') return null;
  const cfg: McpServerConfig = { command: r.command };
  if (Array.isArray(r.args)) {
    const args = r.args.filter((a): a is string => typeof a === 'string');
    if (args.length > 0) cfg.args = args;
  }
  if (r.env && typeof r.env === 'object' && !Array.isArray(r.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    if (Object.keys(env).length > 0) cfg.env = env;
  }
  return cfg;
}

/** Build the body lines for `[mcp_servers.<name>]` (+ its `.env` sub-section).
 * When the server section already exists, user-added keys inside it (e.g.
 * `startup_timeout_sec`) and env vars weave does not manage are preserved. */
function renderMcpServerBody(
  keyPath: string[],
  config: McpServerConfig,
  oldSection: TomlSection | undefined,
  oldEnvSection: TomlSection | undefined,
  mergeUnknown: boolean,
): string[] {
  const body: string[] = [`command = ${renderTomlString(config.command)}`];
  if (config.args && config.args.length > 0) {
    body.push(`args = [${config.args.map(renderTomlString).join(', ')}]`);
  }
  if (mergeUnknown && oldSection) {
    const known = new Set(['command', 'args', 'env']);
    for (const [key, rawLine] of parseSectionEntries(oldSection.lines.slice(1))) {
      if (!known.has(key)) body.push(rawLine);
    }
  }
  const envEntries = Object.entries(config.env ?? {});
  const oldEnvKeys = mergeUnknown && oldEnvSection
    ? parseSectionEntries(oldEnvSection.lines.slice(1)).filter(([k]) => !(k in (config.env ?? {})))
    : [];
  if (envEntries.length > 0 || oldEnvKeys.length > 0) {
    body.push('');
    body.push(renderTomlHeader([...keyPath, 'env']));
    for (const [k, v] of envEntries) {
      body.push(`${renderTomlKey(k)} = ${renderTomlString(v)}`);
    }
    for (const [, rawLine] of oldEnvKeys) body.push(rawLine);
  }
  return body;
}

/** Insert or replace an `[mcp_servers.<name>]` entry in config.toml text,
 * preserving everything else. Merge-validated: if preserving user-added keys
 * produces invalid TOML, the section is written clean instead. */
export function upsertCodexMcpInText(
  text: string,
  name: string,
  config: McpServerConfig,
): string {
  const keyPath = ['mcp_servers', name];
  const guard = assertNoInlineMcpTable(text);
  if (guard) throw guard;
  const sections = splitTomlSections(text);
  const oldSection = sections.find((s) => sameKey(s.key, keyPath));
  const oldEnvSection = sections.find((s) => sameKey(s.key, [...keyPath, 'env']));
  const merged = upsertTomlSection(
    text,
    keyPath,
    renderMcpServerBody(keyPath, config, oldSection, oldEnvSection, true),
  );
  try {
    parse(merged);
    return merged;
  } catch {
    // merged output invalid (e.g. a user key had a multi-line value) — write clean
    const clean = upsertTomlSection(
      text,
      keyPath,
      renderMcpServerBody(keyPath, config, oldSection, oldEnvSection, false),
    );
    try {
      parse(clean);
      return clean;
    } catch (e) {
      // dropping whole sections of a parseable file cannot break it — if we
      // ever get here, refuse rather than corrupt config.toml
      throw new CodexTomlCorruptError(
        `unable to produce valid TOML for [mcp_servers.${name}]: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** Remove an `[mcp_servers.<name>]` entry (with its sub-sections) from
 * config.toml text. Returns whether a section was removed. */
export function removeCodexMcpFromText(
  text: string,
  name: string,
): { text: string; removed: boolean } {
  return removeTomlSection(text, ['mcp_servers', name]);
}

/** Reject `mcp_servers = {…}` / `mcp_servers = […]` at root: an inline value
 * would conflict with the `[mcp_servers.<name>]` section we are about to
 * insert (duplicate key). */
function assertNoInlineMcpTable(text: string): CodexTomlCorruptError | null {
  const root = splitTomlSections(text)[0]!;
  const inline = root.lines.find((l) => /^\s*mcp_servers\s*=/.test(l));
  if (inline) {
    return new CodexTomlCorruptError(
      '~/.codex/config.toml defines "mcp_servers" as an inline value — weave only manages the [mcp_servers.<name>] section form',
    );
  }
  return null;
}

// --- file-level wrappers ----------------------------------------------------

/** Test seam: pin the config.toml path (null → the user's ~/.codex/config.toml). */
let codexConfigFileOverride: string | null = null;

export function setCodexConfigFileOverride(file: string | null): void {
  codexConfigFileOverride = file;
}

async function readTextIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf-8');
  } catch {
    return '';
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Read MCP servers from `~/.codex/config.toml` (empty when absent/corrupt). */
export async function readCodexMcpServers(
  file: string = codexConfigFile(),
): Promise<Record<string, McpServerConfig>> {
  if (!(await pathExists(file))) return {};
  return readCodexMcpFromText(await readFile(file, 'utf-8'));
}

/** Whether an `[mcp_servers.<name>]` section exists (cheap line-level check). */
export async function codexMcpExists(name: string, file: string = codexConfigFile()): Promise<boolean> {
  if (!(await pathExists(file))) return false;
  return sameKeyInText(await readFile(file, 'utf-8'), ['mcp_servers', name]);
}

function sameKeyInText(text: string, keyPath: string[]): boolean {
  return splitTomlSections(text).some((s) => sameKey(s.key, keyPath));
}

/** Insert or replace an MCP server in `~/.codex/config.toml`. Refuses to
 * write a file that does not parse (protects the user's hand-written config);
 * creates the file when absent. */
export async function writeCodexMcpServer(
  name: string,
  config: McpServerConfig,
  file: string = codexConfigFile(),
): Promise<void> {
  const text = await readTextIfExists(file);
  if (text.trim() !== '') {
    try {
      parse(text);
    } catch (e) {
      throw new CodexTomlCorruptError(
        `${file} is not valid TOML — refusing to write: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, upsertCodexMcpInText(text, name, config), 'utf-8');
}

/** Remove an MCP server section from `~/.codex/config.toml`. Returns whether
 * a section was removed (false = was not configured). */
export async function removeCodexMcpServer(
  name: string,
  file: string = codexConfigFile(),
): Promise<boolean> {
  if (!(await pathExists(file))) return false;
  const text = await readFile(file, 'utf-8');
  try {
    parse(text);
  } catch (e) {
    throw new CodexTomlCorruptError(
      `${file} is not valid TOML — refusing to write: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const { text: next, removed } = removeCodexMcpFromText(text, name);
  if (removed) await writeFile(file, next, 'utf-8');
  return removed;
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
