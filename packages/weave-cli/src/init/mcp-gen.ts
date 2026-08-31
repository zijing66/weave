import type { PlatformInfo } from '@weave/core';

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
