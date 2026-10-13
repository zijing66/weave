import path from 'node:path';
import type { AssetSurface } from '../driver.js';
import { FILE_ASSET_SPECS } from '../shared/file-specs.js';

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

  pluginCacheDir: (homedir) => path.join(homedir, '.claude', 'plugins', 'cache'),

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
