import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { McpServerConfig } from '../driver.js';
import {
  CodexTomlCorruptError,
  parseSectionEntries,
  removeTomlSection,
  renderTomlHeader,
  renderTomlKey,
  renderTomlString,
  sameKey,
  splitTomlSections,
  upsertTomlSection,
  type TomlSection,
} from './toml.js';

/**
 * Codex config.toml 的 MCP 表示法（文本层 + fs 层）：`[mcp_servers.<name>]`
 * 这一形是 codex 自己的知识，调用方只传名字与 `McpServerConfig`。
 */

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

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toMcpServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  // Streamable HTTP：有 url 就是远程形（与 codex 自己的 untagged 判别一致）
  if (typeof r.url === 'string') {
    const cfg: McpServerConfig = { url: r.url };
    const headers = stringMap(r.http_headers);
    if (headers) cfg.headers = headers;
    if (typeof r.bearer_token_env_var === 'string') cfg.bearerTokenEnvVar = r.bearer_token_env_var;
    return cfg;
  }
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
  const body: string[] = [];
  if ('command' in config) {
    body.push(`command = ${renderTomlString(config.command)}`);
    if (config.args && config.args.length > 0) {
      body.push(`args = [${config.args.map(renderTomlString).join(', ')}]`);
    }
  } else {
    body.push(`url = ${renderTomlString(config.url)}`);
    if (config.bearerTokenEnvVar) {
      body.push(`bearer_token_env_var = ${renderTomlString(config.bearerTokenEnvVar)}`);
    }
    const headers = Object.entries(config.headers ?? {});
    if (headers.length > 0) {
      body.push(
        `http_headers = { ${headers
          .map(([k, v]) => `${renderTomlKey(k)} = ${renderTomlString(v)}`)
          .join(', ')} }`,
      );
    }
  }
  if (mergeUnknown && oldSection) {
    const known = new Set(['command', 'args', 'env', 'url', 'http_headers', 'bearer_token_env_var']);
    for (const [key, rawLine] of parseSectionEntries(oldSection.lines.slice(1))) {
      if (!known.has(key)) body.push(rawLine);
    }
  }
  const envEntries = Object.entries('env' in config ? (config.env ?? {}) : {});
  const oldEnvKeys = mergeUnknown && oldEnvSection
    ? parseSectionEntries(oldEnvSection.lines.slice(1)).filter(
        ([k]) => !(k in ('env' in config ? (config.env ?? {}) : {})),
      )
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

// --- fs 层（路径由调用方给：harness 不知道测试的路径覆写） ---

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

/** Read MCP servers from a config.toml (empty when absent/corrupt). */
export async function readCodexMcpServers(file: string): Promise<Record<string, McpServerConfig>> {
  if (!(await pathExists(file))) return {};
  return readCodexMcpFromText(await readFile(file, 'utf-8'));
}

/** Whether an `[mcp_servers.<name>]` section exists (cheap line-level check). */
export async function codexMcpExists(name: string, file: string): Promise<boolean> {
  if (!(await pathExists(file))) return false;
  return sameKeyInText(await readFile(file, 'utf-8'), ['mcp_servers', name]);
}

function sameKeyInText(text: string, keyPath: string[]): boolean {
  return splitTomlSections(text).some((s) => sameKey(s.key, keyPath));
}

/** Insert or replace an MCP server in a config.toml. Refuses to write a file
 * that does not parse (protects the user's hand-written config); creates the
 * file when absent. */
export async function writeCodexMcpServer(
  name: string,
  config: McpServerConfig,
  file: string,
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

/** Remove an MCP server section from a config.toml. Returns whether a section
 * was removed (false = was not configured). */
export async function removeCodexMcpServer(name: string, file: string): Promise<boolean> {
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
