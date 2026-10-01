import { lstat, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { classifyAgent, classifyAsset } from '../watch/classifier.js';
import type { AssetEntry } from '../watch/types.js';

/**
 * Machine-level file assets backing the global 文件资产 tree.
 *
 * This is deliberately NOT a home-directory walk: only the known harness
 * directories are listed (whitelisted below), each of which holds a handful
 * of files, with depth and entry caps as a second guard. Internal Claude
 * trees (projects/, shell-snapshots/, plugins/) are never touched, and
 * skills/ are skipped — skills have their own page.
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
];
/** Harness files directly under ~/.claude/. */
const CLAUDE_FILES = ['CLAUDE.md', 'settings.json', 'settings.local.json'];

/** Codex: prompts were removed upstream but may linger on old installs. */
const CODEX_DIRS = ['prompts'];
/** Harness files directly under ~/.codex/. auth.json & friends stay out. */
const CODEX_FILES = ['config.toml', 'AGENTS.md'];

/** Directory names never descended into (own page / too heavyweight). */
const SKIP_DIRS = new Set(['skills', 'plugins']);

const MAX_DEPTH = 6;
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
async function entryFor(abs: string, rel: string): Promise<AssetEntry | null> {
  try {
    const lst = await lstat(abs);
    const isLink = lst.isSymbolicLink();
    // A symlinked file reports the TARGET's mtime (target edits must bump
    // change detection); a broken link throws and is simply omitted.
    const st = isLink ? await stat(abs) : lst;
    if (!st.isFile()) return null;
    return {
      absPath: abs,
      relPath: rel,
      category: classifyAsset(rel),
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
): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;
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
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(abs, rel, depth + 1, out);
      continue;
    }
    if (e.isSymbolicLink()) {
      // A symlinked directory (e.g. commands/ pointed at a repo) is descended
      // like the watcher follows links; a symlinked file becomes an entry.
      try {
        const st = await stat(abs);
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(abs, rel, depth + 1, out);
          continue;
        }
      } catch {
        continue; // broken link
      }
    }
    const entry = await entryFor(abs, rel);
    if (entry) out.push(entry);
  }
}

/**
 * List every machine-level harness file weave knows about, bounded by the
 * whitelist above. `home` is injectable for tests.
 */
export async function listGlobalFileAssets(home: string = homedir()): Promise<AssetEntry[]> {
  const out: AssetEntry[] = [];
  for (const root of ROOTS) {
    const base = path.join(home, ...root.prefix.split('/'));
    for (const f of root.files) {
      const entry = await entryFor(path.join(base, f), `${root.prefix}/${f}`);
      if (entry) out.push(entry);
    }
    for (const d of root.dirs) {
      await walk(path.join(base, d), `${root.prefix}/${d}`, 1, out);
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}
