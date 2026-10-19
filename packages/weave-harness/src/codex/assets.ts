import path from 'node:path';
import type { AssetSurface } from '../driver.js';
import { FILE_ASSET_SPECS } from '../shared/file-specs.js';
import {
  readCodexMcpServers,
  removeCodexMcpServer,
  writeCodexMcpServer,
} from './mcp.js';

/** `~/.codex/config.toml`：用户级配置，MCP 恒住这里。 */
const codexConfigFile = (homedir: string): string => path.join(homedir, '.codex', 'config.toml');

/**
 * Codex 资产表面（批 4a 迁入，能力矩阵 ⚠：仅 skills + 文件资产 user 面）：
 * 落点表（FILE_ASSET_SPECS.dirs.codex）目标目录、skills 项目/全局根（current + legacy 两根）、
 * config.toml 路径、路径归属与 watch 观测集。
 */
export const CODEX_ASSETS: AssetSurface = {
  harness: 'codex',

  targetDir(category, scope, _projectPath, homedir) {
    // Codex 无项目级文件资产表面（skills-only），project 恒抛错——_projectPath 仅占位。
    const dirs = FILE_ASSET_SPECS[category].dirs.codex;
    if (scope !== 'user' || !dirs?.user) {
      throw new Error(
        `"${category}" has no Codex ${scope === 'user' ? 'user' : 'project'} surface`,
      );
    }
    return path.join(homedir, ...dirs.user.split('/'));
  },

  projectSkillsDir: () => '.codex/skills',

  globalSkillsRoots: (homedir) => [
    // current location — the one installs target（codex-rs host_roots.rs 先读）
    path.join(homedir, ...'.agents/skills'.split('/')),
    // deprecated legacy root — read but never written
    path.join(homedir, ...'.codex/skills'.split('/')),
  ],

  userConfigFile: (homedir) => codexConfigFile(homedir),

  // MCP 恒用户级（~/.codex/config.toml），无项目 .mcp.json 面。
  mcpScopes: () => ['user'],

  mcpDest: (scope, homedir) => (scope === 'user' ? codexConfigFile(homedir) : undefined),

  pluginCacheDir: (homedir) => path.join(homedir, '.codex', 'plugins', 'cache'),

  async mcpRead(scope, _projectPath, homedir) {
    if (scope !== 'user') throw new Error('Codex MCP servers are user-level only (~/.codex/config.toml)');
    return readCodexMcpServers(codexConfigFile(homedir));
  },

  async mcpWrite(scope, _projectPath, homedir, name, config) {
    if (scope !== 'user') throw new Error('Codex MCP servers are user-level only (~/.codex/config.toml)');
    await writeCodexMcpServer(name, config, codexConfigFile(homedir));
  },

  async mcpRemove(scope, _projectPath, homedir, name) {
    if (scope !== 'user') throw new Error('Codex MCP servers are user-level only (~/.codex/config.toml)');
    return removeCodexMcpServer(name, codexConfigFile(homedir));
  },

  classify(relPath) {
    if (relPath === '.codex' || relPath.startsWith('.codex/')) return true;
    // AGENTS.md 是 Codex/agents 指令面，任意深度皆归 Codex。
    return relPath.slice(relPath.lastIndexOf('/') + 1) === 'AGENTS.md';
  },

  ignore(relPath) {
    // 观测集 = `.codex/` 子树 + 根级 AGENTS.md（其余皆不在本面观测集）。
    return !(relPath === '.codex' || relPath.startsWith('.codex/') || relPath === 'AGENTS.md');
  },
};
