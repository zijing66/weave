import type { PlatformInfo } from '@weavecode/core';

export interface McpGeneratorInput {
  platform: PlatformInfo;
  /** Whether to include the weave MCP server entry */
  includeWeaveServer: boolean;
}

export function generateMcpJson(input: McpGeneratorInput): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};

  if (input.includeWeaveServer) {
    const command = input.platform.os === 'windows' ? 'cmd' : 'npx';
    const args = input.platform.os === 'windows'
      ? ['/c', 'npx', 'weave', 'mcp', 'start']
      : ['weave', 'mcp', 'start'];

    mcpServers['weave'] = {
      command,
      args,
      env: { WEAVE_MCP: 'true' },
    };
  }

  return { mcpServers };
}

/**
 * Merge weave's generated servers into an existing user .mcp.json.
 *
 * Policy (weave init never overwrites user files):
 * - user-authored server entries and unknown top-level keys are preserved
 * - missing weave entries are appended
 * - the `weave` server entry is weave's own config key: when present it is
 *   refreshed to the current generated value
 */
export function mergeMcpJson(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };

  const generatedServers = isPlainObject(generated['mcpServers']) ? generated['mcpServers'] : {};
  const servers = isPlainObject(merged['mcpServers']) ? { ...merged['mcpServers'] } : {};

  for (const [name, config] of Object.entries(generatedServers)) {
    if (name === 'weave' || servers[name] === undefined) {
      servers[name] = config;
    }
  }
  merged['mcpServers'] = servers;
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * uninstall 用的剥除：删 `weave` 服务键（weave 自己的配置键）；mcpServers 清空
 * 删键；顶层清空返回空对象，调用方据此删文件。用户自己的服务键不动。
 */
export function stripWeaveMcp(existing: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  if (isPlainObject(out['mcpServers'])) {
    const servers: Record<string, unknown> = { ...(out['mcpServers'] as Record<string, unknown>) };
    delete servers['weave'];
    if (Object.keys(servers).length > 0) out['mcpServers'] = servers;
    else delete out['mcpServers'];
  }
  return out;
}
