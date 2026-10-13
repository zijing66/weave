import type { Harness, ToolScope, ToolStateRow } from '@weavecode/core';
import { readMcpServers, type McpServerConfig } from './installer.js';
import { readGlobalMcpServers } from './global-config.js';
import { readCodexMcpServers } from './codex-toml.js';
import {
  readMcpEnableMap,
  mcpOverrideOf,
  resolveMcpEffective,
  type McpEnableMap,
} from './settings-mcp.js';
import { assetSurfaces } from '../surfaces.js';

export type McpToolRow = ToolStateRow<McpServerConfig>;

/**
 * MCP 工具行装配（工具对象模型首个产消方）：三处表示法（项目 `.mcp.json` /
 * `~/.claude.json` / `~/.codex/config.toml`）读出的服务器映射展平成
 * harness × scope 状态行。范围来自 `AssetSurface.mcpScopes`；启停覆写与
 * 生效态由服务端解析（词表桥在 settings-mcp，文件表示法不出 server）。
 * 行行携带 installScopes——web 的视图选择与安装控制不依赖能力表二次拉取。
 */
export async function readMcpRows(projectPath: string): Promise<McpToolRow[]> {
  const [projectServers, userServers, codexServers, enableMap] = await Promise.all([
    readMcpServers(projectPath).catch(() => ({})),
    readGlobalMcpServers().catch(() => ({})),
    readCodexMcpServers().catch(() => ({})),
    readMcpEnableMap(projectPath),
  ]);
  const scopesOf = new Map(
    assetSurfaces().map((s) => [s.harness, s.mcpScopes() as readonly ToolScope[]] as const),
  );
  const rows: McpToolRow[] = [];
  const push = (
    harness: Harness,
    scope: 'project' | 'user',
    servers: Record<string, McpServerConfig>,
    enable: McpEnableMap | null,
  ): void => {
    for (const [name, config] of Object.entries(servers)) {
      rows.push({
        key: name,
        category: 'mcp',
        harness,
        scope,
        installScopes: scopesOf.get(harness) ?? [],
        // 仅 claude 项目档有启停面（.claude/settings.json 覆写）；null = 装了即生效。
        enable: enable ? mcpOverrideOf(enable, name) : null,
        effective: enable ? resolveMcpEffective(enable, name) : true,
        detail: config,
      });
    }
  };
  push('claude', 'project', projectServers, enableMap);
  push('claude', 'user', userServers, null);
  push('codex', 'user', codexServers, null);
  return rows;
}
