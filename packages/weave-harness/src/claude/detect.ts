import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Detector } from '../driver.js';

const MARKERS = ['.claude', 'CLAUDE.md'] as const;

function present(dir: string): boolean {
  return MARKERS.some((m) => existsSync(path.join(dir, m)));
}

/** Claude Detector（批 5 实现，markers：`.claude` / `CLAUDE.md`）。 */
export const CLAUDE_DETECTOR: Detector = {
  markers: MARKERS,
  present,
  detect: (dir) => ({ harness: 'claude', present: present(dir) }),
};
