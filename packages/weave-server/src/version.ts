import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The version baked into artifacts weave generates — derived from this
 * package's package.json at module load, so there is exactly one source of
 * truth (bump package.json, everything follows: the statusline logo, the
 * helper scripts' `@version`, the daemon handshake, init's `initVersion`).
 *
 * `../package.json` resolves identically from src/ and dist/ (npm always
 * ships package.json alongside); falls back to '0.0.0' only if the file is
 * unreadable, which callers already tolerate.
 */

function readOwnVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const WEAVE_VERSION = readOwnVersion();
