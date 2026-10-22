import { homedir } from 'node:os';
import type { ToolScope, ToolStateRow } from '@weavecode/core';
import type { McpServerConfig } from './installer.js';
import {
  readMcpEnableMap,
  mcpOverrideOf,
  resolveMcpEffective,
  type McpEnableMap,
} from './settings-mcp.js';
import { assetSurfaces } from '../surfaces.js';
import { BUILTIN_MCP_SERVERS } from './builtin-mcp.js';
import { readDaemonState } from '../daemon/state.js';

export type McpToolRow = ToolStateRow<McpServerConfig>;

/**
 * MCP 工具行装配（工具对象模型首个产消方）：每个 surface 按自己的 `mcpScopes()`
 * 读出服务器映射、展平成 harness × scope 状态行——表示法（项目 `.mcp.json` /
 * `~/.claude.json` / `~/.codex/config.toml`）只活在各自的 `AssetSurface.mcpRead`
 * 里，本函数不认识任何一种。启停覆写与生效态由服务端解析（词表桥在 settings-mcp）。
 * 行行携带 installScopes——web 的视图选择与安装控制不依赖能力表二次拉取。
 */
export async function readMcpRows(projectPath: string): Promise<McpToolRow[]> {
  const enableMap = await readMcpEnableMap(projectPath);
  const rows: McpToolRow[] = [];
  for (const surface of assetSurfaces()) {
    const scopes = surface.mcpScopes();
    for (const scope of scopes) {
      // 启停面只在 claude 项目档存在（覆写落 `.claude/settings.json`）；null = 装了即生效。
      const enable: McpEnableMap | null =
        surface.harness === 'claude' && scope === 'project' ? enableMap : null;
      const servers = await surface.mcpRead(scope, projectPath, homedir()).catch(() => ({}));
      for (const [name, config] of Object.entries(servers)) {
        rows.push({
          key: name,
          category: 'mcp',
          harness: surface.harness,
          scope,
          installScopes: scopes as readonly ToolScope[],
          enable: enable ? mcpOverrideOf(enable, name) : null,
          effective: enable ? resolveMcpEffective(enable, name) : true,
          detail: config,
        });
      }
    }
  }
  // weave 自带目录（daemon 托管的 HTTP MCP）：未配置时补一行「未安装」。
  // **只允许 user 档**——配置里要带本机令牌，项目档会跟着仓库走。
  // 端点用 daemon 当前端口（令牌不回显，安装时才由服务端填）。
  const port = readDaemonState()?.port;
  for (const surface of assetSurfaces()) {
    for (const builtin of BUILTIN_MCP_SERVERS) {
      if (surface.harness !== 'claude') continue;
      if (rows.some((r) => r.harness === 'claude' && r.key === builtin.name)) continue;
      rows.push({
        key: builtin.name,
        category: 'mcp',
        harness: 'claude',
        scope: 'user',
        installScopes: ['user'],
        install: 'absent',
        enable: null,
        effective: false,
        detail: { url: `http://127.0.0.1:${port ?? 6420}${builtin.path}` },
        builtin: true,
      });
    }
  }
  return rows;
}
