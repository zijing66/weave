import { HARNESS_DIRS, HARNESS_KEYS } from '@weavecode/core';
import { zh } from './zh.js';

/** CLI English dictionary — mirrors zh.ts key-for-key. */
export const en: Record<keyof typeof zh, string> = {
  // --- help output ---
  'help.tagline': 'weave v{version} — Harness tool',
  'help.usage': 'Usage: weave <command> [options]',
  'help.commands': 'Commands:',
  'help.globalOptions': 'Global options:',
  'help.subcommands': 'Available subcommands:',
  // --- parse / run errors ---
  'cli.unknownCommand': 'Unknown command: {command}',
  'cli.error': 'Error: {error}',
  'cli.missingRequired': 'Missing required option: --{name}',
  'cli.invalidChoice': 'Invalid value for --{name}: "{value}". Choices: {choices}',
  'cli.missingSubcommand': 'Command {command} requires a subcommand',
  'cli.unknownSubcommand': 'Unknown subcommand: {command} {subcommand}',
  'cli.unexpectedPositional': 'Command {command} does not accept argument "{arg}"',
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
  'cmd.mcp.desc': 'Expose weave capabilities as a built-in MCP server (stdio)',
  'cmd.mcp.orchestration.desc': 'Orchestration MCP: list/get/create/update/trigger/runs (proxies the daemon API)',
  'cmd.chpass.desc': 'Change the dashboard login password (new password given; no old password needed locally)',
  'cmd.scan.desc': 'Scan for weave-initialized projects and register them',
  'cmd.doctor.desc': 'Diagnose local wiring: is this checkout registered with the local weave server',
  // --- command option descriptions ---
  'flag.init.preset': 'Configuration preset: minimal, default, or full',
  'flag.init.force': 'Overwrite existing files',
  'flag.init.noInteractive': 'Disable interactive prompts',
  'flag.init.hooks':
    'Comma-separated hook events to register (preToolUse,postToolUse,userPromptSubmit,sessionStart,stop,stopFailure,subagentStop,subagentStart,notification,postToolUseFailure,permissionRequest,permissionDenied,preCompact,sessionEnd,preModelSwitch); "none" registers none; default: all',
  'flag.init.harness': `Comma-separated harness surfaces to initialize (${HARNESS_KEYS.join(', ')}); omitted → interactive multiselect on a TTY, default ${HARNESS_KEYS[0]}`,
  'flag.dir': 'Target directory (default: current directory)',
  'flag.scan.dir': 'Root directory to scan (default: current directory)',
  'flag.dashboard.noOpen': 'Print the dashboard URL without opening a browser',
  // --- daemon command output ---
  'out.daemon.alreadyRunning': 'Daemon already running on port {port}',
  'out.daemon.started': 'Daemon started on http://{host}:{port}',
  'out.daemon.stopped': 'Daemon stopped (pid {pid}).',
  'out.daemon.statusNotRunning': 'Daemon: not running',
  'out.daemon.statusRunning': 'Daemon: running (pid {pid}, port {port}, up {uptime}s)',
  'out.daemon.urlsTitle': 'Access URLs:',
  'out.daemon.statusStale': 'Daemon: stale state (pid {pid}, port {port} not responding)',
  // --- doctor command output ---
  'out.doctor.header': '\n  Weave Doctor — local wiring\n',
  'out.doctor.dir': 'directory',
  'out.doctor.initialized': 'initialized',
  'out.doctor.yes': 'yes',
  'out.doctor.no': 'no',
  'out.doctor.daemon': 'daemon',
  'out.doctor.daemonRunning': 'running on port {port}',
  'out.doctor.daemonStopped': 'not running',
  'out.doctor.registered': 'registered',
  'out.doctor.registeredYes': 'yes (id {id}, source {source})',
  'out.doctor.registeredNo': 'no — this checkout is not in the local registry',
  'out.doctor.registeredArchived': 'archived (id {id})',
  'out.doctor.token': 'token',
  'out.doctor.tokenOk': 'ok',
  'out.doctor.tokenMissing': 'missing (.weave/token absent)',
  'out.doctor.tokenUnregistered': 'present, but the project is not registered',
  'out.doctor.tokenStale': 'stale — differs from the registry token',
  'out.doctor.warnNotRegistered':
    'This project carries weave files but is not registered with the local weave server.',
  'out.doctor.fixInit':
    'Run `weave init` to (re)register this checkout, refresh harness files, and rewrite local paths.',
  'out.doctor.fixScan': 'Or `weave scan -d <parent>` to discover and register projects in bulk.',
  'out.doctor.warnArchived':
    'This project is registered but archived — restore it from the dashboard to use it again.',
  'out.doctor.warnTokenMissing':
    'Registered, but `.weave/token` is missing — hooks cannot authenticate until it is regenerated.',
  'out.doctor.warnTokenStale':
    'Registered, but `.weave/token` belongs to another checkout — regenerate it.',
  'out.doctor.ok': 'OK — this checkout is registered and its token matches.',
  'out.doctor.fixDaemon':
    'The daemon is not running; start it with `weave daemon start` when you need collection.',
  // --- doctor delivery-diagnostics section (GET /messaging/diagnostics) ---
  'out.doctor.diagHeader': '\n  Weave Doctor — message delivery (project #{id})\n',
  'out.doctor.diagFailed':
    'Delivery diagnostics unavailable ({error}) — the daemon refused, the local token is wrong, or the daemon predates this route.',
  'out.doctor.diagDaemon': 'daemon',
  'out.doctor.diagDaemonValue': 'v{version} · {platform} · terminal preset {preset} {channel}',
  'out.doctor.diagChannelOn': '(text-injection channel present)',
  'out.doctor.diagChannelOff': '(no text-injection channel)',
  'out.doctor.diagScript': 'capture script',
  'out.doctor.diagScriptNone': 'absent — no weave-generated hook script (run `weave init`)',
  'out.doctor.diagScriptNotOwned':
    'the {source}-level script is not weave-generated (weave neither refreshes nor trusts it; `weave init --force` overwrites)',
  'out.doctor.diagScriptValue':
    '{harness} · {source} level · version {version} · reports credentials {inbox} · reports pane {pane}',
  'out.doctor.diagSourceUser': 'user',
  'out.doctor.diagSourceProject': 'project',
  'out.doctor.diagSourceNone': 'none',
  'out.doctor.diagYes': 'yes',
  'out.doctor.diagNo': 'no',
  'out.doctor.diagMissing': '—',
  'out.doctor.diagUnknownAlive': 'undecidable',
  'out.doctor.diagUntitled': 'untitled',
  'out.doctor.diagNoSessions': 'Nothing to diagnose — no session is alive right now.',
  'out.doctor.diagReady': 'ready',
  'out.doctor.diagUnavailable': 'unavailable ({reason})',
  'out.doctor.diagUnknown': 'undecidable ({reason})',
  'out.doctor.diagSession': '{id} "{title}"  alive {alive} · events {events} · last {last}',
  'out.doctor.diagChannels': 'inbox {inbox}   queue {queue}   relay {relay}   terminal {terminal}',
  'out.doctor.diagQueue': 'queue {pending} · stalled {stalled}',
  'out.doctor.diagHints': 'fix: {hints}',
  'out.doctor.reason.noMechanism': 'this harness has no such mechanism',
  'out.doctor.reason.noCredentials': 'no credentials',
  'out.doctor.reason.authTokenRequired': 'this platform needs credentials and the host gave none',
  'out.doctor.reason.noPeerName': 'no peer name in the registry',
  'out.doctor.reason.noBackend': 'this terminal preset has no text-injection backend',
  'out.doctor.reason.noPaneEnv': 'no pane locator was reported',
  'out.doctor.hint.noHookScript': 'no weave-generated hook script → run `weave init`',
  'out.doctor.hint.hookScriptNotWeave':
    'the hook script is not weave-generated (weave neither refreshes nor trusts it) → move it aside, or `weave init --force`',
  'out.doctor.hint.hookScriptStale':
    'the hook script was generated by an older weave and does not report delivery credentials → re-run `weave init`, then restart the session',
  'out.doctor.hint.noEvents':
    'this session has no hook events at all (started before init? the script never ran?)',
  'out.doctor.hint.noInboxCredentials':
    'the script can report, yet this session never did (the host exports no messaging socket env, or the session predates the script) → restart the session',
  'out.doctor.hint.inboxTokenRequired':
    'inbox delivery needs a token on this platform; the host exports no messaging token env',
  'out.doctor.hint.noPeerName':
    'this session has no peer name — the relay addresses sessions by name and skips nameless ones',
  'out.doctor.hint.terminalNoBackend':
    'this terminal preset cannot inject text → wezterm is what gives layer ② a fallback',
  'out.doctor.hint.terminalNoPaneEnv':
    'no pane locator was reported (this terminal exports no WEZTERM_*) → only the title+cwd fallback is left',
  'out.doctor.hint.notRunning':
    'the session process is gone (messages settle as failed/offline, they never queue)',
  'out.doctor.hint.queued': 'the queue still holds backlog',
  'out.doctor.hint.stalled':
    'the ack gate is set (no receipt in time, or delivery failed) → resend, or wait for the receipt',
  // --- dashboard command output ---
  'out.dash.browserFailed': '(could not launch a browser automatically — open it manually)',
  'out.dash.stopHint': 'Stop it later with `weave daemon stop`.',
  'out.dash.noBundle': 'The web bundle is not built, so the daemon has nothing to serve.',
  'out.dash.buildHint':
    '  Build it with `pnpm build:web`, or run the Vite dev server: `pnpm dev:web` (http://localhost:9527).',
  'out.dash.url': '\n  Dashboard: {url}\n',
  'out.dash.noOpen': '  (--no-open: not launching a browser)',
  'out.dash.initialPassword':
    '\n  Initial login password: {password}\n  (shown only once; change it with `weave chpass <new password>`)\n',
  // --- chpass command runtime output ---
  'out.chpass.ok': 'Dashboard login password updated — signed-in browsers must log in again.',
  'out.chpass.fail': 'Failed to change password: {error}',
  'out.chpass.usage': 'Usage: weave chpass <new password> (at least 6 characters)',
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
  // --- init flow output and table headers ---
  'init.banner': '\n  Weave — coding-agent harness v0.1.0\n',
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
  'init.userCaptureActive':
    'User-scope capture is installed — skipping project hooks (weave groups swept)',
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
  // --- CLAUDE.md managed block (generated per locale) ---
  'claudemd.rules': '## Behavioral Rules\n\n- Follow existing code conventions and patterns in this project\n- Prefer editing existing files over creating new ones\n- Don\'t add features, refactor, or introduce abstractions beyond the task\n- Three similar lines is better than a premature abstraction\n- Write no comments unless the WHY is non-obvious\n- Never write multi-paragraph explanations in code\n- Don\'t add error handling for states that can\'t happen\n\n',
  'claudemd.files': '## File Organization\n\n- Source code: `src/`\n- Tests: co-located `*.test.ts` or `__tests__/` directories\n- Config files at project root\n- Use existing directory structure — don\'t invent new top-level folders\n\n',
  'claudemd.security': '## Security\n\n- Never commit secrets, credentials, or API keys\n- Validate all user input at system boundaries\n- Don\'t introduce XSS, SQL injection, or command injection vectors\n- Prefer parameterized queries and safe APIs over string concatenation\n\n',
  'claudemd.skills': '## Skills\n\nReusable skills live in your harness\'s own skills directory (Claude Code: `.claude/skills/`): one directory per skill, each with a `SKILL.md`; invoke a skill by name when the task matches one.\n\n',
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
  'harness.statuslinePathUnresolved.fix': `Run \`weave init\` to regenerate \`${HARNESS_DIRS[HARNESS_KEYS[0]].projectDir}/settings.json\`.`,
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
};
