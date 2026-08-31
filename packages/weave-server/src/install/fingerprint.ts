import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { McpServerConfig } from './installer.js';

/**
 * Content fingerprinting for update detection.
 *
 * An installed asset is "outdated" when its content hash diverges from its
 * library source's content hash. We hash directories recursively (file path +
 * body, sorted) and MCP configs via stable serialization, so a hash match means
 * "byte-identical content" regardless of mtime.
 *
 * A small in-memory cache keyed by directory path avoids rehashing unchanged
 * trees: the cache entry is invalidated when the directory's max mtime changes,
 * which is cheap to recompute (a readdir + stat pass, no file reads).
 */

/** A skill source directory is never rehash-relevant if it is a sidecar. */
const SKIP_NAMES = new Set(['.weave', '.git', 'node_modules']);

export interface FingerprintCacheEntry {
  /** Max mtime (ms) across all files in the tree when this hash was computed. */
  maxMtime: number;
  hash: string;
}

/**
 * Recursively hash a directory tree. The digest is stable: files are sorted by
 * their path relative to `dir`, and each contributes `${relPath}\0${content}`.
 * Empty / missing directories hash to a constant.
 */
export async function hashSkillDir(dir: string): Promise<string> {
  const h = createHash('sha256');
  const files: { rel: string; abs: string }[] = [];
  await collect(dir, dir, files);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  for (const f of files) {
    h.update(f.rel);
    h.update('\0');
    let content: Buffer;
    try {
      content = await readFile(f.abs);
    } catch {
      continue; // vanished between collect and read — skip
    }
    h.update(content);
    h.update('\0');
  }
  return h.digest('hex');
}

async function collect(root: string, dir: string, out: { rel: string; abs: string }[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && SKIP_NAMES.has(e.name)) continue;
    if (!SKIP_NAMES.has(e.name) && e.isDirectory()) {
      await collect(root, path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push({ rel: path.relative(root, dir).replace(/\\/g, '/') + '/' + e.name, abs: path.join(dir, e.name) });
    }
  }
}

/** Max mtime (ms) across all files in a tree — cache-invalidation signal. */
export async function maxMtimeDir(dir: string): Promise<number> {
  let max = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && SKIP_NAMES.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      max = Math.max(max, await maxMtimeDir(abs));
    } else if (e.isFile()) {
      try {
        const s = await stat(abs);
        max = Math.max(max, s.mtimeMs);
      } catch {
        // vanished — ignore
      }
    }
  }
  return max;
}

/** Stable hash of an MCP server config (sorted keys → JSON → sha256). */
export function hashMcpConfig(config: McpServerConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(stableObj(config)))
    .digest('hex');
}

function stableObj(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stableObj);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = stableObj((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/**
 * LRU-ish in-memory cache for directory hashes. An entry is reused while the
 * directory's max mtime is unchanged; otherwise it is recomputed.
 */
export class FingerprintCache {
  private readonly cache = new Map<string, FingerprintCacheEntry>();

  /** Get the hash for `dir`, recomputing only when its max mtime changed. */
  async get(dir: string): Promise<string> {
    const mtime = await maxMtimeDir(dir);
    const cached = this.cache.get(dir);
    if (cached && cached.maxMtime === mtime) return cached.hash;
    const hash = await hashSkillDir(dir);
    this.cache.set(dir, { maxMtime: mtime, hash });
    return hash;
  }

  /** Force-drop an entry (e.g. after a known write to the directory). */
  invalidate(dir: string): void {
    this.cache.delete(dir);
  }

  clear(): void {
    this.cache.clear();
  }
}
