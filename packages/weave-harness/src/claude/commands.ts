import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import type { CommandExecution, CommandsSurface, HarnessCommand } from '../driver.js';
import { execCli as claudeExec, type PluginExecutor } from './plugins.js';

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

/** 内建命令快照（claude 2.1.x 的 `/help` 清单；宿主升级后复核这张表）。 */
const BUILTINS: readonly HarnessCommand[] = [
  { name: 'help', description: 'Show help and available commands', source: 'builtin' },
  { name: 'clear', description: 'Clear the conversation history', source: 'builtin' },
  { name: 'compact', description: 'Compact the conversation to free context', argsHint: '[instructions]', source: 'builtin' },
  { name: 'context', description: 'Show context window usage', source: 'builtin' },
  { name: 'cost', description: 'Show token usage and cost for this session', source: 'builtin' },
  { name: 'model', description: 'Set the model for this session', argsHint: '[model]', source: 'builtin' },
  { name: 'effort', description: 'Set the thinking effort level', argsHint: '[level]', source: 'builtin' },
  { name: 'config', description: 'Open the configuration panel', source: 'builtin' },
  { name: 'status', description: 'Show version, model and account status', source: 'builtin' },
  { name: 'statusline', description: 'Configure the status line', source: 'builtin' },
  { name: 'memory', description: 'Edit memory files (CLAUDE.md)', source: 'builtin' },
  { name: 'init', description: 'Initialize a CLAUDE.md for this project', source: 'builtin' },
  { name: 'review', description: 'Review a pull request', source: 'builtin' },
  { name: 'security-review', description: 'Run a security review of pending changes', source: 'builtin' },
  { name: 'agents', description: 'Manage subagents', source: 'builtin' },
  { name: 'permissions', description: 'Manage tool permissions', source: 'builtin' },
  { name: 'hooks', description: 'Show configured hooks', source: 'builtin' },
  { name: 'mcp', description: 'Manage MCP servers', source: 'builtin' },
  { name: 'plugin', description: 'Manage plugins and marketplaces', source: 'builtin' },
  { name: 'skills', description: 'List available skills', source: 'builtin' },
  { name: 'reload-plugins', description: 'Reload plugins', source: 'builtin' },
  { name: 'reload-skills', description: 'Reload skills', source: 'builtin' },
  { name: 'resume', description: 'Resume an earlier conversation', source: 'builtin' },
  { name: 'rename', description: 'Rename the current conversation', argsHint: '[name]', source: 'builtin' },
  { name: 'branch', description: 'Branch the conversation from here', source: 'builtin' },
  { name: 'export', description: 'Export the conversation', source: 'builtin' },
  { name: 'add-dir', description: 'Add a working directory', argsHint: '<path>', source: 'builtin' },
  { name: 'todos', description: 'Show the todo list', source: 'builtin' },
  { name: 'vim', description: 'Toggle vim editing mode', source: 'builtin' },
  { name: 'login', description: 'Sign in to your account', source: 'builtin' },
  { name: 'logout', description: 'Sign out of your account', source: 'builtin' },
  { name: 'doctor', description: 'Diagnose the installation', source: 'builtin' },
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

/** 自定义命令：`<root>/**\/*.md`，子目录成命名空间（`db/migrate.md` → `db:migrate`）。 */
async function readCommands(root: string): Promise<HarnessCommand[]> {
  const out: HarnessCommand[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const file of await markdownFiles(dir)) {
      const name = `${prefix}${path.basename(file, '.md')}`;
      const description = describeMarkdown(await readFile(file, 'utf8').catch(() => ''));
      out.push({ name, description, source: 'command' });
    }
    for (const dir2 of await subdirs(dir)) {
      await walk(dir2, `${prefix}${path.basename(dir2)}:`);
    }
  };
  await walk(root, '');
  return out;
}

/** skill：`<root>/<name>/SKILL.md`（名字取目录名）。 */
async function readSkills(root: string, prefix = '', source: HarnessCommand['source'] = 'skill'): Promise<HarnessCommand[]> {
  const out: HarnessCommand[] = [];
  for (const dir of await subdirs(root)) {
    const description = describeMarkdown(await readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => ''));
    out.push({ name: `${prefix}${path.basename(dir)}`, description, source });
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

/**
 * 转录里的命令执行：`<command-name>` 那一条之后若紧跟 `<local-command-stdout>`，
 * 就是一次内建命令（skill 命令后面跟的是 isMeta 展开正文，不算——它已经有 UPS 气泡）。
 */
export async function commandExecutions(transcriptPath: string): Promise<CommandExecution[] | null> {
  let text: string;
  try {
    text = await readFile(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const out: CommandExecution[] = [];
  let pending: { name: string; args: string; at: string } | null = null;
  for (const line of text.split('\n')) {
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
  return out;
}

export function createClaudeCommandSurface(deps: { exec?: PluginExecutor } = {}): CommandsSurface {
  const exec = deps.exec ?? claudeExec;
  return {
    harness: 'claude',
    async list({ projectPath, homedir = osHomedir() }) {
      const home = path.join(homedir, '.claude');
      return dedupe([
        ...BUILTINS,
        ...(await readCommands(path.join(projectPath, '.claude', 'commands'))),
        ...(await readCommands(path.join(home, 'commands'))),
        ...(await readSkills(path.join(projectPath, '.claude', 'skills'))),
        ...(await readSkills(path.join(home, 'skills'))),
        ...((await enabledPluginSkills(exec)) ?? (await readPluginSkills(home))),
      ]);
    },
    executions: (transcriptPath) => (transcriptPath ? commandExecutions(transcriptPath) : Promise.resolve(null)),
  };
}

export const CLAUDE_COMMANDS = createClaudeCommandSurface();
