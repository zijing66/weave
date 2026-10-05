import { lstat, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { classifyAgent, classifyAsset } from '../watch/classifier.js';
import { PluginModsSniffer } from '../watch/plugin-mods.js';
import type { AssetEntry } from '../watch/types.js';

/**
 * Machine-level file assets backing the global 文件资产 tree.
 *
 * This is deliberately NOT a home-directory walk: only the known harness
 * directories are listed (whitelisted below), each of which holds a handful
 * of files, with depth and entry caps as a second guard. Internal Claude
 * trees (projects/, shell-snapshots/) are never touched, and skills/ are
 * skipped at any depth — skills have their own page. plugins/ IS descended
 * (installed plugins surface in the tree), but its marketplace data and
 * plugin registry metadata stay out; the plugins subtree gets a deeper
 * depth budget than the plain config dirs.
 *
 * Entries are keyed by a tool-prefixed relPath (`.claude/commands/x.md`,
 * `.codex/config.toml`), so the web tree naturally grows one root node per
 * harness tool: two roots on the 全部 tab, one on a tool's own tab.
 */

/** Harness directories under ~/.claude/ that hold file assets. */
const CLAUDE_DIRS = [
  'commands',
  'agents',
  'workflows',
  'rules',
  'output-styles',
  'hooks',
  'themes',
  'routines',
  'plugins',
];
/** Harness files directly under ~/.claude/. */
const CLAUDE_FILES = ['CLAUDE.md', 'settings.json', 'settings.local.json'];

/** Codex: prompts were removed upstream but may linger on old installs. */
const CODEX_DIRS = ['prompts'];
/** Harness files directly under ~/.codex/. auth.json & friends stay out. */
const CODEX_FILES = ['config.toml', 'AGENTS.md'];

/** Directory names never descended into at any depth (own page / noise). */
const SKIP_DIRS = new Set(['skills', 'node_modules', '.git']);
/** Inside `.claude/plugins/`, these dir names are registry data, not assets. */
const PLUGIN_SUBTREE_SKIP = new Set(['marketplaces', 'data', '.in_use']);
const PLUGIN_SUBTREE_ROOT = '.claude/plugins';
const PLUGIN_SUBTREE_PREFIX = `${PLUGIN_SUBTREE_ROOT}/`;

const MAX_DEPTH = 6;
/** Plugin packages nest deeper (vendor/plugin/version/src/…). */
const PLUGIN_MAX_DEPTH = 10;
const MAX_ENTRIES = 5000;

interface RootSpec {
  /** Tool prefix used in relPaths — doubles as the tree's root node. */
  prefix: string;
  dirs: string[];
  files: string[];
}

const ROOTS: RootSpec[] = [
  { prefix: '.claude', dirs: CLAUDE_DIRS, files: CLAUDE_FILES },
  { prefix: '.codex', dirs: CODEX_DIRS, files: CODEX_FILES },
];

/** One file entry, or null when it vanished / is not a regular file. */
async function entryFor(
  abs: string,
  rel: string,
  sniffer: PluginModsSniffer,
): Promise<AssetEntry | null> {
  try {
    const lst = await lstat(abs);
    const isLink = lst.isSymbolicLink();
    // A symlinked file reports the TARGET's mtime (target edits must bump
    // change detection); a broken link throws and is simply omitted.
    const st = isLink ? await stat(abs) : lst;
    if (!st.isFile()) return null;
    let category = classifyAsset(rel);
    if (category === 'plugin') category = sniffer.refine(category, rel, abs);
    return {
      absPath: abs,
      relPath: rel,
      category,
      agent: classifyAgent(rel),
      mtimeMs: st.mtimeMs,
      ...(isLink ? { isSymlink: true } : {}),
    };
  } catch {
    return null;
  }
}

async function walk(
  absDir: string,
  relDir: string,
  depth: number,
  out: AssetEntry[],
  maxDepth: number,
  sniffer: PluginModsSniffer,
): Promise<void> {
  if (depth > maxDepth || out.length >= MAX_ENTRIES) return;
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return; // absent or unreadable — a whitelist probe, not an error
  }
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) return;
    const abs = path.join(absDir, e.name);
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      if (skipDir(rel, e.name)) continue;
      await walk(abs, rel, depth + 1, out, maxDepth, sniffer);
      continue;
    }
    if (e.isSymbolicLink()) {
      // A symlinked directory (e.g. commands/ pointed at a repo) is descended
      // like the watcher follows links; a symlinked file becomes an entry.
      try {
        const st = await stat(abs);
        if (st.isDirectory()) {
          if (!skipDir(rel, e.name)) {
            await walk(abs, rel, depth + 1, out, maxDepth, sniffer);
          }
          continue;
        }
      } catch {
        continue; // broken link
      }
    }
    const entry = await entryFor(abs, rel, sniffer);
    if (entry) out.push(entry);
  }
}

/** Global skips (any depth) plus the plugins-subtree data skips. */
function skipDir(rel: string, name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  return rel.startsWith(PLUGIN_SUBTREE_PREFIX) && PLUGIN_SUBTREE_SKIP.has(name);
}

/**
 * List every machine-level harness file weave knows about, bounded by the
 * whitelist above. `home` is injectable for tests.
 */
export async function listGlobalFileAssets(home: string = homedir()): Promise<AssetEntry[]> {
  const sniffer = new PluginModsSniffer({ revalidate: false }); // 请求级：同请求内复用结论
  const out: AssetEntry[] = [];
  for (const root of ROOTS) {
    const base = path.join(home, ...root.prefix.split('/'));
    for (const f of root.files) {
      const entry = await entryFor(path.join(base, f), `${root.prefix}/${f}`, sniffer);
      if (entry) out.push(entry);
    }
    for (const d of root.dirs) {
      const relDir = `${root.prefix}/${d}`;
      const maxDepth = relDir === PLUGIN_SUBTREE_ROOT ? PLUGIN_MAX_DEPTH : MAX_DEPTH;
      await walk(path.join(base, d), relDir, 1, out, maxDepth, sniffer);
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}
