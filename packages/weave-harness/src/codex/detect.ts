import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Detector } from '../driver.js';

const MARKERS = ['.codex', 'AGENTS.md'] as const;

function present(dir: string): boolean {
  return MARKERS.some((m) => existsSync(path.join(dir, m)));
}

/** Codex Detector（批 5 实现，markers：`.codex` / `AGENTS.md`）。 */
export const CODEX_DETECTOR: Detector = {
  markers: MARKERS,
  present,
  detect: (dir) => ({ harness: 'codex', present: present(dir) }),
};
