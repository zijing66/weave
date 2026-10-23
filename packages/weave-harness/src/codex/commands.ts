import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import type { CommandsSurface, HarnessCommand } from '../driver.js';
import { codexCommandLine } from './plugins.js';

/**
 * Codex 的命令候选：内建命令快照 + 自定义 prompt + skill。
 *
 * - **内建命令**：TUI 自己的命令，没有目录可扫 ⇒ 版本快照表（`/` 里自查，
 *   升级 codex 后按它复核）。
 * - **自定义 prompt**：`$CODEX_HOME/prompts/*.md`，文件名即命令名（codex 的
 *   `/prompts` 面板同源）。
 * - **skill**：优先走官方 `skills/list`（app-server JSON-RPC）——它回的是**当前
 *   生效**的那一份（`enabled` 过滤、scope、插件归属都是宿主算的），且 `$name`
 *   才是 skill 的触发符（`$` 不是 `/`）。取不到才退回扫 `$CODEX_HOME/skills`。
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

/** 跟随符号链接的真身判定：`Dirent` 只报链接本身，不报目标是什么。 */
async function kindOf(full: string): Promise<'dir' | 'file' | 'other'> {
  try {
    const s = await stat(full);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
  } catch {
    return 'other';
  }
}

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

/** 符号链接到目录也算（与资源管理的扫描同口径）。 */
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
    out.push({ name: path.basename(dir), description, source: 'skill', sigil: '$' });
  }
  return out;
}

/** app-server 的 `skills/list` 响应 → 候选（只留 enabled；插件带 pluginId）。 */
function parseSkills(result: unknown): HarnessCommand[] | null {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const out: HarnessCommand[] = [];
  for (const entry of data) {
    const skills = (entry as { skills?: unknown } | null)?.skills;
    if (!Array.isArray(skills)) continue;
    for (const s of skills) {
      const r = s as { name?: unknown; description?: unknown; enabled?: unknown; pluginId?: unknown };
      if (typeof r.name !== 'string' || r.enabled === false) continue;
      out.push({
        name: r.name,
        description: typeof r.description === 'string' ? r.description : '',
        source: typeof r.pluginId === 'string' ? 'plugin' : 'skill',
        sigil: '$',
      });
    }
  }
  return out;
}

const RPC_TIMEOUT_MS = 10_000;

/**
 * 官方 `skills/list`：起一个 `codex app-server`（stdio JSON-RPC），握手后问一次
 * 就收摊。失败/超时/协议不认识一律回 null——调用方退回目录扫描，不猜。
 */
function officialSkills(projectPath: string): Promise<HarnessCommand[] | null> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = spawn(
      win ? process.env['ComSpec'] || 'cmd.exe' : 'codex',
      win ? ['/d', '/s', '/c', codexCommandLine(['app-server'])] : ['app-server'],
      { windowsHide: true, windowsVerbatimArguments: win, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let settled = false;
    let buf = '';
    const finish = (value: HarnessCommand[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // win32 只杀得到 cmd.exe 外壳：孙进程会吊住管道，必须杀树
      if (win && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref();
      } else {
        child.kill('SIGKILL');
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), RPC_TIMEOUT_MS);
    const send = (msg: unknown): void => {
      child.stdin?.write(`${JSON.stringify(msg)}\n`);
    };
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stdin?.on('error', () => finish(null));
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'weave', title: 'weave', version: '1.0.0' } },
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: unknown; result?: unknown } | null = null;
        try {
          msg = JSON.parse(line) as { id?: unknown };
        } catch {
          continue;
        }
        if (msg?.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'skills/list', params: { cwds: [projectPath] } });
          continue;
        }
        if (msg?.id === 2) finish(parseSkills(msg.result));
      }
    });
  });
}

function dedupe(rows: readonly HarnessCommand[]): HarnessCommand[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.name) ? false : (seen.add(row.name), true)));
}

export function createCodexCommandSurface(
  deps: { skills?: (projectPath: string) => Promise<HarnessCommand[] | null> } = {},
): CommandsSurface {
  const skillsOf = deps.skills ?? officialSkills;
  return {
    harness: 'codex',
    async list({ projectPath, homedir = osHomedir() }) {
      const home = process.env.CODEX_HOME ?? path.join(homedir, '.codex');
      return dedupe([
        ...BUILTINS,
        ...(await readPrompts(path.join(home, 'prompts'))),
        ...((await skillsOf(projectPath)) ?? (await readSkills(path.join(home, 'skills')))),
      ]);
    },
    // rollout 不记 TUI 命令 ⇒ 没有可返显的记录（不是读失败）
    executions: () => Promise.resolve(null),
  };
}

export const CODEX_COMMANDS = createCodexCommandSurface();
