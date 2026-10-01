import { zh } from './zh.js';

/** CLI English dictionary — mirrors zh.ts key-for-key. */
export const en: Record<keyof typeof zh, string> = {
  // --- help output ---
  'help.tagline': 'weave v{version} — Claude Code harness tool',
  'help.usage': 'Usage: weave <command> [options]',
  'help.commands': 'Commands:',
  'help.globalOptions': 'Global options:',
  // --- parse / run errors ---
  'cli.unknownCommand': 'Unknown command: {command}',
  'cli.error': 'Error: {error}',
  'cli.missingRequired': 'Missing required option: --{name}',
  'cli.invalidChoice': 'Invalid value for --{name}: "{value}". Choices: {choices}',
  // --- global options ---
  'flag.help': 'Show help',
  'flag.version': 'Show version',
  'flag.verbose': 'Verbose output',
  'flag.quiet': 'Suppress non-essential output',
  // --- command descriptions ---
  'cmd.init.desc': 'Initialize weave harness in the current project',
  'cmd.status.desc': 'Show current harness status',
  'cmd.daemon.desc': 'Manage the background daemon (start, stop, status)',
  'cmd.daemon.start.desc': 'Start the daemon in the background (no browser — see `weave dashboard`)',
  'cmd.daemon.stop.desc': 'Stop the running daemon',
  'cmd.daemon.status.desc': 'Show daemon status',
  'cmd.dashboard.desc': 'Open the web console in a browser (starts the daemon if needed)',
  'cmd.scan.desc': 'Scan for weave-initialized projects and register them',
  'cmd.statusline.desc': 'Statusline tools (preview TUI)',
  'cmd.statusline.preview.desc': 'Interactive Ink preview of the statusline',
  // --- command option descriptions ---
  'flag.init.preset': 'Configuration preset: minimal, default, or full',
  'flag.init.force': 'Overwrite existing files',
  'flag.init.noInteractive': 'Disable interactive prompts',
  'flag.dir': 'Target directory (default: current directory)',
  'flag.scan.dir': 'Root directory to scan (default: current directory)',
  'flag.dashboard.noOpen': 'Print the dashboard URL without opening a browser',
  'flag.statusline.preview.project': 'Target project path (default: cwd)',
};
