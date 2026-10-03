import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Resolve the built SPA directory (web/dist, 原 weave-web 并入 · 批 W) relative
 * to this module.
 *
 * This file lives at packages/weave-server/{src,dist}/daemon/, so two levels
 * up reaches weave-server/ and web/dist sits inside it. Returns undefined when
 * the bundle hasn't been built (e.g. dev mode uses Vite's own server, so static
 * hosting simply isn't available).
 */
export function resolveStaticDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, '../../web/dist');
  return existsSync(dir) ? dir : undefined;
}
