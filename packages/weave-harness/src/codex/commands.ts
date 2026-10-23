import { readdir, readFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import type { CommandsSurface, HarnessCommand } from '../driver.js';

/**
 * Codex 的斜杠命令：候选清单来自内建命令快照 + 自定义 prompt + skill。
 *
 * - **内建命令**：TUI 自己的命令，没有目录可扫 ⇒ 版本快照表（`/` 里自查，
 *   升级 codex 后按它复核）。
 * - **自定义 prompt**：`$CODEX_HOME/prompts/*.md`，文件名即命令名（codex 的
 *   `/prompts` 面板同源）。
 * - **skill**：`$CODEX_HOME/skills/<name>/SKILL.md`。
 *
 * 返显**不支持**：codex 的 rollout 只记模型看得到的东西（user/assistant 消息、
 * 工具调用），TUI 内建命令一个字节都不落盘——没有可回的原文，如实答 null。
 */

/** 内建命令快照（codex 0.163 的 TUI；升级后复核）。 */
const BUILTINS: readonly HarnessCommand[] = [
  { name: 'model', description: 'Choose what model and reasoning effort to use', source: 'builtin' },
  { name: 'approvals', description: 'Choose what Codex can do without approval', source: 'builtin' },
  { name: 'new', description: 'Start a new chat during a conversation', source: 'builtin' },
  { name: 'init', description: 'Create an AGENTS.md file with project instructions', source: 'builtin' },
  { name: 'compact', description: 'Summarize the conversation to free context', source: 'builtin' },
  { name: 'diff', description: 'Show the diff of the working tree', source: 'builtin' },
  { name: 'mention', description: 'Mention a file in the conversation', argsHint: '<path>', source: 'builtin' },
  { name: 'status', description: 'Show session configuration and token usage', source: 'builtin' },
  { name: 'mcp', description: 'List configured MCP tools', source: 'builtin' },
  { name: 'prompts', description: 'Browse and use custom prompts', source: 'builtin' },
  { name: 'skills', description: 'Browse and use skills', source: 'builtin' },
  { name: 'plugins', description: 'Browse and manage plugins', source: 'builtin' },
  { name: 'review', description: 'Review the current changes', source: 'builtin' },
  { name: 'undo', description: 'Undo the last turn', source: 'builtin' },
  { name: 'statusline', description: 'Configure the status line', source: 'builtin' },
  { name: 'logout', description: 'Sign out of your account', source: 'builtin' },
  { name: 'quit', description: 'Exit Codex', source: 'builtin' },
];

/** frontmatter 的 `description:`（没有就取第一行正文）。 */
function describeMarkdown(text: string): string {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const desc = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (desc) return desc;
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return body.split('\n').find((l) => l.trim() !== '' && !l.startsWith('#'))?.trim() ?? '';
}

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function readPrompts(root: string): Promise<HarnessCommand[]> {
  const out: HarnessCommand[] = [];
  for (const file of await markdownFiles(root)) {
    const description = describeMarkdown(await readFile(file, 'utf8').catch(() => ''));
    out.push({ name: path.basename(file, '.md'), description, source: 'command' });
  }
  return out;
}

async function readSkills(root: string): Promise<HarnessCommand[]> {
  const out: HarnessCommand[] = [];
  for (const dir of await subdirs(root)) {
    const description = describeMarkdown(await readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => ''));
    out.push({ name: path.basename(dir), description, source: 'skill' });
  }
  return out;
}

function dedupe(rows: readonly HarnessCommand[]): HarnessCommand[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.name) ? false : (seen.add(row.name), true)));
}

export const CODEX_COMMANDS: CommandsSurface = {
  harness: 'codex',
  async list({ homedir = osHomedir() }) {
    const home = process.env.CODEX_HOME ?? path.join(homedir, '.codex');
    return dedupe([
      ...BUILTINS,
      ...(await readPrompts(path.join(home, 'prompts'))),
      ...(await readSkills(path.join(home, 'skills'))),
    ]);
  },
  // rollout 不记 TUI 命令 ⇒ 没有可返显的记录（不是读失败）
  executions: () => Promise.resolve(null),
};
