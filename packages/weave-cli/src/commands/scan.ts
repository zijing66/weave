import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerProject } from '@weave/server';
import { logger } from '@weave/core';
import { t } from '../i18n/index.js';
import type { Command } from '../parser.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache']);

/** Recursively find directories that carry a weave/claude harness marker. */
async function findProjectDirs(root: string, depth = 0, maxDepth = 6): Promise<string[]> {
  if (depth > maxDepth) return [];
  if (existsSync(join(root, '.weave')) || existsSync(join(root, '.claude'))) {
    return [root];
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    results.push(...(await findProjectDirs(join(root, entry.name), depth + 1, maxDepth)));
  }
  return results;
}

export const scanCommand: Command = {
  name: 'scan',
  description: 'cmd.scan.desc',
  options: [
    {
      name: 'dir',
      short: 'd',
      description: 'flag.scan.dir',
      type: 'string',
      default: process.cwd(),
    },
  ],

  async action(ctx) {
    const root = String(ctx.flags.dir ?? process.cwd());
    const found = await findProjectDirs(root);

    for (const dir of found) {
      registerProject(dir, 'scan');
    }

    logger.success(t('out.scan.registered', { count: found.length, root }));
    if (found.length > 0) {
      for (const dir of found) logger.dim(`  ${dir}`);
    }
  },
};
