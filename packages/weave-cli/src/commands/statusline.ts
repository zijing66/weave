import { access } from 'node:fs/promises';
import path from 'node:path';
import { runStatuslinePreview } from '../statusline/preview.js';
import type { Command, CommandContext } from '../parser.js';

/**
 * `weave statusline` — statusline tooling.
 *
 * `preview` mounts an Ink TUI that runs the REAL generated script against a
 * sample Claude Code payload and re-renders it on every keystroke: toggle
 * segments, cycle colours/icons, flip powerline/align, then `w` to persist the
 * config and regenerate the script in one shot.
 */
async function previewAction(context: CommandContext): Promise<void> {
  const flagPath = typeof context.flags.project === 'string' ? context.flags.project : undefined;
  const projectPath = path.resolve(flagPath ?? process.cwd());
  try {
    await access(projectPath);
  } catch {
    console.error(`Project path does not exist: ${projectPath}`);
    process.exit(1);
  }
  await runStatuslinePreview(projectPath);
}

export const statuslineCommand: Command = {
  name: 'statusline',
  description: 'Statusline tools (preview TUI)',
  subcommands: [
    {
      name: 'preview',
      description: 'Interactive Ink preview of the statusline',
      options: [
        {
          name: 'project',
          short: 'p',
          description: 'Target project path (default: cwd)',
          type: 'string',
        },
      ],
      action: previewAction,
    },
  ],
};
