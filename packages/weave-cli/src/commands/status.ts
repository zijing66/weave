import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, logger, formatTable } from '@weave/core';
import { checkHarness } from '../init/harness-checks.js';
import type { Command } from '../parser.js';

/** Read the runtime config YAML and display harness status */
async function readRuntimeConfig(targetDir: string): Promise<Record<string, string> | null> {
  const configPath = path.join(targetDir, '.weave', 'config.yaml');
  if (!(await fileExists(configPath))) return null;

  try {
    const raw = await readFile(configPath, 'utf-8');
    const result: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return result;
  } catch {
    return null;
  }
}

async function checkFile(relPath: string, targetDir: string): Promise<'present' | 'missing'> {
  const exists = await fileExists(path.join(targetDir, relPath));
  return exists ? 'present' : 'missing';
}

export const statusCommand: Command = {
  name: 'status',
  description: 'Show current harness status',
  options: [
    {
      name: 'dir',
      short: 'd',
      description: 'Target directory (default: current directory)',
      type: 'string',
      default: process.cwd(),
    },
  ],

  async action(ctx) {
    const targetDir = String(ctx.flags.dir ?? process.cwd());
    const config = await readRuntimeConfig(targetDir);

    if (!config) {
      logger.warn('Weave not initialized. Run `weave init` first.');
      return;
    }

    logger.info('\n  Weave Harness Status\n');

    const entries: [string, string][] = [
      ['Version', config.initVersion ?? 'unknown'],
      ['Initialized', config.initTimestamp ?? 'unknown'],
      ['Preset', config.preset ?? 'unknown'],
      ['CLAUDE.md', await checkFile('CLAUDE.md', targetDir)],
      ['settings.json', await checkFile('.claude/settings.json', targetDir)],
      ['.mcp.json', await checkFile('.mcp.json', targetDir)],
      ['helpers', await checkFile('.claude/helpers', targetDir)],
      ['skills', await checkFile('.claude/skills', targetDir)],
      ['commands', await checkFile('.claude/commands', targetDir)],
      ['agents', await checkFile('.claude/agents', targetDir)],
    ];

    console.log(formatTable(entries));
    console.log();

    // Health checks run after the table so the summary stays readable; they
    // cover the failure modes that are invisible until something downstream
    // misbehaves (a symlink checked out as text, a stale absolute path).
    const issues = await checkHarness(targetDir);
    if (issues.length > 0) {
      logger.warn(`  ${issues.length} issue(s) found:\n`);
      for (const issue of issues) {
        logger.warn(`    - ${issue.message}`);
        logger.dim(`      fix: ${issue.fix}`);
      }
      console.log();
    }
  },
};
