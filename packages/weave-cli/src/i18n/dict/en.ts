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
  // --- daemon command output ---
  'out.daemon.alreadyRunning': 'Daemon already running on port {port}',
  'out.daemon.started': 'Daemon started on http://{host}:{port}',
  'out.daemon.token': 'Token: {token}',
  'out.daemon.noState': 'No daemon state found — daemon is not running.',
  'out.daemon.stopped': 'Daemon stopped (pid {pid}).',
  'out.daemon.statusNotRunning': 'Daemon: not running',
  'out.daemon.statusRunning': 'Daemon: running (pid {pid}, port {port}, up {uptime}s)',
  'out.daemon.statusStale': 'Daemon: stale state (pid {pid}, port {port} not responding)',
  // --- dashboard command output ---
  'out.dash.browserFailed': '(could not launch a browser automatically — open it manually)',
  'out.dash.stopHint': 'Stop it later with `weave daemon stop`.',
  'out.dash.tokenUnknown':
    'A daemon is running on the default port but its token is unknown, so the console cannot authenticate.',
  'out.dash.restartHint': '  Restart it with `weave daemon stop` then `weave dashboard`.',
  'out.dash.noBundle': 'The web bundle is not built, so the daemon has nothing to serve.',
  'out.dash.buildHint':
    '  Build it with `pnpm build:web`, or run the Vite dev server: `pnpm dev:web` (http://localhost:9527).',
  'out.dash.url': '\n  Dashboard: {url}\n',
  'out.dash.noOpen': '  (--no-open: not launching a browser)',
  // --- scan command output ---
  'out.scan.registered': 'Registered {count} project(s) from {root}',
  // --- status command output ---
  'out.status.notInitialized': 'Weave not initialized. Run `weave init` first.',
  'out.status.header': '\n  Weave Harness Status\n',
  'out.status.col.version': 'Version',
  'out.status.col.initialized': 'Initialized',
  'out.status.col.preset': 'Preset',
  'out.status.unknown': 'unknown',
  'out.status.present': 'present',
  'out.status.missing': 'missing',
  'out.status.issuesFound': '  {count} issue(s) found:\n',
  'out.status.issue': '    - {message}',
  'out.status.fix': '      fix: {fix}',
  // --- statusline command output ---
  'out.statusline.pathMissing': 'Project path does not exist: {path}',
  // --- init flow output and table headers ---
  'init.banner': '\n  Weave — Claude Code harness v0.1.0\n',
  'init.presetTarget': '  Preset: {preset}  |  Target: {target}\n',
  'init.failed': '\n  Init failed: {error}\n',
  'init.complete': '\n  Init complete\n',
  'init.table.directories': 'Directories',
  'init.table.filesCreated': 'Files created',
  'init.table.filesMerged': 'Files merged',
  'init.table.weaveUpdated': 'Weave files updated',
  'init.table.skills': 'Skills',
  'init.table.commands': 'Commands',
  'init.table.agents': 'Agents',
  'init.merged': '  Merged {count} existing file(s) — your content was preserved.\n',
  'init.refreshed': '  Refreshed {count} weave-owned file(s).\n',
  'init.skipped': '  Skipped {count} existing file(s). Use --force to overwrite.\n',
  'init.completedWithErrors': '\n  Init completed with errors\n',
  'init.errorLine': '    - {error}',
  'init.nonInteractive': 'Running in non-interactive mode',
  'init.skippedInvalidJson':
    'Skipped {path}: not valid JSON. Fix or remove it, or use --force.',
  'init.backedUp': 'Backed up the previous AGENTS.md to {path}',
  'init.copyTemplatesFailed': 'Could not copy templates from {srcDir}: {error}',
  'init.proceed': 'Proceed? [Y/n]',
  // --- harness health-check message / fix ---
  'harness.instructionLinkNotMaterialised.message':
    '{agents} is a plain file containing "{claude}" — git checked the symlink out as text.',
  'harness.instructionLinkNotMaterialised.fix':
    'Enable Developer Mode, then run `git config core.symlinks true` and re-checkout the file.',
  'harness.instructionFilesDuplicated.message':
    '{claude} and {agents} are both regular files — they will drift apart.',
  'harness.instructionFilesDuplicated.fix':
    'Run `weave init` to link one to the other (the displaced file is backed up).',
  'harness.instructionLinkDangling.message': '{name} is a symlink whose target does not exist.',
  'harness.instructionLinkDangling.fix':
    'Run `weave init` to rewrite the link and the instruction file.',
  'harness.statuslinePathUnresolved.message':
    'statusLine command does not resolve to a script path: {command}',
  'harness.statuslinePathUnresolved.fix': 'Run `weave init` to regenerate `.claude/settings.json`.',
  'harness.statuslinePathForeign.message':
    'statusLine points outside this project ({path}) — it was generated for another checkout.',
  'harness.statuslinePathForeign.fix':
    'Run `weave init` in this project to rewrite the absolute path.',
  'harness.statuslineScriptMissing.message': 'statusLine script is missing: {path}',
  'harness.statuslineScriptMissing.fix': 'Run `weave init` to regenerate it.',
  // --- instruction-link confirm / error copy ---
  'ilink.bothHaveContent': 'CLAUDE.md and AGENTS.md both contain content',
  'ilink.replaceDetail':
    'AGENTS.md will be replaced with a symlink to CLAUDE.md (the original is backed up to {backupDir}).',
  'ilink.linkFailed': 'Could not create {link} -> {target} ({path}): {detail}',
  'ilink.symlinkNotAllowed':
    'this system does not allow symlinks without elevation. On Windows, enable Developer Mode (Settings > System > For developers) or run weave init from an elevated shell, then retry.',
  // --- statusline preview TUI ---
  'preview.saved': 'Wrote config and regenerated the statusline script',
  'preview.writeFailed': 'Write failed: {error}',
  'preview.unsaved': ' ●unsaved',
  'preview.scriptError': 'script error: {error}',
  'preview.scriptExit': 'exit {status}',
  'preview.rendering': 'rendering…',
  'preview.layoutHelp': 'layout — ↑↓←→ move · space toggle',
  'preview.rowLabel': 'row {row}  ',
  'preview.editConfirm': ' Enter confirm · Esc cancel',
  'preview.headerMeta':
    'source: {source} · refresh: {refresh}s · align: {align} · powerline: {powerline}',
  'preview.on': 'on',
  'preview.off': 'off',
  'preview.segDetail': 'color {color} · bold {bold} · merge {merge} · icon {icon}{style}',
  'preview.styleSuffix': ' · style {style}',
  'preview.labelValue': 'label {value}',
  'preview.formatValue': 'format {value}',
  'preview.barLine': 'bar {cells} cells {glyphs} · labelSep {labelSep}',
  'preview.keysHelp':
    'keys: c color · b bold · m merge · i icon · v context style · n label · f format · [ ] bar cells · B bar glyph · L label separator · a align · p powerline · g powerline separator · l logo color · s separator · r re-render · w write · q quit',
  'preview.reRendered': 're-rendered',
  'preview.writing': 'writing…',
};
