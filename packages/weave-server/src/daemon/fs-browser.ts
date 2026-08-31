import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Where a browse root comes from — the frontend maps each kind to a label/icon. */
export type BrowseRootKind =
  | 'home'
  | 'desktop'
  | 'downloads'
  | 'documents'
  | 'library-parent'
  | 'drive'
  | 'root';

export interface BrowseRoot {
  path: string;
  kind: BrowseRootKind;
}

export interface BrowseChild {
  name: string;
  path: string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Module-level drive cache: probing mapped network drives can take seconds,
 * and the list barely changes over a daemon's lifetime. */
let driveCache: { at: number; drives: string[] } | null = null;
const DRIVE_CACHE_TTL_MS = 5 * 60_000;

/** Enumerate Windows drive roots by probing A:\..Z:\ in parallel. A drive that
 * answers within the timeout (local disks reply instantly; slow network
 * mounts may not) is listed; each probe is independent, so one slow NAS drive
 * can only ever delay the whole call by its own timeout. */
async function listWindowsDrives(): Promise<string[]> {
  if (driveCache && Date.now() - driveCache.at < DRIVE_CACHE_TTL_MS) {
    return driveCache.drives;
  }
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const probed = await Promise.all(
    letters.map(async (letter) => {
      const drivePath = `${letter}:\\`;
      try {
        await withTimeout(stat(drivePath), 4000);
        return drivePath;
      } catch {
        return null;
      }
    }),
  );
  const drives = probed.filter((d): d is string => d !== null);
  driveCache = { at: Date.now(), drives };
  return drives;
}

/** Cross-platform browse starting points for the directory picker: the user's
 * home area, the parents of already-registered libraries, and every drive (or
 * `/` on POSIX). */
export async function listBrowseRoots(libraryPaths: string[]): Promise<BrowseRoot[]> {
  const out: BrowseRoot[] = [];
  const seen = new Set<string>();
  const push = (p: string, kind: BrowseRootKind): void => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push({ path: p, kind });
    }
  };

  const home = os.homedir();
  push(home, 'home');
  const homeSubs: [string, BrowseRootKind][] = [
    ['Desktop', 'desktop'],
    ['Downloads', 'downloads'],
    ['Documents', 'documents'],
  ];
  for (const [sub, kind] of homeSubs) {
    const p = path.join(home, sub);
    try {
      await stat(p);
      push(p, kind);
    } catch {
      // not present (redirected or localized profile) — skip
    }
  }

  for (const libPath of libraryPaths) {
    if (typeof libPath === 'string' && libPath) {
      push(path.dirname(libPath), 'library-parent');
    }
  }

  if (process.platform === 'win32') {
    for (const d of await listWindowsDrives()) push(d, 'drive');
  } else {
    push(path.parse(home).root, 'root');
  }
  return out;
}

/** Subdirectories of a folder, sorted by name (numeric-aware). Throws on
 * unreadable/nonexistent paths — the route layer maps that to a 4xx. */
export async function listDirectoryChildren(dirPath: string): Promise<BrowseChild[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const children = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(dirPath, e.name) }));
  children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return children;
}
