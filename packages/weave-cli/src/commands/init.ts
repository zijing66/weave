import {
  type Preset,
  PresetSchema,
  logger,
  formatTable,
  resolveComponents,
} from '@weave/core';
import { executeInit } from '../init/executor.js';
import type { Command } from '../parser.js';

export const initCommand: Command = {
  name: 'init',
  description: 'Initialize weave harness in the current project',
  options: [
    {
      name: 'preset',
      short: 'p',
      description: 'Configuration preset: minimal, default, or full',
      type: 'string',
      default: 'default',
      choices: ['minimal', 'default', 'full'],
    },
    {
      name: 'force',
      short: 'f',
      description: 'Overwrite existing files',
      type: 'boolean',
      default: false,
    },
    {
      name: 'no-interactive',
      description: 'Disable interactive prompts',
      type: 'boolean',
      default: false,
    },
    {
      name: 'dir',
      short: 'd',
      description: 'Target directory (default: current directory)',
      type: 'string',
      default: process.cwd(),
    },
  ],

  async action(ctx) {
    const preset = PresetSchema.parse(ctx.flags.preset ?? 'default') as Preset;
    const force = Boolean(ctx.flags.force);
    const interactive = !Boolean(ctx.flags['noInteractive']);
    const targetDir = String(ctx.flags.dir ?? process.cwd());

    logger.info(`\n  Weave — Claude Code harness v0.1.0\n`);
    logger.dim(`  Preset: ${preset}  |  Target: ${targetDir}\n`);

    const components = resolveComponents(preset);

    const result = await executeInit({
      targetDir,
      force,
      interactive,
      preset,
      components,
      hooks: {},
      skills: {},
      commands: {},
      agents: {},
      mcp: {},
    });

    // Output summary
    if (result.success) {
      logger.success('\n  Init complete\n');

      const entries: [string, string][] = [
        ['Directories', String(result.created.directories.length)],
        ['Files created', String(result.created.files.length)],
        ['Skills', String(result.summary.skillsCount)],
        ['Commands', String(result.summary.commandsCount)],
        ['Agents', String(result.summary.agentsCount)],
      ];
      console.log(formatTable(entries));
      console.log();

      if (result.skipped.length > 0) {
        logger.dim(`  Skipped ${result.skipped.length} existing file(s). Use --force to overwrite.\n`);
      }
    } else {
      logger.error('\n  Init completed with errors\n');
      for (const err of result.errors) {
        logger.error(`    - ${err}`);
      }
    }
  },
};
