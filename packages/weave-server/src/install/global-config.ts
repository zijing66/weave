import { readFile, writeFile, readdir, cp, rm, access, stat, realpath, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { McpServerConfig } from './installer.js';
import { AssetNotFoundError } from './installer.js';
import { CodexTomlCorruptError, upsertCodexPluginEnabledInText } from './codex-toml.js';
import { FileTooLargeError, MAX_BYTES, type ProjectFile } from './reader.js';
import type { AssetEntry } from '../watch/types.js';

/**
 * Global (user-scope) Claude Code configuration.
 *
 * `~/.claude.json` is Claude Code's runtime file: it holds user-level MCP
 * servers among many other keys. weave treats it as read-modify-write and MUST
 * preserve every top-level key it does not own. A file that fails to parse is
 * never written (we refuse rather than risk corrupting it). Skill assets at the
 * global scope live under `~/.claude/skills/` — plain directory operations.
 *
 * Beyond the user's own skills, the global view also enumerates skills coming
 * from installed Claude Code plugins (`~/.claude/plugins/installed_plugins.json`
 * → each plugin's `skills/` dir) and Codex skills (`~/.agents/skills/`, plus the
 * deprecated `~/.codex/skills/`
 * Codex plugin caches). Plugin enable state is read from / written to the
 * host config: `~/.claude/settings.json` (`enabledPlugins`) for Claude and
 * `~/.codex/config.toml` (`[plugins."key"] enabled`) for Codex.
 */

/** `~/.claude.json` could not be parsed; refuse to write to avoid corruption. */
export class ClaudeJsonCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeJsonCorruptError';
  }
}

const CLAUDE_JSON = '.claude.json';
const GLOBAL_SKILLS_DIR = '.claude/skills';
const CLAUDE_PLUGINS_JSON = '.claude/plugins/installed_plugins.json';
const CLAUDE_SETTINGS = '.claude/settings.json';
const CODEX_HOME_DIR = '.codex';
/**
 * Codex's current user-level skills root. Cross-tool convention, and the one
 * Codex reads first (`codex-rs/ext/skills/src/host_roots.rs`).
 */
const CODEX_AGENTS_SKILLS_DIR = '.agents/skills';
/**
 * Where Codex used to keep user-level skills. `host_roots.rs` still registers
 * it, commented "Deprecated user skills location, kept for backward
 * compatibility" — so it is read but never written.
 */
const CODEX_LEGACY_SKILLS_DIR = '.codex/skills';
const CODEX_PLUGINS_CACHE = '.codex/plugins/cache';

/** Where a global skill came from — used as the grouping key in the UI. */
export type GlobalSkillSource =
  | 'claude-personal'
  | 'claude-plugin'
  | 'codex-personal'
  | 'codex-plugin';

/** A single resolved skill directory. `dir` is absolute (may be a symlink). */
export interface GlobalSkillEntry {
  name: string;
  dir: string;
}

/** A labelled group of skills sharing a source. Plugin groups carry enable
 * state (per-plugin, keyed `plugin@marketplace`); personal groups do not. */
export interface GlobalSkillGroup {
  source: GlobalSkillSource;
  label: string;
  skills: GlobalSkillEntry[];
  /** `plugin@marketplace` for plugin groups; undefined for personal groups. */
  pluginKey?: string;
  /** Enable state for plugin groups (undefined → not applicable). */
  enabled?: boolean;
}

function claudeJsonPath(): string {
  return path.join(homedir(), CLAUDE_JSON);
}
function globalSkillsPath(): string {
  return path.join(homedir(), GLOBAL_SKILLS_DIR);
}
function claudePluginsJsonPath(): string {
  return path.join(homedir(), CLAUDE_PLUGINS_JSON);
}
function claudeSettingsPath(): string {
  return path.join(homedir(), CLAUDE_SETTINGS);
}
/** Codex user-level skills root — the one installs target. */
function codexSkillsPath(): string {
  return path.join(homedir(), ...CODEX_AGENTS_SKILLS_DIR.split('/'));
}
/** Codex user-level skills roots, current location first. */
function codexSkillsPaths(): string[] {
  return [
    codexSkillsPath(),
    path.join(homedir(), ...CODEX_LEGACY_SKILLS_DIR.split('/')),
  ];
}
function codexPluginsCachePath(): string {
  return path.join(homedir(), CODEX_PLUGINS_CACHE);
}

/** Personal skill roots that may contain symlinks to dev repos — the roots the
 * watch service observes so edits to a symlinked skill's original files flow
 * through SSE. Plugin caches are versioned/static and intentionally excluded. */
export function globalPersonalSkillRoots(): string[] {
  return [globalSkillsPath(), ...codexSkillsPaths()];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** True if `p` is a directory, following symlinks (so symlinked skill dirs
 * under ~/.claude/skills/ are counted, which `Dirent.isDirectory()` alone
 * would miss because it reports the link type, not the target). */
async function isDirectoryFollow(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Read + parse ~/.claude.json. Missing file → {}. Unparseable → corrupt error. */
export async function readGlobalClaudeJson(): Promise<Record<string, unknown>> {
  const file = claudeJsonPath();
  if (!(await pathExists(file))) return {};
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ClaudeJsonCorruptError(
      `~/.claude.json is not valid JSON — refusing to write: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClaudeJsonCorruptError('~/.claude.json is not a JSON object — refusing to write');
  }
  return parsed as Record<string, unknown>;
}

/** Read user-level MCP servers from ~/.claude.json (empty if absent). */
export async function readGlobalMcpServers(): Promise<Record<string, McpServerConfig>> {
  const json = await readGlobalClaudeJson();
  const servers = json.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  return servers as Record<string, McpServerConfig>;
}

/** Persist the full ~/.claude.json object (preserves all unknown keys). */
async function writeGlobalClaudeJson(json: Record<string, unknown>): Promise<void> {
  await writeFile(claudeJsonPath(), `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
}

/**
 * Add or replace a user-level MCP server in ~/.claude.json. Preserves every
 * other top-level key. Refuses to write if the file is corrupt (unreadable as
 * JSON); in that case the caller should surface the error to the user.
 */
export async function writeGlobalMcpServer(name: string, config: McpServerConfig): Promise<void> {
  const json = await readGlobalClaudeJson();
  const servers = (json.mcpServers ?? {}) as Record<string, unknown>;
  servers[name] = config;
  json.mcpServers = servers;
  await writeGlobalClaudeJson(json);
}

/** Remove a user-level MCP server from ~/.claude.json (no-op if absent). */
export async function removeGlobalMcpServer(name: string): Promise<void> {
  const json = await readGlobalClaudeJson();
  const servers = (json.mcpServers ?? {}) as Record<string, unknown>;
  if (!(name in servers)) return;
  delete servers[name];
  json.mcpServers = servers;
  await writeGlobalClaudeJson(json);
}

// --- global skills (plain directory ops under ~/.claude/skills/) ---

/** List skill directory names under ~/.claude/skills/ (follows symlinks). */
export async function readGlobalSkills(): Promise<string[]> {
  const dir = globalSkillsPath();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const names: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      // symlink may point at a file; confirm the target is a directory
      if (await isDirectoryFollow(path.join(dir, e.name))) names.push(e.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Install a skill directory to the agent's global skills root
 * (`~/.claude/skills/<name>/` or `~/.agents/skills/<name>/`). */
export async function installGlobalSkill(
  sourceDir: string,
  name: string,
  agent: 'claude' | 'codex' = 'claude',
): Promise<string> {
  const root = agent === 'codex' ? codexSkillsPath() : globalSkillsPath();
  const target = path.join(root, name);
  if (await pathExists(target)) {
    throw new Error(`Global ${agent} skill "${name}" already exists`);
  }
  await cp(sourceDir, target, { recursive: true });
  return target;
}

/** Remove a global skill directory from the agent's skills root. */
export async function uninstallGlobalSkill(
  name: string,
  agent: 'claude' | 'codex' = 'claude',
): Promise<void> {
  const root = agent === 'codex' ? codexSkillsPath() : globalSkillsPath();
  const target = path.join(root, name);
  if (!(await pathExists(target))) return;
  await rm(target, { recursive: true, force: true });
}

// --- global skill groups (personal + plugin, Claude + Codex) ---

/** Read `~/.claude/plugins/installed_plugins.json` (empty if absent/corrupt). */
async function readClaudePluginManifest(): Promise<Record<string, unknown>> {
  const file = claudePluginsJsonPath();
  if (!(await pathExists(file))) return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** List immediate sub-directories of `dir` that are directories (symlinks
 * followed). Hidden names (starting with `.`) are skipped. */
async function listSkillSubdirs(dir: string): Promise<GlobalSkillEntry[]> {
  if (!(await isDirectoryFollow(dir))) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: GlobalSkillEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (await isDirectoryFollow(full)) out.push({ name: e.name, dir: full });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface ClaudePluginRecord {
  installPath?: string;
  version?: string;
}

/** Skills shipped by an installed Claude plugin. Each plugin key maps to one
 * or more installed versions (array); weave picks the newest installPath. */
async function readClaudePluginSkills(): Promise<GlobalSkillGroup[]> {
  const manifest = await readClaudePluginManifest();
  const plugins = manifest.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return [];
  const groups: GlobalSkillGroup[] = [];
  for (const [key, raw] of Object.entries(plugins as Record<string, unknown>)) {
    const records = Array.isArray(raw) ? (raw as ClaudePluginRecord[]) : [];
    if (records.length === 0) continue;
    // newest installPath = last record by lastUpdated/installedAt; the array
    // is append-only in practice, so take the last with an installPath.
    const rec = [...records]
      .filter((r) => r && typeof r.installPath === 'string')
      .pop();
    if (!rec?.installPath) continue;
    const skills = await listSkillSubdirs(path.join(rec.installPath, 'skills'));
    const name = key.split('@')[0] ?? key;
    groups.push({
      source: 'claude-plugin',
      label: name,
      skills,
      pluginKey: key,
    });
  }
  return groups.sort((a, b) => a.label.localeCompare(b.label));
}

/** Personal Codex skills. Both roots are read — `~/.agents/skills` is where
 * Codex looks first, `~/.codex/skills` is its deprecated predecessor whose
 * contents still load, so an install made before the move keeps appearing.
 * On a name collision the current location wins. */
async function readCodexPersonalSkills(): Promise<GlobalSkillGroup> {
  const byName = new Map<string, GlobalSkillEntry>();
  for (const root of codexSkillsPaths()) {
    for (const skill of await listSkillSubdirs(root)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { source: 'codex-personal', label: 'Codex · 个人', skills };
}

/** Skills shipped by Codex plugins under
 * ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/skills/. Each
 * plugin may have several cached versions; weave uses the newest by version
 * string (lexicographic, matching Codex's semver-ish scheme). */
async function readCodexPluginSkills(): Promise<GlobalSkillGroup[]> {
  const cache = codexPluginsCachePath();
  if (!(await isDirectoryFollow(cache))) return [];
  const groups: GlobalSkillGroup[] = [];
  let marketplaces: import('node:fs').Dirent[];
  try {
    marketplaces = await readdir(cache, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const mp of marketplaces) {
    if (!mp.isDirectory() && !mp.isSymbolicLink()) continue;
    const mpDir = path.join(cache, mp.name);
    let plugins: import('node:fs').Dirent[];
    try {
      plugins = await readdir(mpDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pl of plugins) {
      if (!pl.isDirectory() && !pl.isSymbolicLink()) continue;
      const plDir = path.join(mpDir, pl.name);
      let versions: import('node:fs').Dirent[];
      try {
        versions = await readdir(plDir, { withFileTypes: true });
      } catch {
        continue;
      }
      const versionDirs = versions.filter((v) => v.isDirectory() || v.isSymbolicLink());
      if (versionDirs.length === 0) continue;
      // newest version = lexicographic max (semver-ish)
      const newest = versionDirs.map((v) => v.name).sort().pop()!;
      const skills = await listSkillSubdirs(path.join(plDir, newest, 'skills'));
      const pluginKey = `${pl.name}@${mp.name}`;
      groups.push({
        source: 'codex-plugin',
        label: pl.name,
        skills,
        pluginKey,
      });
    }
  }
  return groups.sort((a, b) => a.label.localeCompare(b.label));
}

/** Personal Claude skills under ~/.claude/skills/ as a group. */
async function readClaudePersonalSkills(): Promise<GlobalSkillGroup> {
  const dir = globalSkillsPath();
  const entries = await readGlobalSkills();
  return {
    source: 'claude-personal',
    label: 'Claude Code · 个人',
    skills: entries.map((name) => ({ name, dir: path.join(dir, name) })),
  };
}

/**
 * Aggregate every global skill source into ordered groups. Plugin groups are
 * decorated with their enable state (read from the host config). Empty groups
 * are kept so the UI can show "none installed" per source. Order:
 * claude-personal, claude-plugin(s), codex-personal, codex-plugin(s).
 */
export async function readGlobalSkillGroups(): Promise<GlobalSkillGroup[]> {
  const [personal, claudePlugins, codexPersonal, codexPlugins, claudeEnabled, codexEnabled] =
    await Promise.all([
      readClaudePersonalSkills(),
      readClaudePluginSkills(),
      readCodexPersonalSkills(),
      readCodexPluginSkills(),
      readClaudePluginEnabled(),
      readCodexPluginEnabled(),
    ]);

  const decorate = (g: GlobalSkillGroup, enabled: Record<string, boolean>) => ({
    ...g,
    enabled: g.pluginKey ? enabled[g.pluginKey] ?? false : undefined,
  });

  return [
    personal,
    ...claudePlugins.map((g) => decorate(g, claudeEnabled)),
    codexPersonal,
    ...codexPlugins.map((g) => decorate(g, codexEnabled)),
  ];
}

// --- global skill file listing / reading (follows symlinks) ---

/** Resolve a single global skill's directory by source + name (+ pluginKey for
 * plugins). Targeted lookup — does not re-read every group. Returns null when
 * the skill (or its enclosing plugin install) is not found. */
export async function resolveGlobalSkillDir(
  source: GlobalSkillSource,
  name: string,
  pluginKey?: string,
): Promise<string | null> {
  if (source === 'claude-personal') {
    const dir = path.join(globalSkillsPath(), name);
    return (await isDirectoryFollow(dir)) ? dir : null;
  }
  if (source === 'codex-personal') {
    const dir = path.join(codexSkillsPath(), name);
    return (await isDirectoryFollow(dir)) ? dir : null;
  }
  if (source === 'claude-plugin') {
    if (!pluginKey) return null;
    const manifest = await readClaudePluginManifest();
    const plugins = manifest.plugins;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return null;
    const records = (plugins as Record<string, unknown>)[pluginKey];
    const arr = Array.isArray(records) ? (records as ClaudePluginRecord[]) : [];
    const rec = [...arr].filter((r) => r && typeof r.installPath === 'string').pop();
    if (!rec?.installPath) return null;
    const dir = path.join(rec.installPath, 'skills', name);
    return (await isDirectoryFollow(dir)) ? dir : null;
  }
  // codex-plugin: pluginKey = "<plugin>@<marketplace>"
  if (!pluginKey) return null;
  const at = pluginKey.lastIndexOf('@');
  if (at <= 0) return null;
  const plugin = pluginKey.slice(0, at);
  const marketplace = pluginKey.slice(at + 1);
  const plDir = path.join(codexPluginsCachePath(), marketplace, plugin);
  if (!(await isDirectoryFollow(plDir))) return null;
  let versions: import('node:fs').Dirent[];
  try {
    versions = await readdir(plDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const versionDirs = versions.filter((v) => v.isDirectory() || v.isSymbolicLink());
  if (versionDirs.length === 0) return null;
  const newest = versionDirs.map((v) => v.name).sort().pop()!;
  const dir = path.join(plDir, newest, 'skills', name);
  return (await isDirectoryFollow(dir)) ? dir : null;
}

/** Recursively list files inside a global skill directory (symlinks followed),
 * with paths relative to the skill dir (posix separators). Hidden entries are
 * skipped. The agent is derived from the dir path (`.codex` segment → Codex). */
export async function listGlobalSkillFiles(dir: string): Promise<AssetEntry[]> {
  const agent = dir.split(/[\\/]/).includes('.codex') ? 'codex' : 'claude';
  const out: AssetEntry[] = [];
  const walk = async (cur: string, rel: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childAbs = path.join(cur, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      // Follow symlinks: a link to a directory must be descended into.
      if ((e.isDirectory() || e.isSymbolicLink()) && (await isDirectoryFollow(childAbs))) {
        await walk(childAbs, childRel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        try {
          const s = await stat(childAbs);
          if (s.isFile()) out.push({ absPath: childAbs, relPath: childRel, category: 'skill', agent, mtimeMs: s.mtimeMs });
        } catch {
          // vanished between readdir and stat — skip
        }
      }
    }
  };
  await walk(dir, '');
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** Read a text file inside a global skill directory, following symlinks. The
 * `relPath` is relative to `dir`; absolute paths and `..` segments are rejected,
 * and the resolved real path must stay within the (possibly symlinked) skill
 * dir — so a symlinked file pointing outside the skill is refused. */
export async function readGlobalSkillFile(dir: string, relPath: string): Promise<ProjectFile> {
  const posix = path.normalize(relPath).replace(/\\/g, '/');
  if (path.isAbsolute(relPath)) {
    throw new AssetNotFoundError(`Absolute paths are not allowed: "${relPath}"`);
  }
  if (posix.split('/').some((seg) => seg === '..')) {
    throw new AssetNotFoundError(`Path traversal is not allowed: "${relPath}"`);
  }
  const abs = path.join(dir, posix);
  let s;
  try {
    s = await stat(abs);
  } catch {
    throw new AssetNotFoundError(`File not found: "${relPath}"`);
  }
  if (!s.isFile()) {
    throw new AssetNotFoundError(`Not a file: "${relPath}"`);
  }
  if (s.size > MAX_BYTES) {
    throw new FileTooLargeError(`File exceeds ${MAX_BYTES} bytes: "${relPath}"`);
  }
  // Containment: resolve symlinks on both the file and the skill dir, then
  // ensure the file's real path is nested under the dir's real path.
  let dirReal = dir;
  let absReal = abs;
  try {
    [dirReal, absReal] = await Promise.all([realpath(dir), realpath(abs)]);
  } catch {
    throw new AssetNotFoundError(`File not found: "${relPath}"`);
  }
  const root = dirReal.endsWith(path.sep) ? dirReal : dirReal + path.sep;
  if (absReal !== dirReal && !absReal.startsWith(root)) {
    throw new AssetNotFoundError(`Resolved path escapes the skill directory: "${relPath}"`);
  }
  const content = await readFile(abs, 'utf-8');
  return { content, size: s.size };
}

// --- plugin enable state (Claude: settings.json JSON, Codex: config.toml) ---

/** Read `enabledPlugins` from ~/.claude/settings.json (empty if absent/corrupt). */
export async function readClaudePluginEnabled(): Promise<Record<string, boolean>> {
  const file = claudeSettingsPath();
  if (!(await pathExists(file))) return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    const ep = (parsed as { enabledPlugins?: unknown }).enabledPlugins;
    if (!ep || typeof ep !== 'object' || Array.isArray(ep)) return {};
    return Object.fromEntries(
      Object.entries(ep as Record<string, unknown>).filter(
        ([, v]) => typeof v === 'boolean',
      ) as [string, boolean][],
    );
  } catch {
    return {};
  }
}

async function readClaudeSettings(): Promise<Record<string, unknown>> {
  const file = claudeSettingsPath();
  if (!(await pathExists(file))) return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Set `enabledPlugins[key]` in ~/.claude/settings.json, preserving all other
 * keys. The file is created if missing. */
export async function writeClaudePluginEnabled(key: string, enabled: boolean): Promise<void> {
  const settings = await readClaudeSettings();
  const map = (settings.enabledPlugins ?? {}) as Record<string, unknown>;
  map[key] = enabled;
  settings.enabledPlugins = map;
  await writeFile(claudeSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
}

/** Read `[plugins."key"] enabled` from ~/.codex/config.toml (empty if absent). */
export async function readCodexPluginEnabled(): Promise<Record<string, boolean>> {
  const file = path.join(homedir(), CODEX_HOME_DIR, 'config.toml');
  if (!(await pathExists(file))) return {};
  try {
    const parsed = parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
    const plugins = parsed.plugins;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(plugins as Record<string, unknown>)) {
      if (v && typeof v === 'object' && typeof (v as { enabled?: unknown }).enabled === 'boolean') {
        out[k] = (v as { enabled: boolean }).enabled;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Set `[plugins."key"] enabled` in ~/.codex/config.toml. Uses the incremental
 * section editor so comments, key order and other sections survive; the file
 * is created if missing. */
export async function writeCodexPluginEnabled(key: string, enabled: boolean): Promise<void> {
  const file = path.join(homedir(), CODEX_HOME_DIR, 'config.toml');
  let text = '';
  if (await pathExists(file)) {
    text = await readFile(file, 'utf-8');
    try {
      parse(text);
    } catch (e) {
      throw new CodexTomlCorruptError(
        `${file} is not valid TOML — refusing to write: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, upsertCodexPluginEnabledInText(text, key, enabled), 'utf-8');
}

export {
  globalSkillsPath,
  claudeJsonPath,
  claudePluginsJsonPath,
  claudeSettingsPath,
  codexSkillsPath,
  codexPluginsCachePath,
};
