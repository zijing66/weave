import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import type { CommandExecution, CommandsSurface, HarnessCommand } from '../driver.js';
import { execCli as claudeExec, type PluginExecutor } from './plugins.js';
import { readNewLines, transcriptSize, type LineCursor } from './transcript-cursor.js';

/**
 * Claude Code 的斜杠命令：`/` 提示的候选清单 + 命令执行的返显。
 *
 * 三类来源，判据各归各的目录：
 * - **内建命令**：宿主自己的 TUI 命令，没有目录可扫 ⇒ 本文件一张版本快照表
 *   （`/help` 在宿主里可自查；升级宿主后按它复核这张表）。
 * - **自定义命令**：`.claude/commands/**\/*.md`（项目 + 用户级），文件名即命令名，
 *   子目录变成命名空间（`db/migrate.md` → `/db:migrate`）。
 * - **skill**：`skills/<name>/SKILL.md`（项目 + 用户），以及**已启用插件**的
 *   skill（按 `<plugin>:<skill>` 命名，宿主里就是这么敲的）。插件这一档优先走
 *   官方口径 `claude plugin list --json`：只有 `enabled` 的插件才可选——缓存目录
 *   里躺着的停用插件不该出现在候选里；CLI 拿不到（老版本/异常）才退回扫缓存。
 *
 * 返显走转录：内建命令**不发 UserPromptSubmit**（`/compact` 只有 PreCompact），
 * 但它会在转录里留 `<command-name>` + 紧随的 `<local-command-stdout>`。skill/插件
 * 命令不发 stdout（它们展开成 prompt，走 UPS，对话里已有气泡）⇒ 只认带 stdout 的，
 * 天然不会重复。
 */

/**
 * 内建命令快照——自 claude 2.1.296 宿主二进制的命令注册表提取（type:local-jsx/local/prompt
 * 且非 isHidden 的可见项；动态描述取其基础文案）。宿主升级后复核这张表。
 */
const BUILTINS: readonly HarnessCommand[] = [
  { name: 'add-dir', description: 'Add a new working directory', argsHint: '[<path>]', source: 'builtin' },
  { name: 'artifacts', description: 'Browse your published and shared artifacts', source: 'builtin' },
  { name: 'auto-mode-setup', description: 'Teach auto mode about your environment, plus optional rule tweaks', source: 'builtin' },
  { name: 'autocompact', description: 'Set how full the context gets before auto-summarizing', argsHint: '[auto|<tokens>]', source: 'builtin' },
  { name: 'background', description: 'Send this session to the background and free the terminal', argsHint: '[prompt]', source: 'builtin' },
  { name: 'branch', description: 'Create a branch of the current conversation at this point', argsHint: '[name]', source: 'builtin' },
  { name: 'brief', description: 'Toggle brief-only mode', source: 'builtin' },
  { name: 'btw', description: 'Ask a quick side question without interrupting the main conversation', argsHint: '[question]', source: 'builtin' },
  { name: 'bug', description: 'Report a bug or share your conversation', argsHint: '[report]', source: 'builtin' },
  { name: 'cd', description: 'Move this session to a new working directory', argsHint: '[<path>]', source: 'builtin' },
  { name: 'clear', description: 'Start a new session with empty context; previous session stays on disk (resumable with /resume)', source: 'builtin' },
  { name: 'cloud-plugins', description: 'Choose whether cloud sessions use the plugins enabled on this machine', source: 'builtin' },
  { name: 'code-review', description: 'Review the current diff or a PR for bugs and cleanups', source: 'builtin' },
  { name: 'color', description: 'Set the prompt bar color for this session', source: 'builtin' },
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', argsHint: '[instructions]', source: 'builtin' },
  { name: 'config', description: 'Open settings', argsHint: '[key=value]', source: 'builtin' },
  { name: 'context', description: 'Visualize current context usage as a colored grid', argsHint: '[all]', source: 'builtin' },
  { name: 'copy', description: "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)", source: 'builtin' },
  { name: 'daemon', description: 'Manage background services and routines', source: 'builtin' },
  { name: 'debug', description: 'Turn on debug logging and investigate problems', argsHint: '[issue description]', source: 'builtin' },
  { name: 'design-login', description: 'Authorize design-system access for /design-sync with your claude.ai account', source: 'builtin' },
  { name: 'diff', description: 'View uncommitted changes and per-turn diffs', source: 'builtin' },
  { name: 'doctor', description: 'Health-check your setup and fix issues: installation, unused extensions, duplicated or bloated memory files, slow hooks, updates, permissions', source: 'builtin' },
  { name: 'effort', description: 'Set effort level for model usage', argsHint: '[level]', source: 'builtin' },
  { name: 'exit', description: 'Exit the CLI', source: 'builtin' },
  { name: 'export', description: 'Export the current conversation to a file or clipboard', argsHint: '[filename]', source: 'builtin' },
  { name: 'feedback', description: 'Send feedback to Anthropic or report a bug', argsHint: '[report]', source: 'builtin' },
  { name: 'focus', description: 'Toggle focus view: just your prompt, summary, and response', source: 'builtin' },
  { name: 'fork', description: 'Spawn a background agent that inherits the full conversation', argsHint: '[<directive>]', source: 'builtin' },
  { name: 'goal', description: 'Set a goal Claude checks before stopping', argsHint: '[<condition> | clear]', source: 'builtin' },
  { name: 'help', description: 'Show help and available commands', source: 'builtin' },
  { name: 'hooks', description: 'View hook configurations for tool events', argsHint: '[name]', source: 'builtin' },
  { name: 'ide', description: 'Manage IDE integrations and show status', argsHint: '[open]', source: 'builtin' },
  { name: 'init', description: 'Initialize a CLAUDE.md for this project', source: 'builtin' },
  { name: 'insights', description: 'Generate a report analyzing your Claude Code sessions', source: 'builtin' },
  { name: 'install', description: 'Install Claude Code native build', argsHint: '[options]', source: 'builtin' },
  { name: 'install-github-app', description: 'Set up Claude GitHub Actions for a repository', source: 'builtin' },
  { name: 'install-slack-app', description: 'Install the Claude Slack app', source: 'builtin' },
  { name: 'keybindings', description: 'Open your keyboard shortcuts file', source: 'builtin' },
  { name: 'list-agents', description: 'List subagents, teammates, and other Claude sessions you can message', source: 'builtin' },
  { name: 'login', description: 'Sign in with your Anthropic account', source: 'builtin' },
  { name: 'logout', description: 'Sign out from your Anthropic account', source: 'builtin' },
  { name: 'loops', description: 'List, create, and delete loops', argsHint: '[name]', source: 'builtin' },
  { name: 'mcp', description: 'Manage MCP servers', source: 'builtin' },
  { name: 'memory', description: 'Edit CLAUDE.md files and memory settings', source: 'builtin' },
  { name: 'mobile', description: 'Show QR code to download the Claude mobile app', source: 'builtin' },
  { name: 'model', description: 'Set the AI model for Claude Code', argsHint: '[model]', source: 'builtin' },
  { name: 'permissions', description: 'Manage allow and deny tool permission rules', argsHint: '[open|<description>]', source: 'builtin' },
  { name: 'plan', description: 'Enable plan mode or view the current session plan', argsHint: '[open|<description>]', source: 'builtin' },
  { name: 'plugin', description: 'Manage Claude Code plugins', source: 'builtin' },
  { name: 'powerup', description: 'Discover Claude Code features through quick interactive lessons', argsHint: '[name]', source: 'builtin' },
  { name: 'privacy-settings', description: 'View and update your privacy settings', source: 'builtin' },
  { name: 'radio', description: 'Listen to Claude FM lo-fi radio', source: 'builtin' },
  { name: 'rate-limit-options', description: 'Manage usage limits and upgrade options', source: 'builtin' },
  { name: 'recap', description: 'Generate a one-line session recap now', source: 'builtin' },
  { name: 'release-notes', description: 'View release notes', source: 'builtin' },
  { name: 'reload-plugins', description: 'Activate pending plugin changes in the current session', argsHint: '[--force]', source: 'builtin' },
  { name: 'reload-skills', description: 'Pick up skills added or changed on disk during this session', source: 'builtin' },
  { name: 'rename', description: 'Rename the current conversation', argsHint: '[name]', source: 'builtin' },
  { name: 'resume', description: 'Resume a previous conversation', argsHint: '[conversation id or search term]', source: 'builtin' },
  { name: 'rewind', description: 'Restore the code and/or conversation to a previous point', source: 'builtin' },
  { name: 'scroll-speed', description: 'Adjust mouse wheel scroll speed', source: 'builtin' },
  { name: 'security-review', description: 'Complete a security review of the pending changes on the current branch', source: 'builtin' },
  { name: 'skill-doctor', description: 'Show which loaded skills are unused and costing context', source: 'builtin' },
  { name: 'skills', description: 'List available skills', source: 'builtin' },
  { name: 'status', description: 'Show Claude Code status including version, model, account, API connectivity, and tool statuses', source: 'builtin' },
  { name: 'statusline', description: "Set up Claude Code's status line UI", source: 'builtin' },
  { name: 'stickers', description: 'Order Claude Code stickers', source: 'builtin' },
  { name: 'stop', description: 'Stop this background session; transcript and worktree are kept', source: 'builtin' },
  { name: 'subtask', description: 'Send a subagent off with your full context; its result comes back here', argsHint: '[<task>]', source: 'builtin' },
  { name: 'tasks', description: 'View and manage everything running in the background', source: 'builtin' },
  { name: 'terminal-setup', description: 'Check terminal setup for key bindings like Shift+Enter', source: 'builtin' },
  { name: 'theme', description: 'Change the theme', source: 'builtin' },
  { name: 'tui', description: 'Set the terminal UI renderer (default | fullscreen)', argsHint: '[default|fullscreen]', source: 'builtin' },
  { name: 'ultraplan', description: 'Draft an editable plan in a cloud session', argsHint: '[<prompt>]', source: 'builtin' },
  { name: 'ultrareview', description: 'Start a cloud agent that finds and verifies bugs in your branch', source: 'builtin' },
  { name: 'upgrade', description: 'Upgrade to Max for higher rate limits and more Opus', source: 'builtin' },
  { name: 'usage', description: 'Show session cost, plan usage, and activity stats', source: 'builtin' },
  { name: 'usage-credits', description: 'Configure usage credits or request them from your admin when you hit a limit', source: 'builtin' },
  { name: 'version', description: "Show this session's version (autoupdate may have a newer one)", source: 'builtin' },
  { name: 'wellbeing', description: 'Configure optional break reminders and quiet-hours nudges', source: 'builtin' },
  { name: 'workflows', description: 'Browse running and completed workflows', source: 'builtin' },
];

/** frontmatter 的 `description:`（没有就取第一行正文），供命令/skill 的说明用。 */
function describeMarkdown(text: string): string {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const desc = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (desc) return desc;
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return body.split('\n').find((l) => l.trim() !== '' && !l.startsWith('#'))?.trim() ?? '';
}

/** 跟随符号链接的真身判定：`Dirent` 只报链接本身，不报目标是什么。 */
async function kindOf(full: string): Promise<'dir' | 'file' | 'other'> {
  try {
    const s = await stat(full);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
  } catch {
    return 'other';
  }
}

/** 目录下的 `*.md`（容错：目录不在 = 空）。符号链接到文件也算。 */
async function markdownFiles(dir: string): Promise<string[]> {
  try {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.name.endsWith('.md')) continue;
      const full = path.join(dir, e.name);
      if (e.isFile() || (e.isSymbolicLink() && (await kindOf(full)) === 'file')) out.push(full);
    }
    return out;
  } catch {
    return [];
  }
}

/** 目录下的子目录（容错：目录不在 = 空）。**符号链接到目录也算**——用户常把
 *  仓库里的 skill 链进 `~/.claude/skills`（与资源管理那边的扫描同口径）。 */
async function subdirs(dir: string): Promise<string[]> {
  try {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() || (e.isSymbolicLink() && (await kindOf(full)) === 'dir')) out.push(full);
    }
    return out;
  } catch {
    return [];
  }
}

/** 自定义命令：`<root>/**\/*.md`，子目录成命名空间（`db/migrate.md` → `db:migrate`）。
 *  自定义命令是 prompt 型（宿主 mention 扫描只认 prompt 型）⇒ 句中可用。 */
async function readCommands(root: string): Promise<HarnessCommand[]> {
  const out: HarnessCommand[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const file of await markdownFiles(dir)) {
      const name = `${prefix}${path.basename(file, '.md')}`;
      const description = describeMarkdown(await readFile(file, 'utf8').catch(() => ''));
      out.push({ name, description, source: 'command', inline: true });
    }
    for (const dir2 of await subdirs(dir)) {
      await walk(dir2, `${prefix}${path.basename(dir2)}:`);
    }
  };
  await walk(root, '');
  return out;
}

/** skill：`<root>/<name>/SKILL.md`（名字取目录名）。skill 都是 prompt 型 ⇒ 句中可用。 */
async function readSkills(root: string, prefix = '', source: HarnessCommand['source'] = 'skill'): Promise<HarnessCommand[]> {
  const out: HarnessCommand[] = [];
  for (const dir of await subdirs(root)) {
    const description = describeMarkdown(await readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => ''));
    out.push({ name: `${prefix}${path.basename(dir)}`, description, source, inline: true });
  }
  return out;
}

/** 插件 skill：`plugins/cache/<market>/<plugin>/<version>/skills/<skill>/SKILL.md`。
 *  同一插件可能缓存多份版本——按插件名去重，先到先得（宿主也只用其中一份）。 */
async function readPluginSkills(home: string): Promise<HarnessCommand[]> {
  const out: HarnessCommand[] = [];
  const seen = new Set<string>();
  for (const market of await subdirs(path.join(home, 'plugins', 'cache'))) {
    for (const plugin of await subdirs(market)) {
      const key = path.basename(plugin);
      if (seen.has(key)) continue;
      // 版本层在插件名之下：逐个版本目录找第一份带 skills 的
      for (const version of await subdirs(plugin)) {
        const found = await readSkills(path.join(version, 'skills'), `${key}:`, 'plugin');
        if (found.length > 0) {
          seen.add(key);
          out.push(...found);
          break;
        }
      }
    }
  }
  return out;
}

/** 官方口径的插件启用态（`claude plugin list --json`）：拿不到回 null，不猜。 */
interface InstalledPlugin {
  plugin: string;
  enabled: boolean;
  installPath: string;
}

async function installedPlugins(exec: PluginExecutor): Promise<InstalledPlugin[] | null> {
  try {
    const { stdout } = await exec(['plugin', 'list', '--json'], { timeoutMs: 15_000 });
    const rows: unknown = JSON.parse(stdout);
    if (!Array.isArray(rows)) return null;
    const out: InstalledPlugin[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as { id?: unknown; enabled?: unknown; installPath?: unknown };
      if (typeof r.id !== 'string' || typeof r.installPath !== 'string') continue;
      // id = `<plugin>@<market>`；插件名本身可能含 `@`，从最后一个拆
      const at = r.id.lastIndexOf('@');
      out.push({
        plugin: at > 0 ? r.id.slice(0, at) : r.id,
        enabled: r.enabled === true,
        installPath: r.installPath,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** 启用插件的 skill（官方 installPath 直取）；CLI 不可用 → null（调用方退回落扫缓存）。 */
async function enabledPluginSkills(exec: PluginExecutor): Promise<HarnessCommand[] | null> {
  const plugins = await installedPlugins(exec);
  if (!plugins) return null;
  const out: HarnessCommand[] = [];
  for (const p of plugins) {
    if (!p.enabled) continue;
    out.push(...(await readSkills(path.join(p.installPath, 'skills'), `${p.plugin}:`, 'plugin')));
  }
  return out;
}

/** 内建的 prompt 型命令（宿主 mention 扫描只认 prompt 型 ⇒ 句中可用）：
 *  2.1.296 二进制命令注册表里 type:"prompt" 的可见项。升级宿主后随 BUILTINS 复核。 */
const INLINE_BUILTINS = new Set(['init', 'statusline', 'insights']);

/** 按名字去重（内建优先，其次项目/用户命令与 skill）。 */
function dedupe(rows: readonly HarnessCommand[]): HarnessCommand[] {
  const seen = new Set<string>();
  const out: HarnessCommand[] = [];
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    out.push(row);
  }
  return out;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `<command-args>` 里的参数（没有标签 = 空）。 */
function argsOf(text: string): string {
  return /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
}

/** 命令回显的增量账（按转录路径），同 narration 的游标缓存。 */
const execCursors = new Map<
  string,
  {
    cur: LineCursor;
    out: CommandExecution[];
    pending: { name: string; args: string; at: string } | null;
  }
>();
const EXEC_CURSOR_MAX = 64;

/**
 * 转录里的命令执行：`<command-name>` 那一条之后若紧跟 `<local-command-stdout>`，
 * 就是一次内建命令（skill 命令后面跟的是 isMeta 展开正文，不算——它已经有 UPS 气泡）。
 *
 * 按**字节游标**增量累积（同 narration）：`pending`（等 stdout 的那条命令）是跨行
 * 状态，跟着游标一起存——两行可能分在两次读里。文件被截断/换掉 ⇒ 全部作废重来。
 */
export async function commandExecutions(transcriptPath: string): Promise<CommandExecution[] | null> {
  const size = transcriptSize(transcriptPath);
  if (size === null) {
    execCursors.delete(transcriptPath);
    return null;
  }
  const hit = execCursors.get(transcriptPath);
  execCursors.delete(transcriptPath);
  const entry = hit ?? { cur: { offset: 0 }, out: [], pending: null };
  if (size < entry.cur.offset) {
    entry.cur.offset = 0;
    entry.out = [];
    entry.pending = null;
  }
  const lines = readNewLines(transcriptPath, entry.cur, size);
  if (lines === null) return null;
  const out = entry.out;
  let pending = entry.pending;
  for (const line of lines) {
    if (!line.includes('<command-name>') && !line.includes('<local-command-stdout>')) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row === null || typeof row !== 'object') continue;
    const rec = row as { type?: unknown; timestamp?: unknown; message?: { content?: unknown } };
    const content = rec.message?.content;
    if (typeof content !== 'string') continue;
    const at = str(rec.timestamp);
    const name = /<command-name>([^<]*)<\/command-name>/.exec(content)?.[1]?.trim();
    if (name?.startsWith('/')) {
      pending = { name: name.slice(1), args: argsOf(content), at };
      continue;
    }
    const output = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(content)?.[1];
    if (output === undefined || pending === null) continue;
    // ANSI 转义（宿主的着色）进不了对话正文
    const clean = output.replace(/\u001b\[[0-9;]*m/g, '').trim();
    out.push({ ...pending, ...(clean !== '' ? { output: clean } : {}) });
    pending = null;
  }
  entry.pending = pending;
  if (execCursors.size >= EXEC_CURSOR_MAX) {
    const oldest = execCursors.keys().next().value;
    if (oldest !== undefined) execCursors.delete(oldest);
  }
  execCursors.set(transcriptPath, entry);
  return out;
}

/** 候选清单的短 TTL：一次 list 要扫六个目录 + 起一次 `claude plugin list`（Windows
 *  经 cmd 壳 5s+），而候选集合只随命令/skill 文件与插件启停变——60s 内复用。 */
const LIST_TTL_MS = 60_000;
const LIST_CACHE_MAX = 16;

export function createClaudeCommandSurface(deps: { exec?: PluginExecutor } = {}): CommandsSurface {
  const exec = deps.exec ?? claudeExec;
  const cache = new Map<string, { at: number; rows: HarnessCommand[] }>();
  return {
    harness: 'claude',
    // `/` = 斜杠命令（内建的不发 UPS，skill/插件的会发）；`!` = bash 模式（宿主本地
    // 执行，同样不发 UPS——投递侧一律走命令的短窗口，别干等普通回执）。
    inputModes: [
      { kind: 'slash', sigil: '/', named: true },
      { kind: 'bash', sigil: '!', named: false },
    ],
    async list({ projectPath, homedir = osHomedir() }) {
      const key = `${projectPath}\0${homedir}`;
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && now - hit.at < LIST_TTL_MS) return hit.rows;
      const home = path.join(homedir, '.claude');
      const rows = dedupe([
        ...BUILTINS.map((c) => (INLINE_BUILTINS.has(c.name) ? { ...c, inline: true } : c)),
        ...(await readCommands(path.join(projectPath, '.claude', 'commands'))),
        ...(await readCommands(path.join(home, 'commands'))),
        ...(await readSkills(path.join(projectPath, '.claude', 'skills'))),
        ...(await readSkills(path.join(home, 'skills'))),
        ...((await enabledPluginSkills(exec)) ?? (await readPluginSkills(home))),
      ]);
      if (cache.size >= LIST_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { at: now, rows });
      return rows;
    },
    executions: (transcriptPath) => (transcriptPath ? commandExecutions(transcriptPath) : Promise.resolve(null)),
  };
}

export const CLAUDE_COMMANDS = createClaudeCommandSurface();
