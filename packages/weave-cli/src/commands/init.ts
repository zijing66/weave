import {
  type Preset,
  PresetSchema,
  logger,
  formatTable,
  resolveComponents,
} from '@weave/core';
import { executeInit } from '../init/executor.js';
import { registerProject } from '@weave/server';
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

    let result;
    try {
      result = await executeInit({
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
    } catch (err) {
      // A hard failure (e.g. the platform refuses to create the instruction
      // symlink) must fail loudly rather than leave a half-configured project.
      logger.error(`\n  Init failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    // Output summary
    if (result.success) {
      registerProject(targetDir, 'init');
      logger.success('\n  Init complete\n');

      const entries: [string, string][] = [
        ['Directories', String(result.created.directories.length)],
        ['Files created', String(result.created.files.length)],
        ['Files merged', String(result.merged.length)],
        ['Weave files updated', String(result.updated.length)],
        ['Skills', String(result.summary.skillsCount)],
        ['Commands', String(result.summary.commandsCount)],
        ['Agents', String(result.summary.agentsCount)],
      ];
      console.log(formatTable(entries));
      console.log();

      if (result.merged.length > 0) {
        logger.dim(`  Merged ${result.merged.length} existing file(s) — your content was preserved.\n`);
      }
      if (result.updated.length > 0) {
        logger.dim(`  Refreshed ${result.updated.length} weave-owned file(s).\n`);
      }
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
