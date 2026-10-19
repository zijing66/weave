import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetSurface, McpServerConfig } from '../driver.js';
import { FILE_ASSET_SPECS } from '../shared/file-specs.js';

const MCP_FILE = '.mcp.json';
/** Claude Code 的运行时文件（用户级 MCP 住这里，不是 settings.json）。 */
const CLAUDE_JSON = '.claude.json';

/**
 * `~/.claude.json` 解析不了就拒写：那是 Claude Code 自己的运行时文件，里面还有
 * weave 不认识的键，宁可报错也不冒毁掉的风险。
 */
export class ClaudeJsonCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeJsonCorruptError';
  }
}

/** 名称会进配置键（不是路径段），但仍拒掉能逃出目录的形状。 */
function assertSafeName(name: string): void {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid asset name: "${name}"`);
  }
}

/** 项目 `.mcp.json`：缺失或解析不了 → 空对象（读侧不让坏文件挡住列表）。 */
async function readProjectMcp(file: string): Promise<{ mcpServers?: Record<string, unknown> }> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as { mcpServers?: Record<string, unknown> };
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** `~/.claude.json` 的整份读（含 MCP 之外的键）；解析不了就抛，坏文件下任何
 * 结论都不可信。 */
export async function readClaudeJson(homedir: string): Promise<Record<string, unknown>> {
  const file = path.join(homedir, CLAUDE_JSON);
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ClaudeJsonCorruptError(
      `~/.claude.json is not valid JSON — refusing to write: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClaudeJsonCorruptError('~/.claude.json is not a JSON object — refusing to write');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Claude Code 资产表面（批 4a 迁入）：文件资产目标目录、skills 项目/全局根、
 * 用户级配置路径、路径归属与 watch 观测集——原 `install/file-assets.ts`、
 * `installer.ts`、`global-config.ts`、`watch/` 散落的 Claude 侧知识。
 */
export const CLAUDE_ASSETS: AssetSurface = {
  harness: 'claude',

  targetDir(category, scope, projectPath, homedir) {
    const dirs = FILE_ASSET_SPECS[category].dirs.claude;
    if (scope === 'user') {
      if (!dirs?.user) {
        throw new Error(`"${category}" is project-scoped only (no user-level directory)`);
      }
      return path.join(homedir, ...dirs.user.split('/'));
    }
    if (!dirs?.project) {
      throw new Error(`"${category}" has no Claude project surface`);
    }
    return path.join(projectPath, ...dirs.project.split('/'));
  },

  projectSkillsDir: () => '.claude/skills',

  globalSkillsRoots: (homedir) => [path.join(homedir, ...'.claude/skills'.split('/'))],

  userConfigFile: (homedir) => path.join(homedir, '.claude', 'settings.json'),

  mcpScopes: () => ['project', 'user'],

  // 项目 = 根级 .mcp.json；用户级 MCP 住在运行时文件 ~/.claude.json（非 settings.json）。
  mcpDest: (scope, homedir) =>
    scope === 'project' ? '.mcp.json' : path.join(homedir, '.claude.json'),

  pluginCacheDir: (homedir) => path.join(homedir, '.claude', 'plugins', 'cache'),

  async mcpRead(scope, projectPath, homedir) {
    if (scope === 'project') {
      const json = await readProjectMcp(path.join(projectPath, MCP_FILE));
      return (json.mcpServers ?? {}) as Record<string, McpServerConfig>;
    }
    const servers = (await readClaudeJson(homedir)).mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
    return servers as Record<string, McpServerConfig>;
  },

  async mcpWrite(scope, projectPath, homedir, name, config) {
    assertSafeName(name);
    if (scope === 'project') {
      const file = path.join(projectPath, MCP_FILE);
      const json = await readProjectMcp(file);
      json.mcpServers = { ...(json.mcpServers ?? {}), [name]: config };
      await writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
      return;
    }
    const json = await readClaudeJson(homedir);
    json.mcpServers = { ...((json.mcpServers as Record<string, unknown>) ?? {}), [name]: config };
    await writeFile(path.join(homedir, CLAUDE_JSON), `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
  },

  async mcpRemove(scope, projectPath, homedir, name) {
    assertSafeName(name);
    const file = scope === 'project' ? path.join(projectPath, MCP_FILE) : path.join(homedir, CLAUDE_JSON);
    const json = scope === 'project' ? await readProjectMcp(file) : await readClaudeJson(homedir);
    const servers = (json.mcpServers ?? {}) as Record<string, unknown>;
    if (!(name in servers)) return false;
    delete servers[name];
    json.mcpServers = servers;
    await writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
    return true;
  },

  classify(relPath) {
    if (relPath === '.claude' || relPath.startsWith('.claude/')) return true;
    if (relPath === '.mcp.json') return true;
    return relPath.slice(relPath.lastIndexOf('/') + 1) === 'CLAUDE.md';
  },

  ignore(relPath) {
    if (relPath === '.claude' || relPath.startsWith('.claude/')) {
      // 会话历史与缓存子树是噪音，不观测（原 shouldIgnore 显式 drop）。
      return (
        relPath === '.claude/projects' ||
        relPath.startsWith('.claude/projects/') ||
        relPath === '.claude/cache' ||
        relPath.startsWith('.claude/cache/')
      );
    }
    // 本面其余观测项：根级 .mcp.json 与根级 CLAUDE.md（其余路径皆不在观测集）。
    return relPath !== '.mcp.json' && relPath !== 'CLAUDE.md';
  },
};
