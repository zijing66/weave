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
  'cmd.uninstall.desc': 'Remove weave init outputs (reset the init commit when it is HEAD, otherwise commit the removal)',
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
  'flag.init.hooks':
    'Comma-separated hook events to register (preToolUse,postToolUse,userPromptSubmit,sessionStart,stop,subagentStop,notification); "none" registers none; default: all',
  'flag.init.harness':
    'Comma-separated harness surfaces to initialize (claude, codex); omitted → interactive multiselect on a TTY, default claude',
  'flag.dir': 'Target directory (default: current directory)',
  'flag.scan.dir': 'Root directory to scan (default: current directory)',
  'flag.dashboard.noOpen': 'Print the dashboard URL without opening a browser',
  'flag.statusline.preview.project': 'Target project path (default: cwd)',
  // --- daemon command output ---
  'out.daemon.alreadyRunning': 'Daemon already running on port {port}',
  'out.daemon.started': 'Daemon started on http://{host}:{port}',
  'out.daemon.noState': 'No daemon state found — daemon is not running.',
  'out.daemon.stopped': 'Daemon stopped (pid {pid}).',
  'out.daemon.statusNotRunning': 'Daemon: not running',
  'out.daemon.statusRunning': 'Daemon: running (pid {pid}, port {port}, up {uptime}s)',
  'out.daemon.statusStale': 'Daemon: stale state (pid {pid}, port {port} not responding)',
  // --- dashboard command output ---
  'out.dash.browserFailed': '(could not launch a browser automatically — open it manually)',
  'out.dash.stopHint': 'Stop it later with `weave daemon stop`.',
  'out.dash.noBundle': 'The web bundle is not built, so the daemon has nothing to serve.',
  'out.dash.buildHint':
    '  Build it with `pnpm build:web`, or run the Vite dev server: `pnpm dev:web` (http://localhost:9527).',
  'out.dash.url': '\n  Dashboard: {url}\n',
  'out.dash.noOpen': '  (--no-open: not launching a browser)',
  // --- scan command output ---
  'out.scan.registered': 'Registered {count} project(s) from {root}',
  // --- uninstall command runtime output ---
  'out.uninstall.banner': 'Uninstalling weave: {target}',
  'out.uninstall.notInitialized': 'No .weave/ found — this project is not initialized, nothing to uninstall.',
  'out.uninstall.done': 'Uninstalled: removed {files} file(s), {dirs} directorie(s)',
  'out.uninstall.modified': 'Rewrote {count} file(s) (weave-added keys/sections stripped)',
  'out.uninstall.keptUser': 'Kept {count} generated-location file(s) that differ from weave sources (likely user-edited):',
  'out.uninstall.restored': 'Restored the AGENTS.md displaced by init (from .weave/backup/)',
  'out.uninstall.gitReset': 'The init commit was HEAD — pointer rolled back to {sha}, history clean',
  'out.uninstall.gitCommit': 'Created removal commit {sha} ({count} file(s))',
  'out.uninstall.gitNoChanges': 'No tracked weave files changed — nothing committed',
  'out.uninstall.gitDirty': 'Index not empty — files cleaned, git skipped to avoid touching staged content',
  'out.uninstall.gitNotRepo': 'Not inside a git repository — files cleaned only',
  'out.uninstall.gitFailed': 'git failed: {error} (files are already cleaned)',
  'out.uninstall.serverRemoved':
    'Unregistered project {name} from the weave server (purged {events} events / {dispatches} dispatches / {sessions} sessions)',
  'out.uninstall.serverFailed': 'Failed to unregister from the weave server: {error}',
  // --- uninstall internal warns ---
  'uninstall.pluginScanFailed': 'Plugin template scan failed (that part skipped): {error}',
  // --- status command output ---
  'out.status.notInitialized': 'Weave not initialized. Run `weave init` first.',
  'out.status.header': '\n  Weave Harness Status\n',
  'out.status.col.version': 'Version',
  'out.status.col.initialized': 'Initialized',
  'out.status.col.preset': 'Preset',
  'out.status.col.harness': 'Harness',
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
  'init.pluginMcpRenamed': 'Plugin MCP server name conflict, prefixed: {renamed}',
  'init.proceed': 'Proceed? [Y/n]',
  'init.commit.question': 'Commit the outputs of this init as a single commit?',
  'init.commit.detail': 'Will commit: {paths}',
  'init.commit.preStaged': 'Staged changes already present — skipping the auto-commit (to avoid sweeping in unrelated edits).',
  'init.commit.pathIgnored': 'Ignored by .gitignore, not added: {paths}',
  'init.commit.failed': 'Commit failed: {error}',
  'init.commit.done': 'Created commit {sha} ({count} files)',
  'init.hooksUnknownKeys': 'Ignored unknown hook event names: {keys}',
  'init.harnessUnknownKeys': 'Ignored unknown harness name(s): {keys}',
  'init.multiselect.title': 'Select harnesses to initialize (multiple allowed):',
  'init.multiselect.hint': 'Enter numbers or names (comma-separated), or press Enter for {defaults}:',
  'init.multiselect.invalid': 'Ignored unrecognized selection(s): {keys}',
  'init.noPeerFace': 'no equivalent surface',
  'init.stepSkipped': 'Skipped {step}: {reason}',
  'init.removed': '  Removed {count} stale generated file(s) by marker.\n',
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
